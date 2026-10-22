from fastapi import FastAPI
from fastapi.testclient import TestClient

from main import mount_frontend_root_assets


def test_frontend_root_mount_serves_pwa_files_without_shadowing_api(tmp_path):
    (tmp_path / "index.html").write_text("<html></html>")
    (tmp_path / "manifest.webmanifest").write_text('{"name":"Alcove"}')
    (tmp_path / "registerSW.js").write_text("registerSW")
    (tmp_path / "sw.js").write_text("serviceWorker")

    app = FastAPI()

    @app.get("/api/health")
    async def health():
        return {"ok": True}

    mount_frontend_root_assets(app, str(tmp_path))
    client = TestClient(app)

    assert client.get("/manifest.webmanifest").json() == {"name": "Alcove"}
    assert client.get("/registerSW.js").text == "registerSW"
    assert client.get("/sw.js").text == "serviceWorker"
    assert client.get("/api/health").json() == {"ok": True}
