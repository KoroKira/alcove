"""Dev mode answers only to expected Host values; WebSocket origin and LaTeX file access are fenced."""
import asyncio
import json
import os
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient

from services.host_guard import DevHostGuard, build_allowed_hosts, host_allowed, normalize_host

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.mark.parametrize("raw,expected", [
    ("localhost:8000", "localhost"), ("LOCALHOST", "localhost"), ("127.0.0.1:3003", "127.0.0.1"),
    ("[::1]:8000", "::1"), ("::1", "::1"), ("https://alcove.example.org/x", "alcove.example.org"),
    ("alcove.example.org:8443", "alcove.example.org"), ("", ""), (None, ""),
])
def test_normalize_host(raw, expected):
    assert normalize_host(raw) == expected


def test_allowlist_contains_loopback_and_configured_hosts():
    allowed = build_allowed_hosts(["https://alcove.tailnet.ts.net", None, "http://localhost:3003"], "a.example, b.example:9000")
    for h in ("localhost", "127.0.0.1", "::1", "alcove.tailnet.ts.net", "a.example", "b.example"):
        assert host_allowed(h, allowed)
    for h in ("evil.example", "localhost.evil.example", "alcove.tailnet.ts.net.evil.example", "", None, "10.0.0.5"):
        assert not host_allowed(h, allowed), h
    assert host_allowed("127.0.0.2:8000", allowed)          # whole loopback range


def _client():
    app = FastAPI()

    @app.get("/")
    async def root():
        return {"ok": True}

    app.add_middleware(DevHostGuard, allowed=build_allowed_hosts(["https://alcove.example.org"]))
    return TestClient(app)


@pytest.mark.parametrize("host,status", [
    ("localhost:8000", 200), ("127.0.0.1:8000", 200), ("[::1]:8000", 200), ("alcove.example.org", 200),
    ("attacker.example:8000", 400), ("attacker.example", 400), ("localhost.attacker.example", 400),
])
def test_http_requests_with_unexpected_host_are_refused(host, status):
    assert _client().get("/", headers={"Host": host}).status_code == status


def test_websocket_with_unexpected_host_is_closed():
    app = FastAPI()

    @app.websocket("/ws")
    async def ws(websocket: WebSocket):
        await websocket.accept()
        await websocket.send_text("hi")

    app.add_middleware(DevHostGuard, allowed=build_allowed_hosts([]))
    client = TestClient(app)
    with client.websocket_connect("/ws", headers={"Host": "localhost:8000"}) as ok:
        assert ok.receive_text() == "hi"
    with pytest.raises(Exception):
        with client.websocket_connect("/ws", headers={"Host": "attacker.example"}):
            pass


def _run_main(env_extra, code):
    env = {**os.environ, "PYTHONPATH": BACKEND, **env_extra}
    return subprocess.run([sys.executable, "-c", code], cwd=BACKEND, env=env, capture_output=True, text=True, timeout=60)


_PROBE = """
from fastapi.testclient import TestClient
import main
c = TestClient(main.app)
print(c.get('/api/app/config', headers={'Host': 'localhost:8000'}).status_code,
      c.get('/api/app/config', headers={'Host': 'attacker.example'}).status_code,
      c.get('/api/app/config', headers={'Host': 'alcove.example.org'}).status_code)
"""


def test_main_applies_the_guard_only_in_dev_mode():
    dev = _run_main({"PAD_DEV_MODE": "true", "FRONTEND_URL": "https://alcove.example.org"}, _PROBE)
    assert dev.stdout.split()[-3:] == ["200", "400", "200"], dev.stderr[-500:]
    prod = _run_main({"PAD_DEV_MODE": "false", "FRONTEND_URL": "https://alcove.example.org"}, _PROBE)
    assert prod.stdout.split()[-3:] == ["200", "200", "200"], prod.stderr[-500:]


# ── WebSocket origin ─────────────────────────────────────────────────────────

def _ws(origin):
    headers = {} if origin is None else {"origin": origin}
    ws = MagicMock()
    ws.headers = headers
    ws.close = AsyncMock()
    return ws


@pytest.mark.parametrize("dev,origin,rejected", [
    (True, "https://attacker.example", True),     # was accepted in dev mode
    (True, "http://localhost:8000", False),
    (True, None, False),                          # non-browser client
    (False, "https://attacker.example", True),
    (False, None, True),
])
def test_websocket_origin_policy(monkeypatch, dev, origin, rejected):
    from routers import ws_router
    monkeypatch.setattr(ws_router, "PAD_DEV_MODE", dev)
    monkeypatch.setattr(ws_router, "ALLOWED_ORIGINS", ["http://localhost:8000"])
    ws = _ws(origin)
    # Authenticated principal; if the origin is accepted the handler goes on to
    # open a DB session, which we cut short.
    monkeypatch.setattr(ws_router, "async_session", MagicMock(side_effect=RuntimeError("stop after origin check")))
    asyncio.run(ws_router.websocket_endpoint(ws, __import__("uuid").uuid4(), SimpleNamespace(id=1, username="u")))
    closed_for_origin = any(c.kwargs.get("reason") == "Origin not allowed" for c in ws.close.await_args_list)
    assert closed_for_origin is rejected


# ── LaTeX: TeX may not read arbitrary files ─────────────────────────────────

def test_latex_runs_with_paranoid_file_access(monkeypatch):
    from routers import latex_router
    seen = {}

    def fake_run(cmd, **kwargs):
        seen["env"] = kwargs["env"]
        seen["cmd"] = cmd
        return SimpleNamespace(stdout="", stderr="", returncode=1)

    monkeypatch.setattr(latex_router.subprocess, "run", fake_run)
    asyncio.run(latex_router.compile_latex(latex_router.LatexCompileRequest(source="\\input{/etc/passwd}"), object()))
    assert seen["env"]["openin_any"] == "p" and seen["env"]["openout_any"] == "p" and seen["env"]["shell_escape"] == "f"
    assert "-no-shell-escape" in seen["cmd"]
