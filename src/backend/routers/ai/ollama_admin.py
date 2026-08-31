"""Ollama lifecycle admin: setup wizard, model list/pull/delete, status probe."""
import os
import json
import shutil
import asyncio

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from dependencies import UserSession, require_admin, require_auth
from config import OLLAMA_URL, OLLAMA_DEFAULT_MODEL

from ._shared import (
    ollama_bin, brew_bin, shell_env,
    server_is_running, wait_for_server, fire_ollama, installed_models,
    find_env_local, upsert_env_var,
)


router = APIRouter()


class SetupRequest(BaseModel):
    model: str = "llama3.2"


class DeleteModelRequest(BaseModel):
    name: str


class PullModelRequest(BaseModel):
    name: str


@router.get("/setup-status")
async def setup_status(_: UserSession = Depends(require_auth)):
    """Return installation and server status (no auth required in dev mode)."""
    installed = ollama_bin() is not None
    running = await server_is_running()
    models = await installed_models() if running else []
    return {
        "installed": installed,
        "running": running,
        "installedModels": models,
        "available": running and len(models) > 0,
        "default": OLLAMA_DEFAULT_MODEL,
    }


@router.post("/setup")
async def setup_ollama(body: SetupRequest, _: UserSession = Depends(require_admin)):
    """
    Stream Ollama setup progress (SSE):
      1. brew install ollama (if needed)
      2. ollama serve (if not running)
      3. ollama pull <model> (if not already pulled)
      4. Update .env.local
    """
    model = body.model

    async def stream():
        env = shell_env()

        def evt(msg: str, kind: str = "log") -> str:
            return f"data: {json.dumps({'kind': kind, 'msg': msg})}\n\n"

        # ── Step 1 : Install Ollama ──────────────────────────────────────────
        ollama = ollama_bin()
        if not ollama:
            yield evt("🍺 Installation d'Ollama via Homebrew…", "step")
            brew = brew_bin()
            if not brew:
                yield evt(
                    "❌ Homebrew introuvable. Installez-le d'abord : https://brew.sh",
                    "error"
                )
                yield "data: [DONE]\n\n"
                return

            proc = await asyncio.create_subprocess_exec(
                brew, "install", "ollama",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=env,
            )
            async for raw in proc.stdout:
                line = raw.decode(errors="replace").rstrip()
                if line:
                    yield evt(line)
            await proc.wait()
            ollama = ollama_bin()
            if proc.returncode != 0 or not ollama:
                yield evt("❌ Échec de l'installation d'Ollama", "error")
                yield "data: [DONE]\n\n"
                return
            yield evt("✅ Ollama installé", "success")
        else:
            yield evt("✅ Ollama déjà installé", "success")

        # ── Step 2 : Start server ────────────────────────────────────────────
        if await server_is_running():
            yield evt("✅ Serveur Ollama déjà actif", "success")
        else:
            yield evt("🚀 Démarrage du serveur Ollama…", "step")
            # No shell — argv form only, so no injection surface even if the
            # `ollama` path ever contains unusual chars. Detached from our
            # process so it survives past the request.
            try:
                await asyncio.create_subprocess_exec(
                    ollama, "serve",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                    stdin=asyncio.subprocess.DEVNULL,
                )
            except OSError as e:
                yield evt(f"⚠️ Impossible de lancer {ollama} : {e}", "warn")
            ok = await wait_for_server(20)
            if ok:
                yield evt("✅ Serveur démarré", "success")
            else:
                yield evt("⚠️ Le serveur tarde à répondre — on continue quand même…", "warn")

        # ── Step 3 : Pull model ──────────────────────────────────────────────
        existing = await installed_models()
        already_have = any(m == model or m.startswith(model + ":") for m in existing)

        if already_have:
            yield evt(f"✅ {model} déjà présent", "success")
        else:
            yield evt(f"📥 Téléchargement de {model}…", "step")
            try:
                async with httpx.AsyncClient(timeout=None) as client:
                    async with client.stream(
                        "POST", f"{OLLAMA_URL}/api/pull",
                        json={"name": model},
                    ) as resp:
                        last_status = ""
                        async for line in resp.aiter_lines():
                            if not line:
                                continue
                            data = json.loads(line)
                            status = data.get("status", "")
                            total = data.get("total", 0)
                            completed = data.get("completed", 0)
                            if total > 0:
                                pct = int(completed / total * 100)
                                display = f"  {status} — {pct}%"
                            else:
                                display = f"  {status}"
                            if display != last_status:
                                yield evt(display)
                                last_status = display
            except Exception as e:
                yield evt(f"❌ Téléchargement échoué : {e}", "error")
                yield "data: [DONE]\n\n"
                return

        yield evt(f"✅ {model} prêt !", "success")

        # ── Step 4 : Update .env.local ───────────────────────────────────────
        env_path = find_env_local()
        if env_path:
            upsert_env_var(env_path, "OLLAMA_URL", OLLAMA_URL)
            upsert_env_var(env_path, "OLLAMA_DEFAULT_MODEL", model)
            yield evt(f"📝 .env.local mis à jour ({env_path.name})", "success")

        yield evt("done", "done")
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.get("/models")
async def list_models(_: UserSession = Depends(require_auth)):
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{OLLAMA_URL}/api/tags")
            resp.raise_for_status()
            raw = resp.json().get("models", [])
            models = [
                {
                    "name": m["name"],
                    "size": m.get("size", 0),
                    "modified": m.get("modified_at", ""),
                }
                for m in raw
            ]
            return {"models": models, "default": OLLAMA_DEFAULT_MODEL, "available": True, "starting": False}
    except Exception:
        # Auto-start Ollama if installed (non-blocking)
        if shutil.which('ollama'):
            asyncio.create_task(fire_ollama())
            return {"models": [], "default": OLLAMA_DEFAULT_MODEL, "available": False, "starting": True}
        return {"models": [], "default": OLLAMA_DEFAULT_MODEL, "available": False, "starting": False}


@router.delete("/models")
async def delete_model(body: DeleteModelRequest, _: UserSession = Depends(require_admin)):
    """Delete an installed Ollama model."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.request(
                "DELETE", f"{OLLAMA_URL}/api/delete",
                json={"name": body.name},
            )
            return {"ok": resp.status_code in (200, 204)}
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))


@router.post("/pull")
async def pull_model(body: PullModelRequest, _: UserSession = Depends(require_admin)):
    """Pull (download) an Ollama model. Streams progress via SSE."""
    async def stream():
        def evt(msg: str, kind: str = "log") -> str:
            return f"data: {json.dumps({'kind': kind, 'msg': msg})}\n\n"

        if not await server_is_running():
            yield evt("❌ Le serveur Ollama n'est pas démarré. Lance `ollama serve`.", "error")
            yield "data: [DONE]\n\n"
            return

        yield evt(f"📥 Téléchargement de {body.name}…", "step")
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "POST", f"{OLLAMA_URL}/api/pull",
                    json={"name": body.name},
                ) as resp:
                    last = ""
                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        data = json.loads(line)
                        status = data.get("status", "")
                        total = data.get("total", 0)
                        completed = data.get("completed", 0)
                        display = f"  {status} — {int(completed/total*100)}%" if total else f"  {status}"
                        if display != last:
                            yield evt(display)
                            last = display
            yield evt(f"✅ {body.name} installé !", "success")
            yield evt("done", "done")
        except Exception as e:
            yield evt(f"❌ Erreur : {e}", "error")
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")
