"""Exercise deployment orchestration without Docker or production services."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def deployment(tmp_path):
    if not shutil.which("bash") or not shutil.which("jq"):
        pytest.skip("Deployment scripts require bash and jq")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls.jsonl"
    fake = bin_dir / "fake"
    fake.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
body = sys.stdin.read() if "--data-binary" in args else ""
with open(os.environ["MOCK_LOG"], "a") as log:
    log.write(json.dumps({"name": name, "args": args, "body": body}) + "\\n")
if name == "docker":
    if "pg_dump" in args:
        if os.environ.get("MOCK_DUMP_FAIL") == "1": sys.exit(9)
        print("mock custom dump")
    elif "ps" in args: print("mock-pad-container")
    elif "inspect" in args:
        print("ghcr.io/korokira/alcove:sha-0123456789abcdef" if ".Config.Image" in " ".join(args) else "sha256:mock")
    sys.exit(0)
url = next(arg for arg in args if arg.startswith("http"))
if "/.well-known/" in url: print("{}")
elif url.endswith("/token"): print('{"access_token":"mock-admin-token"}')
elif url.endswith("/admin/realms/alcove") and "-w" in args: print("200" if os.environ.get("MOCK_REALM_EXISTS") else "404", end="")
elif "/clients?" in url:
    marker = pathlib.Path(os.environ["MOCK_LOG"] + ".client")
    print('[{"id":"client-uuid"}]' if marker.exists() else "[]")
elif url.endswith("/clients"):
    pathlib.Path(os.environ["MOCK_LOG"] + ".client").touch()
elif url.endswith("/models") and not body: print("[]")
elif url.endswith("/client-secret"): print('{"value":"mock-client-secret-0123456789"}')
''')
    fake.chmod(0o755)
    for name in ("docker", "curl"):
        (bin_dir / name).symlink_to(fake)
    data = tmp_path / "data"
    (data / "pads").mkdir(parents=True)
    (data / "pads" / "example.excalidraw").write_text('{"test":true}')
    env_file = tmp_path / ".env"
    # Reserved URL characters exercise form encoding; all credentials are synthetic.
    secret = "synthetic long password &+=!123"
    env_file.write_text("\n".join([
        "COMPOSE_PROJECT_NAME=custom-alcove",
        "ALCOVE_IMAGE=ghcr.io/korokira/alcove:sha-0123456789abcdef",
        "FRONTEND_URL=https://alcove.example.test",
        "OIDC_SERVER_URL=https://auth.example.test",
        "KEYCLOAK_ADMIN=operator",
        f"POSTGRES_PASSWORD='{secret}'",
        f"REDIS_PASSWORD='{secret}'",
        f"KEYCLOAK_DB_PASSWORD='{secret}'",
        f"KEYCLOAK_ADMIN_PASSWORD='{secret}'",
        "OIDC_CLIENT_SECRET=CHANGE_ME_AFTER_CLIENT_CREATION",
        f"DATA_DIR='{data}'",
        f"BACKUP_DIR='{tmp_path / 'backups'}'",
        "",
    ]))
    environment = {
        **os.environ,
        "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
        "MOCK_LOG": str(log),
        "ALCOVE_ENV_FILE": str(env_file),
        "ALCOVE_COMPOSE_FILE": str(ROOT / "docker-compose.codicam.yml"),
        "ALCOVE_PROJECT_DIR": str(tmp_path),
    }
    return tmp_path, env_file, log, environment, secret


def run_script(script, deployment, **extra):
    _, _, _, environment, _ = deployment
    return subprocess.run(
        ["bash", str(ROOT / "scripts" / script)],
        env={**environment, **extra}, capture_output=True, text=True, check=False,
    )


def calls(deployment):
    return [json.loads(line) for line in deployment[2].read_text().splitlines()]


def test_setup_creates_exact_client_and_keeps_credentials_out_of_output(deployment):
    result = run_script("setup.sh", deployment)
    assert result.returncode == 0, result.stderr
    _, env_file, _, _, password = deployment
    output = result.stdout + result.stderr
    assert password not in output
    assert "mock-client-secret" not in output
    assert "mock-admin-token" not in output
    assert "master" in output
    assert env_file.stat().st_mode & 0o777 == 0o600
    assert "OIDC_CLIENT_SECRET='mock-client-secret-0123456789'" in env_file.read_text()
    client_calls = [call for call in calls(deployment) if call["body"] and '"clientId"' in call["body"]]
    assert len(client_calls) == 1
    client = json.loads(client_calls[0]["body"])
    assert client["redirectUris"] == ["https://alcove.example.test/api/auth/callback"]
    assert client["webOrigins"] == ["https://alcove.example.test"]
    assert client["directAccessGrantsEnabled"] is False
    token_call = next(call for call in calls(deployment) if any(arg.endswith("/token") for arg in call["args"]))
    assert f"password={password}" in token_call["args"]
    assert "--data-urlencode" in token_call["args"]
    assert all("custom-alcove" in call["args"] for call in calls(deployment) if call["name"] == "docker" and call["args"] != ["compose", "version"])


def test_setup_rejects_placeholder_before_mutating_services(deployment):
    _, env_file, log, _, _ = deployment
    env_file.write_text(env_file.read_text().replace("POSTGRES_PASSWORD='synthetic long password &+=!123'", "POSTGRES_PASSWORD=CHANGE_ME"))
    result = run_script("setup.sh", deployment)
    assert result.returncode != 0
    assert "POSTGRES_PASSWORD" in result.stderr
    assert all(call["args"] == ["compose", "version"] for call in calls(deployment))


def test_backup_works_without_git_and_preserves_older_backups(deployment):
    path, env_file, _, _, _ = deployment
    older = path / "backups" / "2020-01-01T000000Z"
    older.mkdir(parents=True)
    os.utime(older, (0, 0))
    result = run_script("backup-codicam.sh", deployment)
    assert result.returncode == 0, result.stderr
    completed = [entry for entry in older.parent.iterdir() if entry != older]
    assert len(completed) == 1
    backup = completed[0]
    assert (backup / "environment.env").read_bytes() == env_file.read_bytes()
    assert (backup / "environment.env").stat().st_mode & 0o777 == 0o600
    assert backup.stat().st_mode & 0o777 == 0o700
    assert (backup / "compose-project.txt").read_text().strip() == "custom-alcove"
    assert (backup / "runtime-image.txt").read_text().startswith("ghcr.io/")
    assert older.exists()
    checksum = subprocess.run(["shasum", "-a", "256", "-c", "SHA256SUMS"], cwd=backup, capture_output=True, text=True)
    assert checksum.returncode == 0, checksum.stderr
    assert all("custom-alcove" in call["args"] for call in calls(deployment) if "compose" in call["args"])


def test_failed_backup_never_publishes_an_incomplete_snapshot(deployment):
    result = run_script("backup-codicam.sh", deployment, MOCK_DUMP_FAIL="1")
    assert result.returncode != 0
    backup_root = deployment[0] / "backups"
    assert list(backup_root.iterdir()) == []
