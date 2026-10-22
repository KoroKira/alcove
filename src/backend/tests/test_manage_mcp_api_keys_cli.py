"""Tests for scripts/manage_mcp_api_keys.py — the admin CLI used to create,
list, revoke and rotate MCP API keys. Loaded by file path since it's a
standalone script, not a package under src/backend. No real DB : async_session
and the service functions are monkeypatched, same boundary as
test_mcp_router_auth.py. `--help` is exercised for real via subprocess (fast,
no DB needed) — everything create/list/revoke/rotate does against a real
Postgres is covered manually against a disposable container and in
test_mcp_api_key_integration.py.
"""
import asyncio
import contextlib
import importlib.util
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

_SCRIPT_PATH = Path(__file__).resolve().parents[3] / "scripts" / "manage_mcp_api_keys.py"


def _load_cli_module():
    spec = importlib.util.spec_from_file_location("manage_mcp_api_keys_cli", _SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = _load_cli_module()


def _run(coro):
    return asyncio.run(coro)


def _fake_async_session_factory(session):
    @contextlib.asynccontextmanager
    async def _factory():
        yield session
    return _factory


def _session_with_scalars(rows):
    session = MagicMock()
    result = MagicMock()
    result.scalars.return_value.all.return_value = rows
    session.execute = AsyncMock(return_value=result)
    session.commit = AsyncMock()
    return session


# ── --help : real subprocess, no mocks ──────────────────────────────────────

def test_help_runs_and_lists_all_subcommands():
    out = subprocess.run(
        [sys.executable, str(_SCRIPT_PATH), "--help"],
        capture_output=True, text=True, timeout=15,
    )
    assert out.returncode == 0
    for sub in ("create", "list", "revoke", "rotate"):
        assert sub in out.stdout


# ── _resolve_owner_id : not found / ambiguous / exactly one ─────────────────

def test_resolve_owner_id_raises_for_unknown_email():
    session = _session_with_scalars([])
    with pytest.raises(SystemExit, match="No user with email"):
        _run(cli._resolve_owner_id(session, "nobody@example.invalid"))


def test_resolve_owner_id_raises_for_ambiguous_email():
    session = _session_with_scalars([uuid4(), uuid4()])
    with pytest.raises(SystemExit, match="ambiguous"):
        _run(cli._resolve_owner_id(session, "shared@example.invalid"))


def test_resolve_owner_id_returns_the_single_match():
    owner = uuid4()
    session = _session_with_scalars([owner])
    assert _run(cli._resolve_owner_id(session, "owner@example.invalid")) == owner


# ── create / rotate : one-time-display warning, never leak secret_hash ─────

def test_create_writes_private_token_and_never_prints_secret(monkeypatch, capsys, tmp_path):
    owner = uuid4()
    row = SimpleNamespace(public_id="abc123", secret_hash="deadbeef" * 8)
    monkeypatch.setattr(cli, "async_session", _fake_async_session_factory(MagicMock()))
    monkeypatch.setattr(cli, "_resolve_owner_id", AsyncMock(return_value=owner))
    monkeypatch.setattr(cli, "create_api_key", AsyncMock(return_value=("amk_abc123_secret", row)))

    token_file = tmp_path / "fresh.token"
    _run(cli.cmd_create(SimpleNamespace(email="x@example.invalid", name="hub-bot", expires_days=None,
                                       scope=None, token_file=str(token_file))))

    output = capsys.readouterr().out
    assert "amk_abc123_secret" not in output
    assert row.secret_hash not in output
    assert token_file.read_text().strip() == "amk_abc123_secret"
    assert token_file.stat().st_mode & 0o777 == 0o600
    assert cli.create_api_key.await_args.kwargs["scopes"] == ["read"]


def test_rotate_keeps_token_out_of_stdout_and_hash_out_of_file(monkeypatch, capsys, tmp_path):
    new_row = SimpleNamespace(public_id="new123", secret_hash="deadbeef" * 8)
    monkeypatch.setattr(cli, "async_session", _fake_async_session_factory(MagicMock()))
    monkeypatch.setattr(cli, "rotate_api_key", AsyncMock(return_value=("amk_new123_secret", new_row)))

    token_file = tmp_path / "rotated.token"
    _run(cli.cmd_rotate(SimpleNamespace(public_id="old123", token_file=str(token_file))))

    output = capsys.readouterr().out
    assert "revoked" in output.lower()
    assert "amk_new123_secret" not in output
    assert new_row.secret_hash not in output
    assert token_file.read_text().strip() == "amk_new123_secret"
    assert new_row.secret_hash not in token_file.read_text()


def test_rotate_reports_not_found_and_removes_empty_token_file(monkeypatch, tmp_path):
    monkeypatch.setattr(cli, "async_session", _fake_async_session_factory(MagicMock()))
    monkeypatch.setattr(cli, "rotate_api_key", AsyncMock(return_value=None))

    token_file = tmp_path / "absent.token"
    with pytest.raises(SystemExit, match="not found or already revoked"):
        _run(cli.cmd_rotate(SimpleNamespace(public_id="unknown", token_file=str(token_file))))
    assert not token_file.exists()


def test_existing_token_file_or_symlink_is_never_overwritten_or_minted(monkeypatch, tmp_path):
    mint = AsyncMock()
    monkeypatch.setattr(cli, "create_api_key", mint)
    existing = tmp_path / "existing.token"
    existing.write_text("Preserve existing credential")
    link = tmp_path / "linked.token"
    link.symlink_to(existing)
    for path in (existing, link):
        with pytest.raises(SystemExit, match="never overwritten"):
            _run(cli.cmd_create(SimpleNamespace(token_file=str(path))))
    assert existing.read_text() == "Preserve existing credential"
    mint.assert_not_called()


# ── list : never shows secret_hash, even incidentally ───────────────────────

def test_list_output_never_contains_secret_hash(monkeypatch, capsys):
    owner = uuid4()
    rows = [
        SimpleNamespace(
            public_id="p1", secret_hash="SENSITIVE_HASH_VALUE", name="hub-bot",
            revoked_at=None, created_at="2026-01-01", expires_at=None, last_used_at=None, scopes=["read"],
        ),
        SimpleNamespace(
            public_id="p2", secret_hash="OTHER_SENSITIVE_HASH", name="hub-bot-old",
            revoked_at="2026-02-01", created_at="2026-01-01", expires_at=None, last_used_at=None, scopes=["read", "write"],
        ),
    ]
    session = MagicMock()
    result = MagicMock()
    result.scalars.return_value.all.return_value = rows
    session.execute = AsyncMock(return_value=result)
    monkeypatch.setattr(cli, "async_session", _fake_async_session_factory(session))
    monkeypatch.setattr(cli, "_resolve_owner_id", AsyncMock(return_value=owner))

    _run(cli.cmd_list(SimpleNamespace(email="x@example.invalid")))

    output = capsys.readouterr().out
    assert "SENSITIVE_HASH_VALUE" not in output
    assert "OTHER_SENSITIVE_HASH" not in output
    assert "p1" in output and "p2" in output
