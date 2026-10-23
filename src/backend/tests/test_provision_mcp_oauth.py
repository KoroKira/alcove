"""Exercise safe Keycloak provisioning, repeated runs and rollback without I/O."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import unquote

import pytest

spec = importlib.util.spec_from_file_location("provision_mcp_oauth", Path(__file__).resolve().parents[3] / "scripts/provision_mcp_oauth.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class FakeAdmin(cli.Admin):
    def __init__(self):
        self.server = "https://auth.example"
        self.realm = "alcove"
        self.clients = {}
        self.scopes = {name: {"id": name, "name": name} for name in ("email", "profile", "roles", "offline_access")}
        self.secrets = {}
        self.assignments = {}
        self.fail_once = False
        self.operations = []

    def call(self, method, path, data=None):
        self.operations.append((method, path))
        if self.fail_once and method == "PUT" and "/optional-client-scopes/" in path:
            self.fail_once = False
            raise RuntimeError("simulated interrupted update")
        parts = path.split("/")
        if path.startswith("clients?clientId="):
            name = unquote(path.split("=", 1)[1])
            return deepcopy([row for row in self.clients.values() if row["clientId"] == name])
        if path == "client-scopes":
            if method == "GET":
                return deepcopy(list(self.scopes.values()))
            row = deepcopy(data)
            row["id"] = row["name"]
            self.scopes[row["id"]] = row
            return None
        if parts[0] == "client-scopes" and len(parts) == 2:
            identifier = parts[1]
            if method == "GET":
                return deepcopy(self.scopes[identifier])
            if method == "PUT":
                self.scopes[identifier] = deepcopy(data)
            else:
                del self.scopes[identifier]
            return None
        if path == "clients":
            row = deepcopy(data)
            identifier = row["clientId"] + "-uuid"
            row["id"] = identifier
            self.clients[identifier] = row
            self.secrets[identifier] = "private-client-secret"
            self.assignments[identifier] = {"default": {"email", "profile", "roles"}, "optional": {"offline_access"}}
            return None
        if parts[0] == "clients":
            identifier = parts[1]
            if len(parts) == 2:
                if method == "GET":
                    return deepcopy(self.clients[identifier])
                if method == "PUT":
                    self.clients[identifier] = deepcopy(data)
                    if "secret" in data:
                        self.secrets[identifier] = data["secret"]
                else:
                    del self.clients[identifier]
                    del self.assignments[identifier]
                return None
            if parts[2] == "client-secret":
                return {"value": self.secrets[identifier]}
            kind = parts[2].split("-", 1)[0]
            if len(parts) == 3:
                return deepcopy([self.scopes[key] for key in self.assignments[identifier][kind]])
            if method == "PUT":
                self.assignments[identifier][kind].add(parts[3])
            else:
                self.assignments[identifier][kind].remove(parts[3])
            return None
        raise AssertionError((method, path))


def arguments(tmp_path, suffix="", write=False):
    return SimpleNamespace(resource="https://alcove.example/mcp", codex_client_id="alcove-codex",
                           chatgpt_client_id="alcove-chatgpt", codex_redirect_uri="http://127.0.0.1:18765/callback",
                           chatgpt_redirect_uri="https://chatgpt.com/connector_platform_oauth_redirect",
                           backup_dir=tmp_path / ("backup" + suffix), credentials_file=tmp_path / ("credentials" + suffix + ".json"),
                           allow_write=write)


def test_provision_is_read_only_by_default_private_and_rollback_recovers(tmp_path, capsys):
    admin = FakeAdmin()
    args = arguments(tmp_path)
    cli.provision(admin, args)
    for row in admin.clients.values():
        assert row["standardFlowEnabled"] is True
        assert row["implicitFlowEnabled"] is False
        assert row["directAccessGrantsEnabled"] is False
        assert row["serviceAccountsEnabled"] is False
        assert row["consentRequired"] is True
        assert row["attributes"]["pkce.code.challenge.method"] == "S256"
        assert admin.assignments[row["id"]] == {"default": {"email", "profile", "alcove:read"}, "optional": set()}
        assert row["protocolMappers"][0]["config"]["included.custom.audience"] == args.resource
    assert args.credentials_file.stat().st_mode & 0o777 == 0o600
    assert args.backup_dir.stat().st_mode & 0o777 == 0o700
    snapshot_path = args.backup_dir / "keycloak-mcp-before.json"
    assert snapshot_path.stat().st_mode & 0o777 == 0o600
    assert "private-client-secret" not in capsys.readouterr().out
    snapshot = json.loads(cli.read_private(snapshot_path))
    cli.rollback(admin, snapshot)
    assert admin.clients == {}
    assert set(admin.scopes) == {"email", "profile", "roles", "offline_access"}


def test_idempotent_provision_preserves_secret_and_rolls_back_changes(tmp_path):
    admin = FakeAdmin()
    cli.provision(admin, arguments(tmp_path))
    before_clients, before_assignments = deepcopy(admin.clients), deepcopy(admin.assignments)
    args = arguments(tmp_path, "-second", write=True)
    cli.provision(admin, args)
    credentials = json.loads(cli.read_private(args.credentials_file))
    assert credentials["clients"]["alcove-chatgpt"]["client_secret"] == "private-client-secret"
    assert all(row["optional"] == {"alcove:write"} for row in admin.assignments.values())
    cli.rollback(admin, json.loads(cli.read_private(args.backup_dir / "keycloak-mcp-before.json")))
    # Secret is preserved explicitly in restored config; compare operational fields.
    for row in admin.clients.values():
        row.pop("secret", None)
    assert admin.clients == before_clients
    assert admin.assignments == before_assignments


def test_failed_partial_provision_rolls_back_before_returning_error(tmp_path):
    admin = FakeAdmin()
    admin.fail_once = True
    with pytest.raises(RuntimeError):
        cli.provision(admin, arguments(tmp_path, write=True))
    assert admin.clients == {}
    assert set(admin.scopes) == {"email", "profile", "roles", "offline_access"}
    assert not (tmp_path / "credentials.json").exists()


@pytest.mark.parametrize("url,loopback", [("https://chatgpt.com/*", False),
    ("http://attacker.example/callback", True), ("http://127.0.0.1/callback", True),
    ("http://127.0.0.1:18765/other", True), ("https://user:password@chatgpt.com/callback", False)])
def test_unsafe_redirects_are_rejected(url, loopback):
    with pytest.raises(ValueError):
        cli.validate_url(url, loopback=loopback)


def test_unmanaged_client_is_never_changed(tmp_path):
    admin = FakeAdmin()
    admin.clients["foreign"] = {"id": "foreign", "clientId": "alcove-codex", "attributes": {}}
    with pytest.raises(ValueError):
        cli.provision(admin, arguments(tmp_path))
    assert all(method == "GET" for method, _ in admin.operations)


def test_private_files_are_not_overwritten_and_unsafe_permissions_rejected(tmp_path):
    path = tmp_path / "token"
    path.write_text("private")
    path.chmod(0o644)
    with pytest.raises(ValueError):
        cli.read_private(path)
    with pytest.raises(FileExistsError):
        cli.private_json(path, {"secret": "replacement"})
    assert path.read_text() == "private"
