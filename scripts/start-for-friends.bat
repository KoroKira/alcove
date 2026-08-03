@echo off
setlocal

echo ============================================
echo   Alcove - demarrage (mode partage/amis)
echo ============================================
echo.

where docker >nul 2>nul
if errorlevel 1 (
    echo Docker n'est pas installe ou pas dans le PATH.
    echo Installe Docker Desktop : https://www.docker.com/products/docker-desktop/
    echo puis relance ce script.
    pause
    exit /b 1
)

cd /d "%~dp0.."

echo Demarrage des conteneurs (build de l'image la 1ere fois, prevoir 3-5 min)...
docker compose -f docker-compose.friends.yml up -d --build
if errorlevel 1 (
    echo.
    echo Echec du demarrage. Voir les logs : docker compose -f docker-compose.friends.yml logs
    pause
    exit /b 1
)

echo.
echo Attente que l'app reponde sur http://localhost:8000 ...
set count=0
:waitloop
curl -s -o nul -w "" http://localhost:8000/ >nul 2>nul
if not errorlevel 1 goto ready
set /a count+=1
if %count% GEQ 60 goto timeout
timeout /t 2 >nul
goto waitloop

:ready
echo.
echo ============================================
echo   Alcove est pret : http://localhost:8000
echo ============================================
start http://localhost:8000
goto end

:timeout
echo.
echo L'app met plus de temps que prevu (le modele IA telecharge ~2 Go en tache de fond).
echo Ouvre http://localhost:8000 dans quelques minutes, ou verifie :
echo   docker compose -f docker-compose.friends.yml logs -f pad

:end
echo.
echo Pour arreter : docker compose -f docker-compose.friends.yml stop
pause
