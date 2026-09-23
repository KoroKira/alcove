from types import SimpleNamespace
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.v1.router import get_pad_query_service, require_v1_auth, v1_router
from application.errors import PermissionDeniedError
from application.principal import Principal


USER_ID = uuid4()


class FakeService:
    async def get_me(self, user_id, session_user):
        return {
            "id": str(USER_ID),
            "username": "alice",
            "email": "alice@example.test",
            "email_verified": True,
            "name": "Alice",
            "given_name": "Alice",
            "family_name": "Example",
            "roles": [],
            "last_selected_pad": None,
            "folders": [],
            "pads": [],
        }

    async def list_pads(self, user_id):
        return [{
            "id": str(uuid4()),
            "owner_id": str(USER_ID),
            "display_name": "Notes",
            "created_at": None,
            "updated_at": None,
            "sharing_policy": "private",
            "theme": None,
            "is_scratch": False,
            "pad_type": "document",
            "tags": [],
            "folder": None,
            "thumbnail_url": None,
            "source_url": None,
        }]

    async def get_pad_content(self, pad_id, user_id):
        raise PermissionDeniedError("Not authorized to access this pad")

    async def search(self, user_id, query, limit=50):
        return [{"pad_id": "pad-1", "pad_name": "Notes", "name_match": True, "matches": []}]


def make_client():
    app = FastAPI()
    app.include_router(v1_router)
    app.dependency_overrides[require_v1_auth] = lambda: SimpleNamespace(
        id=USER_ID,
        username="alice",
        email="alice@example.test",
        email_verified=True,
        name="Alice",
        given_name="Alice",
        family_name="Example",
        roles=[],
    )
    app.dependency_overrides[get_pad_query_service] = lambda: FakeService()
    return TestClient(app)


def test_v1_read_routes_return_stable_dtos():
    client = make_client()

    me = client.get("/api/v1/me")
    pads = client.get("/api/v1/pads")
    search = client.get("/api/v1/search?q=notes")

    assert me.status_code == 200
    assert me.json()["username"] == "alice"
    assert pads.status_code == 200
    assert pads.json()[0]["display_name"] == "Notes"
    assert search.status_code == 200
    assert search.json()[0]["pad_id"] == "pad-1"


def test_v1_errors_use_a_consistent_shape():
    response = make_client().get(f"/api/v1/pads/{uuid4()}")

    assert response.status_code == 404
    assert response.json()["detail"] == {
        "code": "not_found",
        "message": "Pad not found",
    }


def test_v1_scope_is_required_for_external_capabilities():
    app = FastAPI()
    app.include_router(v1_router)
    app.dependency_overrides[require_v1_auth] = lambda: Principal(
        id=USER_ID,
        auth_type="api_token",
        scopes=frozenset({"pads:read"}),
    )
    app.dependency_overrides[get_pad_query_service] = lambda: FakeService()

    response = TestClient(app).get("/api/v1/search?q=notes")

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "insufficient_scope"
    assert response.json()["detail"]["required_scope"] == "search:read"
