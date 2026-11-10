"""Alcove must never install or start the local ttyd shell, and the template must not enable it."""
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]


def _code_lines(path: str) -> list[str]:
    lines = (REPO_ROOT / path).read_text(encoding="utf-8").splitlines()
    return [line for line in lines if not line.strip().startswith("#")]


@pytest.mark.parametrize("script", ["scripts/run.sh", "scripts/run.ps1", "scripts/start.sh", "scripts/setup.sh"])
def test_scripts_never_install_or_launch_ttyd(script):
    if not (REPO_ROOT / script).exists():
        pytest.skip(f"{script} not present")
    offenders = [
        line for line in _code_lines(script)
        if "ttyd" in line.lower()
        and ("brew install" in line or line.strip().startswith(("ttyd ", "ttyd\t")) or "Start-Process" in line)
    ]
    assert not offenders, offenders


def test_local_env_template_does_not_enable_the_terminal():
    active = [line for line in _code_lines(".env.local.template") if line.strip().startswith("TTYD_URL=")]
    # An empty value keeps it disabled; a URL would enable the embedded shell.
    assert all(line.split("=", 1)[1].strip() == "" for line in active), active
