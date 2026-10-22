"""The Coder workspace integration is optional for an Alcove deployment."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from dependencies import get_optional_coder_api, require_auth
from routers.workspace_router import workspace_router


def test_coder_api_dependency_is_disabled_without_credentials(monkeypatch):
    monkeypatch.delenv("CODER_API_KEY", raising=False)
    monkeypatch.delenv("CODER_URL", raising=False)

    assert get_optional_coder_api() is None


def test_workspace_routes_report_optional_integration_as_unavailable(monkeypatch):
    app = FastAPI()
    app.include_router(workspace_router, prefix="/api/workspace")
    app.dependency_overrides[get_optional_coder_api] = lambda: None
    app.dependency_overrides[require_auth] = lambda: object()

    client = TestClient(app)
    responses = [
        client.get("/api/workspace/state"),
        client.post("/api/workspace/start"),
        client.post("/api/workspace/stop"),
    ]

    for response in responses:
        assert response.status_code == 503
        assert response.json()["detail"] == {
            "code": "workspace_integration_disabled",
            "message": "Workspace management is not configured on this Alcove instance.",
        }
