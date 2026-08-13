"""Shared helpers for the AI sub-routers: Ollama process/lifecycle, environment
detection, and the base system prompt.

Kept intentionally small — anything specific to one endpoint family (chat, RAG,
generation…) lives in that family's module."""
import os
import re
import shutil
import asyncio
import subprocess
from pathlib import Path
from typing import List, Optional

import httpx

from config import OLLAMA_URL


# Baked-in system prompt for the chat assistant. Users never see or edit this;
# their optional custom instructions (AIPanel settings) are appended after it.
BASE_SYSTEM_PROMPT = (
    "Tu es l'assistant intégré d'Alcove, un espace de travail personnel de prise de notes "
    "(canvas, documents Markdown, kanban, gantt, LaTeX). "
    "Réponds dans la langue de l'utilisateur (français par défaut). "
    "Sois concis et directement utile : va droit au but, sans préambule ni reformulation de la question. "
    "Formate tes réponses en Markdown (listes, **gras**, titres courts si pertinent). "
    "Quand tu fais référence à une note de l'utilisateur, utilise la syntaxe wikilink [[nom-de-la-note]]. "
    "Si tu n'es pas sûr d'une information, dis-le simplement plutôt que d'inventer."
)


# ── Ollama binary / env discovery ────────────────────────────────────────────

def ollama_bin() -> Optional[str]:
    """Find the ollama binary (handles M1 and Intel Macs)."""
    found = shutil.which("ollama")
    if found:
        return found
    for p in ("/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"):
        if os.path.exists(p):
            return p
    return None


def brew_bin() -> Optional[str]:
    found = shutil.which("brew")
    if found:
        return found
    for p in ("/opt/homebrew/bin/brew", "/usr/local/bin/brew"):
        if os.path.exists(p):
            return p
    return None


def shell_env() -> dict:
    """Return environ with Homebrew paths prepended."""
    env = os.environ.copy()
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + env.get("PATH", "")
    return env


def find_env_local() -> Optional[Path]:
    """Walk up from cwd until we find .env.local (max 5 levels)."""
    path = Path.cwd()
    for _ in range(6):
        candidate = path / ".env.local"
        if candidate.exists():
            return candidate
        parent = path.parent
        if parent == path:
            break
        path = parent
    return None


def upsert_env_var(env_path: Path, key: str, value: str) -> None:
    """Set or add KEY=VALUE in an .env file."""
    text = env_path.read_text() if env_path.exists() else ""
    pattern = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
    if pattern.search(text):
        text = pattern.sub(f"{key}={value}", text)
    else:
        text = text.rstrip("\n") + f"\n{key}={value}\n"
    env_path.write_text(text)


# ── Ollama server lifecycle ──────────────────────────────────────────────────

async def server_is_running() -> bool:
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{OLLAMA_URL}/api/tags")
            return r.status_code == 200
    except Exception:
        return False


async def wait_for_server(seconds: int = 20) -> bool:
    for _ in range(seconds):
        await asyncio.sleep(1)
        if await server_is_running():
            return True
    return False


_ollama_proc: subprocess.Popen | None = None


async def fire_ollama() -> bool:
    """Start ollama serve in background if installed and not already running."""
    global _ollama_proc
    if await server_is_running():
        return True
    if not shutil.which('ollama'):
        return False
    if _ollama_proc is not None and _ollama_proc.poll() is None:
        return True  # Already launched, wait for it
    try:
        _ollama_proc = subprocess.Popen(
            ['ollama', 'serve'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except Exception:
        return False


async def ensure_ollama_running(wait_seconds: int = 12) -> bool:
    """Start ollama if needed, then wait up to wait_seconds for it to be ready."""
    if await server_is_running():
        return True
    launched = await fire_ollama()
    if not launched:
        return False
    return await wait_for_server(wait_seconds)


async def installed_models() -> List[str]:
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{OLLAMA_URL}/api/tags")
            return [m["name"] for m in r.json().get("models", [])]
    except Exception:
        return []
