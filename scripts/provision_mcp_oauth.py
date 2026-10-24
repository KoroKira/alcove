#!/usr/bin/env python3
"""Provision pre-registered Keycloak MCP clients with exact redirects.

No DCR, password grants or client-credentials grants are enabled. Admin tokens
and client secrets only enter private files; API failures never print bodies.
Every mutation has a private snapshot that `rollback` can restore.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import sys
from urllib.parse import quote, urlsplit

import httpx

MARKER = "alcove.mcp.managed"
SCOPES = ("alcove:read", "alcove:write")


class AdminOperationError(RuntimeError):
    """A sanitized operation failure, containing no URL or response body."""


def private_json(path: Path, data) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(data, output, indent=2)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())


def read_private(path: Path) -> str:
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, encoding="utf-8") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise ValueError("Credential files must be regular files with permissions 600")
        return source.read().strip()


def validate_url(value: str, *, loopback=False) -> str:
    parsed = urlsplit(value)
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
            or "*" in value or any(c in value for c in ("\r", "\n", "\\"))):
        raise ValueError("URLs must be exact and must not contain wildcards, credentials, query or fragment")
    if loopback:
        try:
            local = ipaddress.ip_address(parsed.hostname).is_loopback
        except ValueError:
            local = False
        if parsed.scheme != "http" or not local or not parsed.port or parsed.path != "/callback":
            raise ValueError("Codex redirect must be an exact http://127.0.0.1:PORT/callback loopback URL")
    elif parsed.scheme != "https":
        raise ValueError("Public URLs must use HTTPS")
    return value


class Admin:
    def __init__(self, server: str, realm: str, token: str, *, allow_http=False):
        parsed = urlsplit(server)
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", realm):
            raise ValueError("Invalid Keycloak realm")
        if parsed.scheme == "http" and allow_http:
            if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ValueError("Invalid internal admin URL")
        else:
            validate_url(server)
        self.server = server.rstrip("/")
        self.realm = realm
        self.http = httpx.Client(base_url=f"{self.server}/admin/realms/{quote(realm)}/",
                                 headers={"Authorization": "Bearer " + token}, timeout=20,
                                 follow_redirects=False)

    def call(self, method: str, path: str, data=None):
        response = self.http.request(method, path, json=data)
        if not 200 <= response.status_code < 300:
            # Response bodies and URL query values are intentionally excluded.
            raise AdminOperationError(f"Keycloak admin operation failed: {method} HTTP {response.status_code}")
        return response.json() if response.content else None

    def client_id(self, name: str):
        matches = self.call("GET", "clients?clientId=" + quote(name, safe=""))
        matches = [row for row in matches if row.get("clientId") == name]
        if len(matches) > 1:
            raise ValueError("Ambiguous Keycloak client identifier")
        return matches[0]["id"] if matches else None

    def scope_id(self, name: str):
        matches = [row for row in self.call("GET", "client-scopes") if row.get("name") == name]
        if len(matches) > 1:
            raise ValueError("Ambiguous Keycloak client scope")
        return matches[0]["id"] if matches else None

    def snapshot_client(self, name):
        identifier = self.client_id(name)
        if identifier is None:
            return None
        config = self.call("GET", f"clients/{identifier}")
        if config.get("attributes", {}).get(MARKER) != "1":
            raise ValueError("Refusing to change an existing unmanaged Keycloak client")
        scopes = {kind: self.call("GET", f"clients/{identifier}/{kind}-client-scopes")
                  for kind in ("default", "optional")}
        # Admin representation generally omits confidential secrets.
        secret = None if config.get("publicClient") else self.call("GET", f"clients/{identifier}/client-secret")["value"]
        return {"config": config, "scopes": scopes, "secret": secret}

    def replace_scopes(self, identifier, desired):
        for kind in ("default", "optional"):
            current = self.call("GET", f"clients/{identifier}/{kind}-client-scopes")
            current_ids = {item["id"] for item in current}
            target_ids = set(desired[kind])
            for remove in current_ids - target_ids:
                self.call("DELETE", f"clients/{identifier}/{kind}-client-scopes/{remove}")
            for add in target_ids - current_ids:
                self.call("PUT", f"clients/{identifier}/{kind}-client-scopes/{add}")


def scope_config(name):
    read = name == "alcove:read"
    return {"name": name, "protocol": "openid-connect",
            "description": "Read your Alcove notes" if read else "Create new notes in your Alcove account",
            "attributes": {MARKER: "1", "include.in.token.scope": "true", "display.on.consent.screen": "true",
                           "consent.screen.text": "Read Alcove notes" if read else "Create Alcove notes"}}


def client_config(name, redirect, *, public, resource):
    return {"clientId": name, "name": "Alcove MCP — " + ("Codex" if public else "ChatGPT"),
            "protocol": "openid-connect", "enabled": True, "publicClient": public,
            "clientAuthenticatorType": "client-secret", "standardFlowEnabled": True,
            "implicitFlowEnabled": False, "directAccessGrantsEnabled": False,
            "serviceAccountsEnabled": False, "authorizationServicesEnabled": False,
            "fullScopeAllowed": False, "consentRequired": True,
            "redirectUris": [redirect], "webOrigins": [],
            "attributes": {MARKER: "1", "pkce.code.challenge.method": "S256",
                           "access.token.lifespan": "300", "use.refresh.tokens": "true",
                           "oauth2.device.authorization.grant.enabled": "false",
                           "oidc.ciba.grant.enabled": "false"},
            "protocolMappers": [{"name": "alcove-mcp-audience", "protocol": "openid-connect",
                                 "protocolMapper": "oidc-audience-mapper", "consentRequired": False,
                                 "config": {"included.custom.audience": resource,
                                            "access.token.claim": "true", "id.token.claim": "false"}}]}


def provision(admin: Admin, args):
    resource = validate_url(args.resource).rstrip("/")
    if urlsplit(resource).path != "/mcp":
        raise ValueError("Resource must end in /mcp")
    clients = []
    if args.codex_redirect_uri:
        clients.append((args.codex_client_id, validate_url(args.codex_redirect_uri, loopback=True), True))
    if args.chatgpt_redirect_uri:
        clients.append((args.chatgpt_client_id, validate_url(args.chatgpt_redirect_uri), False))
    if not clients or len({name for name, _, _ in clients}) != len(clients):
        raise ValueError("Provide at least one exact callback, with distinct client IDs")
    if any(not re.fullmatch(r"alcove-[A-Za-z0-9_.-]+", name) for name, _, _ in clients):
        raise ValueError("Use dedicated client IDs beginning with alcove-")
    if args.credentials_file.exists():
        raise ValueError("Credential output already exists; choose a fresh private file")
    args.backup_dir.mkdir(mode=0o700, parents=False, exist_ok=False)
    snapshot = {"server": admin.server, "realm": admin.realm, "clients": {}, "scopes": {}}
    for name in SCOPES:
        identifier = admin.scope_id(name)
        previous = admin.call("GET", f"client-scopes/{identifier}") if identifier else None
        if previous and previous.get("attributes", {}).get(MARKER) != "1":
            raise ValueError("Refusing to change an unmanaged MCP client scope")
        snapshot["scopes"][name] = previous
    for name, _, _ in clients:
        snapshot["clients"][name] = admin.snapshot_client(name)
    snapshot_path = args.backup_dir / "keycloak-mcp-before.json"
    private_json(snapshot_path, snapshot)
    # Journal is updated before each mutation, so even an interrupted create can
    # be rolled back by exact managed name. Existing unrelated objects are never
    # adopted or overwritten.
    try:
        for name in SCOPES:
            config = scope_config(name)
            identifier = admin.scope_id(name)
            if identifier:
                config["id"] = identifier
                admin.call("PUT", f"client-scopes/{identifier}", config)
            else:
                admin.call("POST", "client-scopes", config)
        scope_ids = {name: admin.scope_id(name) for name in SCOPES}
        profile_ids = [admin.scope_id(name) for name in ("profile", "email")]
        if not all(profile_ids) or not all(scope_ids.values()):
            raise ValueError("Required profile/email/MCP scopes are unavailable")
        credentials = {"resource": resource, "clients": {}}
        for name, redirect, public in clients:
            config = client_config(name, redirect, public=public, resource=resource)
            identifier = admin.client_id(name)
            if identifier:
                config["id"] = identifier
                # Preserve the existing secret; re-running is not a rotation.
                previous = snapshot["clients"][name]
                if previous and previous["secret"] and not public:
                    config["secret"] = previous["secret"]
                admin.call("PUT", f"clients/{identifier}", config)
            else:
                admin.call("POST", "clients", config)
                identifier = admin.client_id(name)
            admin.replace_scopes(identifier, {"default": profile_ids + [scope_ids["alcove:read"]],
                                  "optional": [scope_ids["alcove:write"]] if args.allow_write else []})
            credentials["clients"][name] = {"client_id": name, "redirect_uri": redirect,
                                            "public": public, "default_scopes": ["openid", "profile", "email", "alcove:read"],
                                            "optional_scopes": ["alcove:write"] if args.allow_write else []}
            if not public:
                credentials["clients"][name]["client_secret"] = admin.call("GET", f"clients/{identifier}/client-secret")["value"]
        private_json(args.credentials_file, credentials)
    except BaseException:
        # Best effort automatic rollback; keep the snapshot for retry if a
        # network outage also prevents recovery. Never erase credential files.
        try:
            rollback(admin, snapshot)
        except Exception:
            print("Automatic rollback incomplete; use the private snapshot to retry rollback.", file=sys.stderr)
        raise
    print("MCP OAuth clients configured; credentials and rollback snapshot saved to private files.")


def rollback(admin: Admin, snapshot):
    if snapshot["server"] != admin.server or snapshot["realm"] != admin.realm:
        raise ValueError("Rollback server/realm does not match this snapshot")
    for name, previous in snapshot["clients"].items():
        current_id = admin.client_id(name)
        if previous is None:
            if current_id:
                current = admin.call("GET", f"clients/{current_id}")
                if current.get("attributes", {}).get(MARKER) != "1":
                    raise ValueError("Refusing to remove an unmanaged client")
                admin.call("DELETE", f"clients/{current_id}")
        else:
            if current_id != previous["config"]["id"]:
                raise ValueError("Client identity changed; manual rollback required")
            config = deepcopy(previous["config"])
            if previous["secret"]:
                config["secret"] = previous["secret"]
            admin.call("PUT", f"clients/{current_id}", config)
            admin.replace_scopes(current_id, {kind: [s["id"] for s in rows] for kind, rows in previous["scopes"].items()})
    for name, previous in snapshot["scopes"].items():
        current_id = admin.scope_id(name)
        if previous is None:
            if current_id:
                current = admin.call("GET", f"client-scopes/{current_id}")
                if current.get("attributes", {}).get(MARKER) != "1":
                    raise ValueError("Refusing to remove an unmanaged scope")
                admin.call("DELETE", f"client-scopes/{current_id}")
        else:
            if current_id != previous["id"]:
                raise ValueError("Scope identity changed; manual rollback required")
            admin.call("PUT", f"client-scopes/{current_id}", previous)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-url", required=True)
    parser.add_argument("--realm", required=True)
    parser.add_argument("--admin-token-file", type=Path, required=True)
    parser.add_argument("--allow-http-internal", action="store_true", help="Explicitly allow a trusted internal admin HTTP origin")
    commands = parser.add_subparsers(dest="command", required=True)
    setup = commands.add_parser("provision")
    setup.add_argument("--resource", required=True)
    setup.add_argument("--codex-client-id", default="alcove-codex")
    setup.add_argument("--chatgpt-client-id", default="alcove-chatgpt")
    setup.add_argument("--codex-redirect-uri")
    setup.add_argument("--chatgpt-redirect-uri")
    setup.add_argument("--allow-write", action="store_true", help="Make write available only as an explicitly requested, consented scope")
    setup.add_argument("--backup-dir", type=Path, required=True)
    setup.add_argument("--credentials-file", type=Path, required=True)
    restore = commands.add_parser("rollback")
    restore.add_argument("--snapshot", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        raw = read_private(args.admin_token_file)
        admin_token = json.loads(raw)["access_token"] if raw.startswith("{") else raw
        if not admin_token or any(c.isspace() for c in admin_token):
            raise ValueError("Invalid admin token file")
        admin = Admin(args.server_url, args.realm, admin_token, allow_http=args.allow_http_internal)
        if args.command == "provision":
            provision(admin, args)
        else:
            rollback(admin, json.loads(read_private(args.snapshot)))
            print("MCP OAuth configuration restored from private snapshot.")
    except AdminOperationError as error:
        print(str(error) + ". Credentials and response bodies are not printed.", file=sys.stderr)
        return 1
    except (ValueError, OSError, RuntimeError, httpx.HTTPError, KeyError):
        print("MCP OAuth operation failed. Check configuration, private file permissions and admin access; credentials are not printed.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
