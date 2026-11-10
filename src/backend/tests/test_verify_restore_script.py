"""verify-restore.sh must fail closed before it ever touches a database."""
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "verify-restore.sh"
pytestmark = pytest.mark.skipif(shutil.which("sh") is None or shutil.which("sha256sum") is None, reason="needs sh + sha256sum")


def run(*args):
    return subprocess.run(["sh", str(SCRIPT), *args], capture_output=True, text=True, timeout=30)


def test_requires_exactly_one_argument():
    result = run()
    assert result.returncode == 2 and "Usage" in result.stderr


def test_missing_target_is_rejected():
    result = run("/nonexistent/backup")
    assert result.returncode == 1 and "not found" in result.stderr


def test_directory_without_checksums_is_rejected(tmp_path):
    (tmp_path / "alcove.dump").write_bytes(b"x")
    result = run(str(tmp_path))
    assert result.returncode == 1 and "SHA256SUMS missing" in result.stderr


def test_tampered_backup_is_rejected_before_any_restore(tmp_path):
    dump = tmp_path / "alcove.dump"
    dump.write_bytes(b"original")
    subprocess.run("sha256sum alcove.dump > SHA256SUMS", shell=True, cwd=tmp_path, check=True)
    dump.write_bytes(b"tampered")
    result = run(str(tmp_path))
    assert result.returncode == 1 and "checksum mismatch" in result.stderr


def test_scratch_container_has_no_network_and_cleanup_precedes_start():
    text = SCRIPT.read_text(encoding="utf-8")
    trap = text.index("trap cleanup EXIT INT TERM")
    start = text.index("docker run -d --rm --network none")
    assert trap < start
    assert "--network none" in text[start:text.index("\n", start)]
