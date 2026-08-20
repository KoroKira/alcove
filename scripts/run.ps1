# run.ps1 — Lance Alcove nativement (sans Docker pour l'app) sur Windows
# Postgres + Redis tournent dans des conteneurs Docker legers (voir docker-compose.local.yml)
# Equivalent Windows de run.sh (mode local macOS/Homebrew)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$Backend = Join-Path $Root "src\backend"
$Frontend = Join-Path $Root "src\frontend"

function Info($msg)    { Write-Host "> $msg" -ForegroundColor Cyan }
function Success($msg) { Write-Host "OK $msg" -ForegroundColor Green }
function WarnMsg($msg) { Write-Host "!! $msg" -ForegroundColor Yellow }
function Die($msg)     { Write-Host "XX $msg" -ForegroundColor Red; exit 1 }

# -- Docker : Postgres + Redis --------------------------------------------------
Get-Command docker -ErrorAction SilentlyContinue | Out-Null
if (-not $?) { Die "Docker non trouve - installe Docker Desktop: https://www.docker.com/products/docker-desktop/" }

$ComposeFile = Join-Path $ScriptDir "docker-compose.local.yml"
Info "Demarrage de PostgreSQL et Redis (conteneurs Docker)..."
docker compose -f $ComposeFile up -d
if (-not $?) { Die "Echec du demarrage des conteneurs Postgres/Redis" }

Write-Host -NoNewline "  Attente de PostgreSQL"
$pgReady = $false
for ($i = 0; $i -lt 30; $i++) {
    docker exec alcove-local-postgres pg_isready -U postgres 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $pgReady = $true; break }
    Write-Host -NoNewline "."
    Start-Sleep -Seconds 1
}
Write-Host ""
if (-not $pgReady) { Die "PostgreSQL n'a pas demarre a temps. Logs: docker logs alcove-local-postgres" }
Success "PostgreSQL + Redis prets"

# -- .env.local ------------------------------------------------------------------
$EnvFile = Join-Path $Root ".env.local"
if (-not (Test-Path $EnvFile)) {
    $content = Get-Content (Join-Path $Root ".env.local.template") -Raw
    # Windows resolves "localhost" to ::1 first; Docker Desktop's port-forwarding
    # hangs/errors on blocking Redis reads (XREAD/BLPOP) over that IPv6 path.
    # 127.0.0.1 works reliably, so use it instead for Postgres/Redis hosts.
    $content = $content -replace 'POSTGRES_HOST=localhost', 'POSTGRES_HOST=127.0.0.1'
    $content = $content -replace 'REDIS_HOST=localhost', 'REDIS_HOST=127.0.0.1'
    $content = $content -replace 'POSTGRES_USER=__YOUR_MAC_USER__', 'POSTGRES_USER=postgres'
    Set-Content -Path $EnvFile -Value $content -NoNewline
    WarnMsg "Cree .env.local depuis le template (adapte pour Windows/Docker)"
} else {
    WarnMsg ".env.local deja present"
}

$EnvVars = @{}
Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    if ($_ -match '^([^=]+)=(.*)$') {
        $key = $matches[1].Trim()
        $val = $matches[2].Trim()
        $EnvVars[$key] = $val
        [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
    }
}

$PostgresDb = if ($EnvVars["POSTGRES_DB"]) { $EnvVars["POSTGRES_DB"] } else { "pad" }

# -- Base de donnees ---------------------------------------------------------------
$dbList = docker exec alcove-local-postgres psql -U postgres -lqt 2>$null
$dbExists = @($dbList | Where-Object { $_ -match [regex]::Escape($PostgresDb) }).Count -gt 0
if (-not $dbExists) {
    Info "Creation de la base de donnees '$PostgresDb'..."
    docker exec alcove-local-postgres createdb -U postgres $PostgresDb 2>$null | Out-Null
    Success "Base de donnees creee"
} else {
    WarnMsg "Base de donnees '$PostgresDb' deja existante"
}

# -- Virtualenv Python -------------------------------------------------------------
$PyVersionArg = $null
foreach ($v in @("3.11", "3.12", "3.13")) {
    & py "-$v" --version 2>$null 1>$null
    if ($LASTEXITCODE -eq 0) { $PyVersionArg = "-$v"; break }
}
if (-not $PyVersionArg) { Die "Python 3.11/3.12/3.13 non trouve. Installe-le: winget install Python.Python.3.12" }
Info "Python utilise : py $PyVersionArg"

$Venv = Join-Path $Root ".venv"
$VenvPython = Join-Path $Venv "Scripts\python.exe"
if (-not (Test-Path $Venv)) {
    Info "Creation du virtualenv Python..."
    & py $PyVersionArg -m venv $Venv
}

$fastapiInstalled = & $VenvPython -c "import fastapi" 2>$null
if ($LASTEXITCODE -ne 0) {
    Info "Installation des dependances Python..."
    & $VenvPython -m pip install -r (Join-Path $Backend "requirements.txt") -q
}
Success "Python OK (venv)"

# -- Alembic : appliquer les migrations en attente, ou stamper une install fraiche --
# Base neuve (pas encore de table `pads`) : le backend la cree via create_all au
# demarrage avec le schema courant, donc un stamp direct est sans danger.
# Base existante non versionnee (install pre-Alembic) : il faut REJOUER les
# migrations pour combler les colonnes ajoutees depuis (tags, folder, thumbnail_url, ...) --
# un simple stamp les sauterait silencieusement.
$AlembicIni = Join-Path $Backend "alembic.ini"
if (Test-Path $AlembicIni) {
    Push-Location $Backend
    $current = & $VenvPython -m alembic current 2>$null
    if (-not ($current -match "head")) {
        $padsExists = docker exec alcove-local-postgres psql -U postgres -d $PostgresDb -tAc `
            "SELECT 1 FROM information_schema.tables WHERE table_schema='pad_ws' AND table_name='pads'" 2>$null
        if ($padsExists -match "1") {
            Info "Alembic : base existante non versionnee - application des migrations..."
            & $VenvPython -m alembic upgrade head 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) {
                WarnMsg "Alembic upgrade a echoue (schema probablement deja a jour) - stamp de secours..."
                & $VenvPython -m alembic stamp head 2>$null | Out-Null
            }
        } else {
            Info "Alembic : synchronisation de l'etat du schema (install fraiche)..."
            & $VenvPython -m alembic stamp head 2>$null | Out-Null
        }
    }
    Pop-Location
}

# -- Dependances Node --------------------------------------------------------------
if (-not (Test-Path (Join-Path $Frontend "node_modules"))) {
    Info "Installation des dependances Node.js..."
    Push-Location $Frontend
    yarn install --frozen-lockfile
    Pop-Location
}
Success "Node OK"

# -- ttyd (terminal local) - pas d'installeur Windows fiable, on desactive --------
Get-Command ttyd -ErrorAction SilentlyContinue | Out-Null
if ($?) {
    WarnMsg "ttyd detecte mais non demarre automatiquement par ce script"
} else {
    WarnMsg "ttyd non disponible sous Windows - le pad 'Terminal' ne fonctionnera pas"
}

# -- Ollama (IA locale) -------------------------------------------------------------
$OllamaJob = $null
Get-Command ollama -ErrorAction SilentlyContinue | Out-Null
if ($?) {
    $ollamaRunning = Get-Process ollama -ErrorAction SilentlyContinue
    if ($ollamaRunning) {
        WarnMsg "Ollama deja en cours"
    } else {
        Info "Demarrage d'Ollama..."
        $OllamaJob = Start-Job -ScriptBlock { ollama serve }
        Start-Sleep -Seconds 2
        Success "Ollama demarre"
    }
} else {
    WarnMsg "Ollama non installe - fonctionnalites IA desactivees. Installer: winget install Ollama.Ollama"
}

# -- Vite dev server (arriere-plan) -------------------------------------------------
Info "Demarrage du serveur Vite (frontend)..."
$ViteJob = Start-Job -ScriptBlock {
    param($FrontendDir)
    Set-Location $FrontendDir
    yarn start
} -ArgumentList $Frontend

Write-Host -NoNewline "  Attente de Vite"
$viteReady = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:3003/" -UseBasicParsing -TimeoutSec 1
        if ($resp.StatusCode -eq 200) { $viteReady = $true; break }
    } catch {}
    Write-Host -NoNewline "."
    Start-Sleep -Seconds 1
}
Write-Host ""
if (-not $viteReady) {
    Receive-Job $ViteJob
    Die "Vite n'a pas demarre. Voir les logs ci-dessus."
}
Success "Vite pret sur port 3003"

# -- Cleanup -------------------------------------------------------------------------
$cleanup = {
    Info "Arret..."
    if ($ViteJob) { Stop-Job $ViteJob -ErrorAction SilentlyContinue; Remove-Job $ViteJob -Force -ErrorAction SilentlyContinue }
    if ($OllamaJob) { Stop-Job $OllamaJob -ErrorAction SilentlyContinue; Remove-Job $OllamaJob -Force -ErrorAction SilentlyContinue }
    WarnMsg "Conteneurs Docker (Postgres/Redis) toujours actifs. Pour les arreter:"
    Write-Host "  docker compose -f scripts/docker-compose.local.yml stop"
}

try {
    Write-Host ""
    Write-Host "================================================" -ForegroundColor Green
    Write-Host "  Alcove -> http://localhost:8000" -ForegroundColor Green
    Write-Host "================================================" -ForegroundColor Green
    Write-Host ""

    Push-Location $Backend
    & $VenvPython -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload --env-file $EnvFile
} finally {
    Pop-Location -ErrorAction SilentlyContinue
    & $cleanup
}
