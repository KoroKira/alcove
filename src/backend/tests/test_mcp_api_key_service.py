"""Tests for services.mcp_api_key_service — the MCP API key lifecycle
(create/verify/revoke/rotate) that backs mcp_router._resolve_user_id in
production. No real DB : session is a MagicMock/AsyncMock standing in for
SQLAlchemy's AsyncSession, same style as the rest of tests/.
"""
import asyncio
import hashlib
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

from services.mcp_api_key_service import (
    create_api_key,
    revoke_api_key,
    rotate_api_key,
    verify_api_key,
    verify_api_key_principal,
)


def _run(coro):
    return asyncio.run(coro)


def _new_session():
    session = MagicMock()
    session.add = MagicMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    return session


def _session_returning(row):
    """A session whose execute(...).scalar_one_or_none() returns `row`."""
    session = _new_session()
    result = MagicMock()
    result.scalar_one_or_none.return_value = row
    session.execute = AsyncMock(return_value=result)
    return session


def _create(owner_id=None, name="hub-bot", expires_at=None):
    owner_id = owner_id or uuid4()
    token, row = _run(create_api_key(_new_session(), owner_id, name=name, expires_at=expires_at))
    return token, row


# ── create_api_key ──────────────────────────────────────────────────────────

def test_create_api_key_returns_amk_prefixed_token_with_three_parts():
    # secrets.token_urlsafe can itself contain "_", so parsing (like
    # _split_token) must split with maxsplit=2, not a bare split("_").
    token, row = _create()
    parts = token.split("_", 2)
    assert len(parts) == 3
    assert parts[0] == "amk"
    assert parts[1] == row.public_id
    assert row.scopes == ["read"]


def test_scoped_principal_and_rotation_keep_readonly_bound():
    token, row = _create()
    principal = _run(verify_api_key_principal(_session_returning(row), token))
    assert principal.owner_id == row.owner_id and principal.scopes == {"read"}
    _new_token, new_row = _run(rotate_api_key(_session_returning(row), row.public_id))
    assert new_row.scopes == ["read"]


@pytest.mark.parametrize("scopes", [[], ["admin"], ["read", "*"], "read"])
def test_invalid_scope_cannot_mint_key(scopes):
    session = _new_session()
    with pytest.raises(ValueError):
        _run(create_api_key(session, uuid4(), scopes=scopes))
    session.add.assert_not_called()
    session.commit.assert_not_awaited()


def test_raw_secret_is_never_persisted_on_the_row():
    token, row = _create()
    secret = token.split("_", 2)[2]

    assert row.secret_hash != secret
    assert not hasattr(row, "secret")
    assert not hasattr(row, "token")
    # Nothing on the row's __dict__ leaks the raw secret as a substring.
    stored = " ".join(str(v) for v in vars(row).values())
    assert secret not in stored


def test_secret_hash_is_sha256_of_the_secret():
    token, row = _create()
    secret = token.split("_", 2)[2]
    assert row.secret_hash == hashlib.sha256(secret.encode("utf-8")).hexdigest()


def test_two_keys_get_different_public_ids_and_secrets():
    _, row1 = _create()
    _, row2 = _create()
    assert row1.public_id != row2.public_id
    assert row1.secret_hash != row2.secret_hash


# ── verify_api_key ───────────────────────────────────────────────────────────

def test_verify_valid_token_resolves_owner_id():
    owner = uuid4()
    token, row = _create(owner_id=owner)
    session = _session_returning(row)

    resolved = _run(verify_api_key(session, token))

    assert resolved == owner
    session.commit.assert_awaited()  # last_used_at bump persisted


@pytest.mark.parametrize("bad_token", [None, "", "not-a-token", "amk_onlypart", "xyz_a_b", "amk__b", "amk_a_"])
def test_verify_malformed_or_empty_token_rejected_without_db_hit(bad_token):
    session = _new_session()
    session.execute = AsyncMock()

    resolved = _run(verify_api_key(session, bad_token))

    assert resolved is None
    session.execute.assert_not_called()


def test_verify_unknown_public_id_rejected():
    session = _session_returning(None)
    resolved = _run(verify_api_key(session, "amk_deadbeefdeadbeef_somesecret"))
    assert resolved is None


def test_verify_wrong_secret_rejected():
    token, row = _create()
    public_id = token.split("_", 2)[1]
    tampered = f"amk_{public_id}_wrong-secret-value"
    session = _session_returning(row)

    resolved = _run(verify_api_key(session, tampered))

    assert resolved is None


def test_verify_revoked_token_rejected():
    token, row = _create()
    row.revoked_at = datetime.now(timezone.utc)
    session = _session_returning(row)

    assert _run(verify_api_key(session, token)) is None


def test_verify_expired_token_rejected():
    token, row = _create()
    row.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
    session = _session_returning(row)

    assert _run(verify_api_key(session, token)) is None


def test_verify_not_yet_expired_token_accepted():
    owner = uuid4()
    token, row = _create(owner_id=owner)
    row.expires_at = datetime.now(timezone.utc) + timedelta(days=1)
    session = _session_returning(row)

    assert _run(verify_api_key(session, token)) == owner


# ── revoke_api_key ───────────────────────────────────────────────────────────

def test_revoke_marks_row_revoked_and_returns_true():
    _, row = _create()
    session = _session_returning(row)

    assert _run(revoke_api_key(session, row.public_id)) is True
    assert row.revoked_at is not None


def test_revoke_already_revoked_returns_false():
    _, row = _create()
    row.revoked_at = datetime.now(timezone.utc)
    session = _session_returning(row)

    assert _run(revoke_api_key(session, row.public_id)) is False


def test_revoke_unknown_public_id_returns_false():
    session = _session_returning(None)
    assert _run(revoke_api_key(session, "unknown")) is False


# ── rotate_api_key ───────────────────────────────────────────────────────────

def test_rotate_revokes_old_and_mints_new_key_for_same_owner():
    owner = uuid4()
    old_token, old_row = _create(owner_id=owner, name="hub-bot")
    session = _session_returning(old_row)

    result = _run(rotate_api_key(session, old_row.public_id))

    assert result is not None
    new_token, new_row = result
    assert old_row.revoked_at is not None
    assert new_row.owner_id == owner
    assert new_row.name == "hub-bot"
    assert new_row.public_id != old_row.public_id
    assert new_token != old_token


def test_rotate_is_a_single_commit_not_two():
    # Revoking the old key and creating the new one must land in the same
    # transaction — two separate commits would leave a window where a crash
    # mid-rotate revokes the old key without ever creating a replacement.
    owner = uuid4()
    old_token, old_row = _create(owner_id=owner)
    session = _session_returning(old_row)

    _run(rotate_api_key(session, old_row.public_id))

    assert session.commit.await_count == 1


def test_rotate_unknown_key_returns_none():
    session = _session_returning(None)
    assert _run(rotate_api_key(session, "unknown")) is None


def test_rotate_already_revoked_key_returns_none():
    _, row = _create()
    row.revoked_at = datetime.now(timezone.utc)
    session = _session_returning(row)
    assert _run(rotate_api_key(session, row.public_id)) is None
