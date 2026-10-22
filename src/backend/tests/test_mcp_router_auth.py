"""Tests for mcp_router's auth surface : _resolve_user_id and the
initialize/ping/tools-list/tools-call dispatch around it.

No real DB or HTTP server : the endpoint function is called directly with a
tiny fake Request, and the DB-touching bits (async_session, verify_api_key_principal,
get_session, tool handlers) are monkeypatched — same boundary the service
tests already cover in test_mcp_api_key_service.py.
"""
import asyncio
import inspect
import json
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException

import routers.mcp_router as mcp_router
from routers.auth_router import DEV_USER_ID


def _run(coro):
    return asyncio.run(coro)


class _FakeRequest:
    def __init__(self, body=None, headers=None):
        self._body = body
        self.headers = headers or {}

    async def json(self):
        return self._body


@asynccontextmanager
async def _fake_async_session():
    yield MagicMock()


async def _fake_get_session():
    yield MagicMock()


# ── _resolve_user_id ─────────────────────────────────────────────────────────

def test_dev_mode_resolves_fixed_dev_user_without_any_token(monkeypatch):
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", True)
    request = _FakeRequest(headers={})

    user_id = _run(mcp_router._resolve_user_id(request))

    assert user_id == UUID(DEV_USER_ID)


def test_prod_mode_missing_authorization_header_rejected(monkeypatch):
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", False)
    verify = AsyncMock()
    monkeypatch.setattr(mcp_router, "verify_api_key_principal", verify)
    request = _FakeRequest(headers={})

    with pytest.raises(HTTPException) as exc_info:
        _run(mcp_router._resolve_user_id(request))

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail["code"] == "auth_required"
    verify.assert_not_called()


def test_prod_mode_non_bearer_scheme_rejected(monkeypatch):
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", False)
    request = _FakeRequest(headers={"authorization": "Basic dXNlcjpwYXNz"})

    with pytest.raises(HTTPException) as exc_info:
        _run(mcp_router._resolve_user_id(request))

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail["code"] == "auth_required"


def test_prod_mode_invalid_token_rejected(monkeypatch):
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", False)
    monkeypatch.setattr(mcp_router, "async_session", _fake_async_session)
    monkeypatch.setattr(mcp_router, "verify_api_key_principal", AsyncMock(return_value=None))
    request = _FakeRequest(headers={"authorization": "Bearer amk_bad_bad"})

    with pytest.raises(HTTPException) as exc_info:
        _run(mcp_router._resolve_user_id(request))

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail["code"] == "auth_invalid"


def test_prod_mode_valid_token_resolves_owner_id(monkeypatch):
    owner = uuid4()
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", False)
    monkeypatch.setattr(mcp_router, "async_session", _fake_async_session)
    monkeypatch.setattr(mcp_router, "verify_api_key_principal", AsyncMock(return_value=mcp_router.McpPrincipal(owner, frozenset({"read", "write"}))))
    request = _FakeRequest(headers={"authorization": "Bearer amk_x_y"})

    resolved = _run(mcp_router._resolve_user_id(request))

    assert resolved == owner


@pytest.mark.parametrize("header", ["bearer amk_x_y", "BEARER amk_x_y", "BeArEr amk_x_y"])
def test_prod_mode_bearer_scheme_is_case_insensitive(monkeypatch, header):
    owner = uuid4()
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", False)
    monkeypatch.setattr(mcp_router, "async_session", _fake_async_session)
    verify = AsyncMock(return_value=mcp_router.McpPrincipal(owner, frozenset({"read", "write"})))
    monkeypatch.setattr(mcp_router, "verify_api_key_principal", verify)
    request = _FakeRequest(headers={"authorization": header})

    resolved = _run(mcp_router._resolve_user_id(request))

    assert resolved == owner
    assert verify.await_args.args[1] == "amk_x_y"


def test_prod_mode_extra_whitespace_around_token_is_tolerated(monkeypatch):
    # "Bearer  amk_x_y" (two spaces) : partition(" ") only eats the first
    # one, leaving a leading space on `token` — verify_api_key_principal's own
    # token.strip() must still parse it correctly rather than rejecting a
    # token that merely has incidental whitespace around it.
    owner = uuid4()
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", False)
    monkeypatch.setattr(mcp_router, "async_session", _fake_async_session)
    verify = AsyncMock(return_value=mcp_router.McpPrincipal(owner, frozenset({"read", "write"})))
    monkeypatch.setattr(mcp_router, "verify_api_key_principal", verify)
    request = _FakeRequest(headers={"authorization": "Bearer  amk_x_y"})

    resolved = _run(mcp_router._resolve_user_id(request))

    assert resolved == owner


def test_prod_mode_empty_authorization_header_rejected(monkeypatch):
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", False)
    request = _FakeRequest(headers={"authorization": ""})

    with pytest.raises(HTTPException) as exc_info:
        _run(mcp_router._resolve_user_id(request))

    assert exc_info.value.detail["code"] == "auth_required"


def test_prod_mode_bearer_with_no_token_rejected(monkeypatch):
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", False)
    request = _FakeRequest(headers={"authorization": "Bearer"})

    with pytest.raises(HTTPException) as exc_info:
        _run(mcp_router._resolve_user_id(request))

    assert exc_info.value.detail["code"] == "auth_required"


# ── endpoint dispatch : initialize / ping / tools-list stay open ────────────

@pytest.mark.parametrize("method", ["initialize", "ping"])
def test_lifecycle_methods_work_without_auth_in_prod_mode(monkeypatch, method):
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", False)
    request = _FakeRequest({"jsonrpc": "2.0", "id": 1, "method": method, "params": {}})

    response = _run(mcp_router.mcp_endpoint(request))
    body = json.loads(response.body)

    assert response.status_code == 200
    assert "error" not in body


def test_tools_list_works_without_auth_in_prod_mode(monkeypatch):
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", False)
    request = _FakeRequest({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})

    response = _run(mcp_router.mcp_endpoint(request))
    body = json.loads(response.body)

    assert response.status_code == 200
    names = {t["name"] for t in body["result"]["tools"]}
    assert names == {"search_pads", "read_pad", "list_recent", "write_note"}


def test_tools_list_unaffected_by_dev_mode_either(monkeypatch):
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", True)
    request = _FakeRequest({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})

    response = _run(mcp_router.mcp_endpoint(request))
    body = json.loads(response.body)

    assert len(body["result"]["tools"]) == 4


# ── endpoint dispatch : tools/call requires and uses auth ───────────────────

def test_tools_call_without_token_in_prod_mode_returns_jsonrpc_auth_error(monkeypatch):
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", False)
    request = _FakeRequest({
        "jsonrpc": "2.0", "id": 7, "method": "tools/call",
        "params": {"name": "list_recent", "arguments": {}},
    })

    response = _run(mcp_router.mcp_endpoint(request))
    body = json.loads(response.body)

    assert response.status_code == 200
    assert body["error"]["code"] == -32001


def test_tools_call_with_valid_token_dispatches_with_resolved_owner(monkeypatch):
    owner = uuid4()
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", False)
    monkeypatch.setattr(mcp_router, "async_session", _fake_async_session)
    monkeypatch.setattr(mcp_router, "verify_api_key_principal", AsyncMock(return_value=mcp_router.McpPrincipal(owner, frozenset({"read", "write"}))))
    monkeypatch.setattr(mcp_router, "get_session", _fake_get_session)

    captured = {}

    async def fake_handler(args, user_id, session):
        captured["user_id"] = user_id
        return {"ok": True}

    monkeypatch.setitem(mcp_router._TOOL_HANDLERS, "list_recent", fake_handler)

    request = _FakeRequest({
        "jsonrpc": "2.0", "id": 7, "method": "tools/call",
        "params": {"name": "list_recent", "arguments": {}},
    }, headers={"authorization": "Bearer amk_x_y"})

    response = _run(mcp_router.mcp_endpoint(request))
    body = json.loads(response.body)

    assert response.status_code == 200
    assert body["result"]["isError"] is False
    assert captured["user_id"] == owner


def test_dev_mode_tools_call_still_uses_dev_user_id_unchanged(monkeypatch):
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", True)
    monkeypatch.setattr(mcp_router, "get_session", _fake_get_session)

    captured = {}

    async def fake_handler(args, user_id, session):
        captured["user_id"] = user_id
        return {"ok": True}

    monkeypatch.setitem(mcp_router._TOOL_HANDLERS, "list_recent", fake_handler)

    request = _FakeRequest({
        "jsonrpc": "2.0", "id": 7, "method": "tools/call",
        "params": {"name": "list_recent", "arguments": {}},
    }, headers={})

    response = _run(mcp_router.mcp_endpoint(request))
    body = json.loads(response.body)

    assert response.status_code == 200
    assert body["result"]["isError"] is False
    assert captured["user_id"] == UUID(DEV_USER_ID)


def test_readonly_key_catalog_and_direct_write_are_both_fenced(monkeypatch):
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", False)
    monkeypatch.setattr(mcp_router, "async_session", _fake_async_session)
    monkeypatch.setattr(mcp_router, "verify_api_key_principal", AsyncMock(return_value=
                        mcp_router.McpPrincipal(uuid4(), frozenset({"read"}))))
    handler = AsyncMock()
    monkeypatch.setitem(mcp_router._TOOL_HANDLERS, "write_note", handler)
    headers = {"authorization": "Bearer synthetic-readonly"}
    listed = _run(mcp_router.mcp_endpoint(_FakeRequest({"jsonrpc": "2.0", "id": 1,
                  "method": "tools/list"}, headers)))
    tools = json.loads(listed.body)["result"]["tools"]
    assert {tool["name"] for tool in tools} == {"search_pads", "read_pad", "list_recent"}
    assert all(tool["annotations"]["readOnlyHint"] for tool in tools)
    called = _run(mcp_router.mcp_endpoint(_FakeRequest({"jsonrpc": "2.0", "id": 2,
                  "method": "tools/call", "params": {"name": "write_note", "arguments": {
                      "title": "Forbidden", "content": "Never persist"}}}, headers)))
    assert json.loads(called.body)["error"]["code"] == -32003
    handler.assert_not_awaited()


def test_write_only_key_catalog_exposes_only_write_tool(monkeypatch):
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", False)
    monkeypatch.setattr(mcp_router, "async_session", _fake_async_session)
    monkeypatch.setattr(mcp_router, "verify_api_key_principal", AsyncMock(return_value=
                        mcp_router.McpPrincipal(uuid4(), frozenset({"write"}))))
    response = _run(mcp_router.mcp_endpoint(_FakeRequest(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        {"authorization": "Bearer synthetic-writeonly"},
    )))
    tools = json.loads(response.body)["result"]["tools"]
    assert {tool["name"] for tool in tools} == {"write_note"}
    assert tools[0]["annotations"]["readOnlyHint"] is False


@pytest.mark.parametrize("arguments", [
    {"title": "valid", "content": "body", "owner_id": str(uuid4())},
    {"title": "valid", "content": 123},
    {"title": "x" * 101, "content": "body"},
    {"title": "valid", "content": "body", "tags": ["ok", 123]},
    {"title": "valid", "content": "x" * 256_001},
])
def test_invalid_write_note_arguments_are_rejected_before_handler(monkeypatch, arguments):
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", True)
    handler = AsyncMock()
    monkeypatch.setitem(mcp_router._TOOL_HANDLERS, "write_note", handler)

    response = _run(mcp_router.mcp_endpoint(_FakeRequest({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "write_note", "arguments": arguments},
    })))
    error = json.loads(response.body)["error"]

    assert error["code"] == -32602
    handler.assert_not_awaited()


def test_principal_override_argument_rejected_before_handler(monkeypatch):
    monkeypatch.setattr(mcp_router, "PAD_DEV_MODE", True)
    handler = AsyncMock()
    monkeypatch.setitem(mcp_router._TOOL_HANDLERS, "list_recent", handler)
    called = _run(mcp_router.mcp_endpoint(_FakeRequest({"jsonrpc": "2.0", "id": 2,
                  "method": "tools/call", "params": {"name": "list_recent", "arguments": {
                      "user_id": str(uuid4())}}})))
    assert json.loads(called.body)["error"]["code"] == -32602
    handler.assert_not_awaited()


# ── tokens must never be logged ──────────────────────────────────────────────

def test_no_logging_statement_in_mcp_router_references_the_token():
    src = inspect.getsource(mcp_router)
    for line in src.splitlines():
        if "logger." in line:
            assert "token" not in line.lower()


def test_mcp_api_key_service_has_no_logging_at_all():
    from services import mcp_api_key_service
    src = inspect.getsource(mcp_api_key_service)
    assert "logger" not in src
    assert "logging" not in src
