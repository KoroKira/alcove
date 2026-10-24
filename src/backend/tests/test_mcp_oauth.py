"""OAuth tests use real RS256 signatures and isolated fake persistence."""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient
import jwt
import pytest

import routers.mcp_router as router
from services import mcp_oauth as oauth


@pytest.fixture
def configured(monkeypatch):
    values = {"MCP_OAUTH_ENABLED": "true", "MCP_OAUTH_WRITE_ENABLED": "false", "MCP_OAUTH_RESOURCE": "https://alcove.example/mcp",
              "MCP_OAUTH_CLIENT_IDS": "alcove-codex,alcove-chatgpt", "OIDC_SERVER_URL": "https://auth.example",
              "OIDC_REALM": "alcove", "OIDC_CLIENT_ID": "alcove", "OIDC_INTERNAL_URL": "http://keycloak:8080"}
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(router, "PAD_DEV_MODE", False)
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    monkeypatch.setattr(oauth, "_jwks_client", lambda url: SimpleNamespace(
        get_signing_key_from_jwt=lambda token: SimpleNamespace(key=private.public_key())))
    return private


def token(private, **changes):
    claims = {"sub": str(uuid4()), "iss": "https://auth.example/realms/alcove",
              "aud": "https://alcove.example/mcp", "azp": "alcove-codex", "typ": "Bearer",
              "scope": "openid alcove:read", "iat": datetime.now(timezone.utc),
              "exp": datetime.now(timezone.utc) + timedelta(minutes=5)}
    claims.update(changes)
    return jwt.encode(claims, private, algorithm="RS256")


def session(existing=True):
    result = MagicMock()
    result.scalar_one_or_none.return_value = uuid4() if existing else None
    return SimpleNamespace(execute=AsyncMock(return_value=result))


def run(coro):
    return asyncio.run(coro)


def test_verified_token_maps_subject_and_read_only_scope(configured):
    db = session()
    owner = uuid4()
    principal = run(oauth.verify_oauth_principal(db, token(configured, sub=str(owner))))
    assert principal.owner_id == owner
    assert principal.scopes == frozenset({"read"})
    db.execute.assert_awaited_once()


@pytest.mark.parametrize("changes", [
    {"aud": "alcove"}, {"iss": "https://attacker.example/realms/alcove"},
    {"azp": "alcove"}, {"azp": "unregistered-client"}, {"typ": "ID"},
    {"sub": "not-a-user-id"}, {"scope": "openid profile admin"}, {"scope": ["alcove:read"]},
    {"exp": datetime.now(timezone.utc) - timedelta(minutes=1)},
])
def test_untrusted_or_unscoped_tokens_never_reach_database(configured, changes):
    db = session()
    assert run(oauth.verify_oauth_principal(db, token(configured, **changes))) is None
    db.execute.assert_not_awaited()


def test_bad_signature_is_rejected_before_database(configured):
    attacker = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    db = session()
    assert run(oauth.verify_oauth_principal(db, token(attacker))) is None
    db.execute.assert_not_awaited()


def test_existing_account_required_and_no_auto_provision(configured):
    db = session(existing=False)
    assert run(oauth.verify_oauth_principal(db, token(configured))) is None
    assert not hasattr(db, "add")


def test_only_explicit_write_scope_can_create_notes(configured, monkeypatch):
    monkeypatch.setenv("MCP_OAUTH_WRITE_ENABLED", "true")
    principal = run(oauth.verify_oauth_principal(session(), token(configured, scope="openid alcove:write")))
    assert principal.scopes == frozenset({"write"})


def test_write_is_disabled_by_default_even_with_a_write_scope(configured):
    assert run(oauth.verify_oauth_principal(session(), token(configured, scope="openid alcove:write"))) is None


def test_oauth_is_disabled_by_default(monkeypatch):
    monkeypatch.delenv("MCP_OAUTH_ENABLED", raising=False)
    assert oauth.oauth_settings() is None
    assert run(oauth.verify_oauth_principal(session(), "not-a-token")) is None


@pytest.mark.parametrize("key,value", [("MCP_OAUTH_RESOURCE", "http://alcove.example/mcp"),
    ("MCP_OAUTH_RESOURCE", "https://alcove.example/mcp?access_token=bad"),
    ("MCP_OAUTH_CLIENT_IDS", "alcove"), ("MCP_OAUTH_CLIENT_IDS", "")])
def test_bad_enabled_configuration_fails_closed(configured, monkeypatch, key, value):
    monkeypatch.setenv(key, value)
    with pytest.raises(ValueError):
        oauth.oauth_settings()


def client():
    app = FastAPI()
    app.include_router(router.mcp_metadata_router)
    app.include_router(router.mcp_router)
    return TestClient(app)


def test_metadata_and_transport_challenge_are_discoverable_without_secrets(configured):
    api = client()
    for path in ("/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp",
                 "/mcp/.well-known/oauth-protected-resource"):
        response = api.get(path)
        assert response.status_code == 200
        assert response.json()["resource"] == "https://alcove.example/mcp"
        assert response.json()["authorization_servers"] == ["https://auth.example/realms/alcove"]
        assert "secret" not in response.text
        assert response.json()["scopes_supported"] == ["alcove:read"]
    response = api.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    assert response.status_code == 401
    assert 'resource_metadata="https://alcove.example/.well-known/oauth-protected-resource/mcp"' in response.headers["www-authenticate"]


def test_oauth_read_catalog_and_write_denial(configured, monkeypatch):
    @asynccontextmanager
    async def fake_session():
        yield session()
    monkeypatch.setattr(router, "async_session", fake_session)
    handler = AsyncMock()
    monkeypatch.setitem(router._TOOL_HANDLERS, "write_note", handler)
    api = client()
    headers = {"Authorization": "Bearer " + token(configured)}
    response = api.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    tools = response.json()["result"]["tools"]
    assert {item["name"] for item in tools} == {"search_pads", "read_pad", "list_recent"}
    assert all(item["securitySchemes"] == [{"type": "oauth2", "scopes": ["alcove:read"]}] for item in tools)
    response = api.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                        "params": {"name": "write_note", "arguments": {"title": "Denied", "content": ""}}})
    assert response.status_code == 403
    assert 'scope="alcove:write"' in response.headers["www-authenticate"]
    handler.assert_not_awaited()


def test_api_key_compatibility_when_oauth_is_enabled(configured, monkeypatch):
    @asynccontextmanager
    async def fake_session():
        yield session()
    monkeypatch.setattr(router, "async_session", fake_session)
    monkeypatch.setattr(router, "verify_api_key_principal", AsyncMock(return_value=oauth.McpPrincipal(uuid4(), frozenset({"read"}))))
    monkeypatch.setattr(router, "verify_oauth_principal", AsyncMock())
    response = client().post("/mcp", headers={"Authorization": "Bearer amk_existing_secret"},
                             json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert response.status_code == 200
    router.verify_oauth_principal.assert_not_awaited()


def test_invalid_jsonrpc_body_and_notifications_do_not_write(configured, monkeypatch):
    monkeypatch.setenv("MCP_OAUTH_ENABLED", "false")
    handler = AsyncMock()
    monkeypatch.setitem(router._TOOL_HANDLERS, "write_note", handler)
    api = client()
    for body in ([], None, 123, "string", {"jsonrpc": "1.0", "id": 1, "method": "ping"}):
        response = api.post("/mcp", content=json.dumps(body), headers={"Content-Type": "application/json"})
        assert response.json()["error"]["code"] == -32600
    response = api.post("/mcp", json={"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "write_note"}})
    assert response.status_code == 202
    assert response.content == b""
    handler.assert_not_awaited()


def test_invalid_oauth_token_uses_http_401_with_challenge(configured, monkeypatch):
    @asynccontextmanager
    async def fake_session():
        yield session()
    monkeypatch.setattr(router, "async_session", fake_session)
    response = client().post("/mcp", headers={"Authorization": "Bearer not-a-valid-token"},
                             json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    assert response.status_code == 401
    assert 'error="invalid_token"' in response.headers["www-authenticate"]


def test_disabled_metadata_returns_404_and_bad_configuration_503(configured, monkeypatch):
    monkeypatch.setenv("MCP_OAUTH_ENABLED", "false")
    api = client()
    assert api.get("/.well-known/oauth-protected-resource/mcp").status_code == 404
    monkeypatch.setenv("MCP_OAUTH_ENABLED", "true")
    monkeypatch.setenv("MCP_OAUTH_RESOURCE", "http://unsafe.example/mcp")
    assert api.get("/.well-known/oauth-protected-resource/mcp").status_code == 503
    response = api.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    assert response.status_code == 503


def test_write_metadata_requires_operator_opt_in(configured, monkeypatch):
    monkeypatch.setenv("MCP_OAUTH_WRITE_ENABLED", "true")
    assert client().get("/.well-known/oauth-protected-resource/mcp").json()["scopes_supported"] == ["alcove:read", "alcove:write"]


def test_missing_expiry_or_scope_is_rejected(configured):
    for missing in ("exp", "scope", "aud", "iss", "sub", "azp"):
        claims = jwt.decode(token(configured), options={"verify_signature": False})
        claims.pop(missing)
        unsigned_claims = jwt.encode(claims, configured, algorithm="RS256")
        db = session()
        assert run(oauth.verify_oauth_principal(db, unsigned_claims)) is None
        db.execute.assert_not_awaited()


def test_streamable_http_get_declines_sse_without_breaking_human_info(configured):
    api = client()
    assert api.get("/mcp", headers={"Accept": "text/event-stream"}).status_code == 405
    assert api.get("/mcp").status_code == 200


def test_cross_origin_mcp_is_rejected_even_without_a_session_cookie(configured, monkeypatch):
    monkeypatch.setenv("MCP_OAUTH_ENABLED", "false")
    monkeypatch.setattr(router, "PAD_DEV_MODE", True)
    monkeypatch.setattr(router, "ALLOWED_ORIGINS", ["https://alcove.example"])
    api = client()
    body = {"jsonrpc": "2.0", "id": 1, "method": "initialize"}
    assert api.post("/mcp", json=body, headers={"Origin": "https://attacker.example"}).status_code == 403
    assert api.get("/mcp", headers={"Origin": "https://attacker.example"}).status_code == 403
    assert api.post("/mcp", json=body, headers={"Origin": "https://alcove.example"}).status_code == 200
    assert api.post("/mcp", json=body).status_code == 200
