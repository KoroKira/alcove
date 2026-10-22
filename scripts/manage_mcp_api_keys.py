# Admin CLI for MCP machine-to-machine API keys (pad_ws.mcp_api_keys).
# Thin wrapper around services.mcp_api_key_service — see that module's
# docstring for the token format and threat model. Run from the machine
# that can reach the target Postgres (same POSTGRES_* env vars / .env the
# backend itself uses); this script does not start the FastAPI app.
#
# Usage (run from repo root):
#   python scripts/manage_mcp_api_keys.py create --email user@example.com --name agent --scope read --token-file /private/fresh.token [--expires-days 90]
#   python scripts/manage_mcp_api_keys.py list --email user@example.com
#   python scripts/manage_mcp_api_keys.py revoke --public-id <public_id>
#   python scripts/manage_mcp_api_keys.py rotate --public-id <public_id> --token-file /private/replacement.token
#
# `create` and `rotate` write the token once to --token-file (exclusive,
# mode 600). Tokens never enter stdout/stderr or command-line arguments.
import argparse
import asyncio
from contextlib import contextmanager
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "backend"))

from database.database import async_session  # noqa: E402
from database.models.user_model import UserStore  # noqa: E402
from database.models.mcp_api_key_model import McpApiKey  # noqa: E402
from services.mcp_api_key_service import (  # noqa: E402
    create_api_key,
    revoke_api_key,
    rotate_api_key,
)
from sqlalchemy import select  # noqa: E402


@contextmanager
def _token_output(path):
    if not path:
        raise SystemExit("--token-file is required; token output to the terminal is disabled")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except OSError:
        raise SystemExit("Token file unavailable; existing files are never overwritten") from None
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            yield output
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        os.unlink(path)
        raise


def _write_token(output, token):
    output.write(token + "\n")
    output.flush()
    os.fsync(output.fileno())


async def _resolve_owner_id(session, email: str):
    """Look up the exactly-one users.id row matching --email.

    Doesn't rely on UserStore.get_by_email's implicit .first() (which would
    silently pick a row if the email unique constraint were ever violated) —
    explicitly rejects both "no such user" and "more than one match" so a
    key is never bound to the wrong owner or to nobody.
    """
    stmt = select(UserStore.id).where(UserStore.email == email)
    ids = (await session.execute(stmt)).scalars().all()
    if len(ids) == 0:
        raise SystemExit(f"No user with email {email!r} — refusing to create a key.")
    if len(ids) > 1:
        raise SystemExit(
            f"{len(ids)} users share email {email!r} — refusing to create a key "
            "for an ambiguous owner. Fix the duplicate accounts first."
        )
    return ids[0]


async def cmd_create(args):
    with _token_output(args.token_file) as output:
        async with async_session() as session:
            owner_id = await _resolve_owner_id(session, args.email)
            expires_at = (
                datetime.now(timezone.utc) + timedelta(days=args.expires_days)
                if args.expires_days else None
            )
            token, row = await create_api_key(session, owner_id, name=args.name, expires_at=expires_at,
                                             scopes=args.scope or ["read"])
            try:
                _write_token(output, token)
            except OSError:
                await revoke_api_key(session, row.public_id)
                raise
    print(f"public_id: {row.public_id}")
    print("Fresh token saved to the exclusive mode-600 token file; scopes: " + ",".join(args.scope or ["read"]))


async def cmd_list(args):
    async with async_session() as session:
        owner_id = await _resolve_owner_id(session, args.email)
        stmt = select(McpApiKey).where(McpApiKey.owner_id == owner_id).order_by(McpApiKey.created_at)
        rows = (await session.execute(stmt)).scalars().all()
    if not rows:
        print("No MCP API keys for this user.")
        return
    for r in rows:
        status = "revoked" if r.revoked_at else "active"
        print(f"{r.public_id}  {status:8}  name={r.name!r}  created={r.created_at}  "
              f"expires={r.expires_at}  last_used={r.last_used_at}  scopes={r.scopes}")


async def cmd_revoke(args):
    async with async_session() as session:
        ok = await revoke_api_key(session, args.public_id)
    print("revoked" if ok else "not found or already revoked")


async def cmd_rotate(args):
    with _token_output(args.token_file) as output:
        async with async_session() as session:
            result = await rotate_api_key(session, args.public_id)
            if result is None:
                raise SystemExit("not found or already revoked — use `create` instead")
            token, row = result
            try:
                _write_token(output, token)
            except OSError:
                await revoke_api_key(session, row.public_id)
                raise
    print("The old key is revoked; the replacement retains its scope bound.")
    print(f"new public_id: {row.public_id}")
    print("Replacement token saved to the exclusive mode-600 token file.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_create = sub.add_parser("create", help="Mint a new MCP API key for a user")
    p_create.add_argument("--email", required=True, help="Alcove account email to bind the key to")
    p_create.add_argument("--name", default=None, help="Label, e.g. 'hub-bot'")
    p_create.add_argument("--expires-days", type=int, default=None, help="Optional expiry, in days")
    p_create.add_argument("--scope", action="append", choices=["read", "write"], help="Repeat for both; default read only")
    p_create.add_argument("--token-file", required=True, help="New private file for the token (mode 600; never overwritten)")
    p_create.set_defaults(func=cmd_create)

    p_list = sub.add_parser("list", help="List MCP API keys for a user (never shows secrets)")
    p_list.add_argument("--email", required=True)
    p_list.set_defaults(func=cmd_list)

    p_revoke = sub.add_parser("revoke", help="Revoke a key by its public_id")
    p_revoke.add_argument("--public-id", required=True)
    p_revoke.set_defaults(func=cmd_revoke)

    p_rotate = sub.add_parser("rotate", help="Revoke a key and mint a replacement for the same owner")
    p_rotate.add_argument("--public-id", required=True)
    p_rotate.add_argument("--token-file", required=True)
    p_rotate.set_defaults(func=cmd_rotate)

    args = parser.parse_args()
    try:
        asyncio.run(args.func(args))
    except Exception:
        raise SystemExit("MCP key operation failed; no token was printed") from None


if __name__ == "__main__":
    main()
