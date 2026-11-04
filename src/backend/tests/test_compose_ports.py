"""Static guard: data stores in the Compose files must not be published on every interface.

PostgreSQL, Redis and Ollama carry user data and (for the local stack) accept
unauthenticated connections. A bare ``"5432:5432"`` mapping publishes the port
on all host interfaces, bypassing host firewalls on Docker Desktop and on
Linux hosts that use ufw. The check is a small indentation-based reader so it
needs no YAML dependency.
"""
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
COMPOSE_FILES = sorted(
    list(REPO_ROOT.glob("docker-compose*.yml")) + list((REPO_ROOT / "scripts").glob("docker-compose*.yml"))
)
DATA_SERVICES = {"postgres", "redis", "ollama", "keycloak-postgres"}
LOOPBACK_PREFIXES = ("127.0.0.1:", "[::1]:", "localhost:")


def published_ports(text: str) -> list[tuple[str, str]]:
    """Return (service, port mapping) pairs for every ``ports:`` list entry."""
    results: list[tuple[str, str]] = []
    in_services = False
    service = None
    ports_indent = None
    for raw in text.splitlines():
        line = raw.split(" #", 1)[0].rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        stripped = line.strip()
        if indent == 0:
            in_services = stripped == "services:"
            service = None
            ports_indent = None
            continue
        if not in_services:
            continue
        if indent == 2 and stripped.endswith(":"):
            service = stripped[:-1]
            ports_indent = None
            continue
        if ports_indent is not None and indent > ports_indent and stripped.startswith("- "):
            results.append((service, stripped[2:].strip().strip("\"'")))
            continue
        ports_indent = indent if stripped == "ports:" else None
    return results


def test_compose_files_are_discovered():
    names = {path.name for path in COMPOSE_FILES}
    assert {"docker-compose.yml", "docker-compose.local.yml"} <= names


def test_port_reader_handles_expected_shapes():
    sample = (
        "services:\n"
        "  postgres:\n"
        "    ports:\n"
        "      # comment\n"
        '      - "5432:5432"\n'
        "  pad:\n"
        "    ports:\n"
        '      - "127.0.0.1:${APP_PORT:-8000}:8000"\n'
        "    restart: always\n"
    )
    assert published_ports(sample) == [
        ("postgres", "5432:5432"),
        ("pad", "127.0.0.1:${APP_PORT:-8000}:8000"),
    ]


@pytest.mark.parametrize("path", COMPOSE_FILES, ids=lambda p: p.name)
def test_data_services_are_published_on_loopback_only(path: Path):
    offenders = [
        f"{service}: {mapping}"
        for service, mapping in published_ports(path.read_text(encoding="utf-8"))
        if service in DATA_SERVICES and not mapping.startswith(LOOPBACK_PREFIXES)
    ]
    assert not offenders, f"{path.name} publishes data stores on all interfaces: {offenders}"
