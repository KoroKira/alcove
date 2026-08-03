import os
import json
import logging
from contextlib import asynccontextmanager
from typing import Optional
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession

import posthog
import httpx
from fastapi import FastAPI, Request, Depends, Response
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from database import init_db, engine
from config import (
    STATIC_DIR, ASSETS_DIR, POSTHOG_API_KEY, POSTHOG_HOST,
    PAD_DEV_MODE, DEV_FRONTEND_URL, SYNC_DIR, FRONTEND_URL
)
from cache import RedisClient
from dependencies import UserSession, optional_auth
from routers.auth_router import auth_router
from routers.users_router import users_router
from routers.workspace_router import workspace_router
from routers.pad_router import pad_router
from routers.app_router import app_router
from routers.ws_router import ws_router
from routers.ai_router import ai_router
from routers.ingest_router import ingest_router
from routers.research_router import research_router
from routers.latex_router import latex_router
from database.database import get_session
from database.models.user_model import UserStore
from domain.pad import Pad
from workers.canvas_worker import CanvasWorker
from domain.user import User

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

if POSTHOG_API_KEY:
    posthog.project_api_key = POSTHOG_API_KEY
    posthog.host = POSTHOG_HOST


@asynccontextmanager
async def lifespan(app: FastAPI):
    if PAD_DEV_MODE:
        logger.info("Running in dev mode (PAD_DEV_MODE=true) — auth bypassed, Vite proxy active")

    if SYNC_DIR:
        os.makedirs(SYNC_DIR, exist_ok=True)
        logger.info("Pad sync directory: %s", SYNC_DIR)

    await init_db()
    logger.info("Database ready")

    await RedisClient.get_instance()
    logger.info("Redis ready")

    await CanvasWorker.get_instance()
    logger.info("Canvas worker started")

    yield

    await CanvasWorker.shutdown_instance()
    await RedisClient.close()
    await engine.dispose()


app = FastAPI(lifespan=lifespan)

# CORS is permissive because authentication is enforced via httpOnly session cookies,
# not Origin headers. Restrict this if you expose the app to the internet.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if not PAD_DEV_MODE:
    app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


async def serve_index_html(
    request: Request = None,
    response: Response = None,
    pad_id: Optional[UUID] = None,
) -> Response:
    """
    Serve the SPA entry point.
    In dev mode, proxies to the Vite dev server so HMR works through port 8000.
    In production, serves the built dist/index.html.
    Optionally sets a pending_pad_id cookie so the frontend can open the right pad on load.
    """
    def _set_pending_pad(resp: Response) -> Response:
        if pad_id is not None:
            _secure = bool(FRONTEND_URL and FRONTEND_URL.startswith("https://"))
            resp.set_cookie("pending_pad_id", str(pad_id), httponly=True, samesite="lax", secure=_secure)
        return resp

    if PAD_DEV_MODE:
        path = request.url.path if request else "/"
        url = f"{DEV_FRONTEND_URL}{path}"
        try:
            async with httpx.AsyncClient() as client:
                proxy = await client.get(url)
                return _set_pending_pad(Response(
                    content=proxy.content,
                    status_code=proxy.status_code,
                    media_type=proxy.headers.get("content-type"),
                ))
        except Exception as e:
            logger.error("Vite proxy error for %s: %s", url, e)
            return Response(content=f"Dev server unreachable: {e}", status_code=502)
    else:
        return _set_pending_pad(FileResponse(os.path.join(STATIC_DIR, "index.html")))


@app.get("/pad/{pad_id}")
async def read_pad(
    pad_id: UUID,
    request: Request,
    response: Response,
    user: Optional[UserSession] = Depends(optional_auth),
    session: AsyncSession = Depends(get_session),
):
    # Unauthenticated: let the frontend handle the auth redirect
    if not user:
        return await serve_index_html(request, response, pad_id)

    try:
        pad = await Pad.get_by_id(session, pad_id)
        if not pad or not pad.can_access(user.id):
            return await serve_index_html(request, response)
        return await serve_index_html(request, response, pad_id)
    except Exception as e:
        logger.warning("Error checking pad access for %s: %s", pad_id, e)
        return await serve_index_html(request, response, pad_id)


@app.get("/")
async def read_root(request: Request, auth: Optional[UserSession] = Depends(optional_auth)):
    if PAD_DEV_MODE and not auth:
        return RedirectResponse("/api/auth/login")
    return await serve_index_html(request)


app.include_router(auth_router, prefix="/api/auth")
app.include_router(users_router, prefix="/api/users")
app.include_router(workspace_router, prefix="/api/workspace")
app.include_router(pad_router, prefix="/api/pad")
app.include_router(app_router, prefix="/api/app")
app.include_router(ws_router)
app.include_router(ai_router)
app.include_router(ingest_router)
app.include_router(research_router)
app.include_router(latex_router)


if PAD_DEV_MODE:
    @app.api_route("/{path:path}", methods=["GET", "HEAD"])
    async def vite_proxy(request: Request, path: str):
        """Forward all unmatched GET requests to the Vite dev server (port 3003)."""
        url = f"{DEV_FRONTEND_URL}/{path}"
        if request.url.query:
            url += f"?{request.url.query}"
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(url, headers={"Accept": request.headers.get("Accept", "*/*")})
                return Response(
                    content=resp.content,
                    status_code=resp.status_code,
                    media_type=resp.headers.get("content-type"),
                )
        except Exception as e:
            return Response(content=f"Vite proxy error: {e}", status_code=502)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
