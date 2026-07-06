import json
import os
import re
import math
import shutil
import asyncio
import subprocess
from pathlib import Path
from uuid import UUID
import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select as _sa_select

from dependencies import UserSession, require_auth
from config import OLLAMA_URL, OLLAMA_DEFAULT_MODEL
from database.database import get_session
from database.models.pad_model import PadStore
from database.models.embedding_model import PadEmbedding
from database.models.conversation_model import AIConversation

ai_router = APIRouter(prefix="/api/ai")

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


# ── Conversation memory ─────────────────────────────────────────────────────────

class ConvMessage(BaseModel):
    role: str
    content: str


class ConvCreate(BaseModel):
    title: Optional[str] = None
    pad_id: Optional[str] = None
    messages: List[ConvMessage] = []


class ConvUpdate(BaseModel):
    title: Optional[str] = None
    messages: Optional[List[ConvMessage]] = None


def _derive_title(messages: List[ConvMessage]) -> str:
    """Use the first user message as the conversation title."""
    for m in messages:
        if m.role == "user" and m.content.strip():
            t = m.content.strip().replace("\n", " ")
            return (t[:60] + "…") if len(t) > 60 else t
    return "Nouvelle conversation"


@ai_router.get("/conversations")
async def list_conversations(
    pad_id: Optional[str] = None,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    pad_uuid = UUID(pad_id) if pad_id else None
    convs = await AIConversation.list_for_owner(session, user.id, pad_uuid)
    return {"conversations": [c.to_summary() for c in convs]}


@ai_router.get("/conversations/{conv_id}")
async def get_conversation(
    conv_id: str,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    conv = await AIConversation.get_owned(session, UUID(conv_id), user.id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation introuvable")
    return conv.to_dict()


@ai_router.post("/conversations")
async def create_conversation(
    body: ConvCreate,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    title = body.title or _derive_title(body.messages)
    conv = await AIConversation.create(
        session,
        owner_id=user.id,
        title=title,
        messages=[m.model_dump() for m in body.messages],
        pad_id=UUID(body.pad_id) if body.pad_id else None,
    )
    return conv.to_dict()


@ai_router.put("/conversations/{conv_id}")
async def update_conversation(
    conv_id: str,
    body: ConvUpdate,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    messages = [m.model_dump() for m in body.messages] if body.messages is not None else None
    conv = await AIConversation.update_owned(
        session, UUID(conv_id), user.id,
        title=body.title, messages=messages,
    )
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation introuvable")
    return conv.to_dict()


@ai_router.delete("/conversations/{conv_id}")
async def delete_conversation(
    conv_id: str,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    ok = await AIConversation.delete_owned(session, UUID(conv_id), user.id)
    if not ok:
        raise HTTPException(status_code=404, detail="Conversation introuvable")
    return {"deleted": True}


# ── Pydantic models ────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    model: Optional[str] = None
    messages: List[ChatMessage]
    custom_prompt: Optional[str] = None  # user-defined instructions layered on top of BASE_SYSTEM_PROMPT

class SummarizeRequest(BaseModel):
    model: Optional[str] = None
    content: str
    lang: Optional[str] = "fr"

class SuggestTagsRequest(BaseModel):
    model: Optional[str] = None
    content: str
    title: str
    lang: Optional[str] = "fr"

class SetupRequest(BaseModel):
    model: str = "llama3.2"

class IndexPadRequest(BaseModel):
    pad_id: str
    model: Optional[str] = None

class RagChatRequest(BaseModel):
    model: Optional[str] = None
    question: str
    top_k: int = 5
    lang: Optional[str] = "fr"

class SuggestLinksRequest(BaseModel):
    model: Optional[str] = None
    content: str
    pad_titles: List[str]
    lang: Optional[str] = "fr"

class GenerateFlashcardsRequest(BaseModel):
    model: Optional[str] = None
    content: str
    lang: Optional[str] = "fr"


# ── Helpers ────────────────────────────────────────────────────────────────────

def _ollama_bin() -> Optional[str]:
    """Find the ollama binary (handles M1 and Intel Macs)."""
    found = shutil.which("ollama")
    if found:
        return found
    for p in ("/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"):
        if os.path.exists(p):
            return p
    return None

def _brew_bin() -> Optional[str]:
    found = shutil.which("brew")
    if found:
        return found
    for p in ("/opt/homebrew/bin/brew", "/usr/local/bin/brew"):
        if os.path.exists(p):
            return p
    return None

def _shell_env() -> dict:
    """Return environ with Homebrew paths prepended."""
    env = os.environ.copy()
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + env.get("PATH", "")
    return env

def _find_env_local() -> Optional[Path]:
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

def _upsert_env_var(env_path: Path, key: str, value: str) -> None:
    """Set or add KEY=VALUE in an .env file."""
    text = env_path.read_text() if env_path.exists() else ""
    pattern = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
    if pattern.search(text):
        text = pattern.sub(f"{key}={value}", text)
    else:
        text = text.rstrip("\n") + f"\n{key}={value}\n"
    env_path.write_text(text)

async def _server_is_running() -> bool:
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{OLLAMA_URL}/api/tags")
            return r.status_code == 200
    except Exception:
        return False

async def _wait_for_server(seconds: int = 20) -> bool:
    for _ in range(seconds):
        await asyncio.sleep(1)
        if await _server_is_running():
            return True
    return False

_ollama_proc: subprocess.Popen | None = None

async def _fire_ollama() -> bool:
    """Start ollama serve in background if installed and not already running."""
    global _ollama_proc
    if await _server_is_running():
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

async def _ensure_ollama_running(wait_seconds: int = 12) -> bool:
    """Start ollama if needed, then wait up to wait_seconds for it to be ready."""
    if await _server_is_running():
        return True
    launched = await _fire_ollama()
    if not launched:
        return False
    return await _wait_for_server(wait_seconds)

async def _installed_models() -> List[str]:
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{OLLAMA_URL}/api/tags")
            return [m["name"] for m in r.json().get("models", [])]
    except Exception:
        return []


# ── Endpoints ──────────────────────────────────────────────────────────────────

@ai_router.get("/setup-status")
async def setup_status(_: UserSession = Depends(require_auth)):
    """Return installation and server status (no auth required in dev mode)."""
    installed = _ollama_bin() is not None
    running = await _server_is_running()
    models = await _installed_models() if running else []
    return {
        "installed": installed,
        "running": running,
        "installedModels": models,
        "available": running and len(models) > 0,
        "default": OLLAMA_DEFAULT_MODEL,
    }


@ai_router.post("/setup")
async def setup_ollama(body: SetupRequest, _: UserSession = Depends(require_auth)):
    """
    Stream Ollama setup progress (SSE):
      1. brew install ollama (if needed)
      2. ollama serve (if not running)
      3. ollama pull <model> (if not already pulled)
      4. Update .env.local
    """
    model = body.model

    async def stream():
        env = _shell_env()

        def evt(msg: str, kind: str = "log") -> str:
            return f"data: {json.dumps({'kind': kind, 'msg': msg})}\n\n"

        # ── Step 1 : Install Ollama ──────────────────────────────────────────
        ollama = _ollama_bin()
        if not ollama:
            yield evt("🍺 Installation d'Ollama via Homebrew…", "step")
            brew = _brew_bin()
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
            ollama = _ollama_bin()
            if proc.returncode != 0 or not ollama:
                yield evt("❌ Échec de l'installation d'Ollama", "error")
                yield "data: [DONE]\n\n"
                return
            yield evt("✅ Ollama installé", "success")
        else:
            yield evt("✅ Ollama déjà installé", "success")

        # ── Step 2 : Start server ────────────────────────────────────────────
        if await _server_is_running():
            yield evt("✅ Serveur Ollama déjà actif", "success")
        else:
            yield evt("🚀 Démarrage du serveur Ollama…", "step")
            asyncio.get_event_loop().run_in_executor(
                None,
                lambda: os.system(f"{ollama} serve &>/dev/null &")
            )
            ok = await _wait_for_server(20)
            if ok:
                yield evt("✅ Serveur démarré", "success")
            else:
                yield evt("⚠️ Le serveur tarde à répondre — on continue quand même…", "warn")

        # ── Step 3 : Pull model ──────────────────────────────────────────────
        existing = await _installed_models()
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
        env_path = _find_env_local()
        if env_path:
            _upsert_env_var(env_path, "OLLAMA_URL", OLLAMA_URL)
            _upsert_env_var(env_path, "OLLAMA_DEFAULT_MODEL", model)
            yield evt(f"📝 .env.local mis à jour ({env_path.name})", "success")

        yield evt("done", "done")
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@ai_router.get("/models")
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
            asyncio.create_task(_fire_ollama())
            return {"models": [], "default": OLLAMA_DEFAULT_MODEL, "available": False, "starting": True}
        return {"models": [], "default": OLLAMA_DEFAULT_MODEL, "available": False, "starting": False}


class DeleteModelRequest(BaseModel):
    name: str

class PullModelRequest(BaseModel):
    name: str

@ai_router.delete("/models")
async def delete_model(body: DeleteModelRequest, _: UserSession = Depends(require_auth)):
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


@ai_router.post("/pull")
async def pull_model(body: PullModelRequest, _: UserSession = Depends(require_auth)):
    """Pull (download) an Ollama model. Streams progress via SSE."""
    async def stream():
        def evt(msg: str, kind: str = "log") -> str:
            return f"data: {json.dumps({'kind': kind, 'msg': msg})}\n\n"

        if not await _server_is_running():
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


@ai_router.post("/chat")
async def chat_stream(body: ChatRequest, _: UserSession = Depends(require_auth)):
    model = body.model or OLLAMA_DEFAULT_MODEL
    # Single merged system message: hidden base prompt, then the user's custom
    # instructions, then any per-request system context sent by the frontend
    # (e.g. the open document for quick actions)
    system = BASE_SYSTEM_PROMPT
    if body.custom_prompt and body.custom_prompt.strip():
        system += f"\n\nInstructions supplémentaires de l'utilisateur :\n{body.custom_prompt.strip()[:2000]}"
    client_system = [m.content for m in body.messages if m.role == "system"]
    if client_system:
        system += "\n\n" + "\n\n".join(client_system)
    messages = [{"role": "system", "content": system}]
    messages += [{"role": m.role, "content": m.content} for m in body.messages if m.role != "system"]

    async def stream():
        if not await _server_is_running():
            if not shutil.which('ollama'):
                yield f"data: {json.dumps({'error': 'Ollama non installé. Télécharge-le sur ollama.com'})}\n\n"
                yield "data: [DONE]\n\n"
                return
            running = await _ensure_ollama_running(12)
            if not running:
                yield f"data: {json.dumps({'error': 'Impossible de démarrer Ollama automatiquement.'})}\n\n"
                yield "data: [DONE]\n\n"
                return
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "POST", f"{OLLAMA_URL}/api/chat",
                    json={"model": model, "messages": messages, "stream": True},
                ) as resp:
                    async for line in resp.aiter_lines():
                        if line:
                            yield f"data: {line}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@ai_router.post("/summarize")
async def summarize(body: SummarizeRequest, _: UserSession = Depends(require_auth)):
    model = body.model or OLLAMA_DEFAULT_MODEL
    lang_instr = "in French" if body.lang == "fr" else "in English"
    prompt = (
        f"Summarize the following document concisely {lang_instr}, "
        f"in 3-5 bullet points. Do not add any preamble.\n\n{body.content[:8000]}"
    )

    async def stream():
        if not await _server_is_running():
            if not await _ensure_ollama_running(12):
                yield f"data: {json.dumps({'error': 'Impossible de démarrer Ollama.'})}\n\n"
                yield "data: [DONE]\n\n"
                return
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "POST", f"{OLLAMA_URL}/api/chat",
                    json={"model": model, "messages": [{"role": "user", "content": prompt}], "stream": True},
                ) as resp:
                    async for line in resp.aiter_lines():
                        if line:
                            yield f"data: {line}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@ai_router.post("/suggest-tags")
async def suggest_tags(body: SuggestTagsRequest, _: UserSession = Depends(require_auth)):
    model = body.model or OLLAMA_DEFAULT_MODEL
    lang_instr = "in French" if body.lang == "fr" else "in English"
    prompt = (
        f"Given the document titled \"{body.title}\" with content below, "
        f"suggest 3 to 5 short lowercase tags {lang_instr} (single words or hyphenated). "
        f"Reply ONLY with a JSON array of strings, nothing else.\n\n{body.content[:4000]}"
    )
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{OLLAMA_URL}/api/chat",
                json={"model": model, "messages": [{"role": "user", "content": prompt}], "stream": False},
            )
            resp.raise_for_status()
            raw = resp.json().get("message", {}).get("content", "[]")
            start, end = raw.find("["), raw.rfind("]") + 1
            if start >= 0 and end > start:
                tags = json.loads(raw[start:end])
                return {"tags": [t.lower().strip() for t in tags if isinstance(t, str)]}
            return {"tags": []}
    except Exception as e:
        return {"tags": [], "error": str(e)}


class TitleRequest(BaseModel):
    model: Optional[str] = None
    content: str
    lang: Optional[str] = "fr"


@ai_router.post("/title")
async def suggest_title(body: TitleRequest, _: UserSession = Depends(require_auth)):
    """Generate a short pad title from its content."""
    model = body.model or OLLAMA_DEFAULT_MODEL
    lang_instr = "en français" if body.lang == "fr" else "in English"
    prompt = (
        f"Propose un titre court (3 à 6 mots, {lang_instr}) pour le document ci-dessous. "
        f"Réponds UNIQUEMENT avec le titre, sans guillemets, sans ponctuation finale, sans préambule.\n\n"
        f"{body.content[:4000]}"
    )
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{OLLAMA_URL}/api/chat",
                json={"model": model, "messages": [{"role": "user", "content": prompt}], "stream": False},
            )
            resp.raise_for_status()
            raw = resp.json().get("message", {}).get("content", "")
            # deepseek-style models wrap reasoning in <think> tags
            raw = re.sub(r"<think>[\s\S]*?</think>", "", raw).strip()
            title = raw.strip().strip('"\'' ).splitlines()[0][:80] if raw.strip() else ""
            return {"title": title}
    except Exception as e:
        return {"title": "", "error": str(e)}


# ── Web clipper ────────────────────────────────────────────────────────────────

class ClipRequest(BaseModel):
    url: str


class _MarkdownExtractor:
    """Minimal readability: walks the HTML and emits Markdown for content tags,
    skipping chrome (nav/header/footer/aside/script/form...). Stdlib only."""

    SKIP = {"script", "style", "nav", "footer", "header", "aside", "form",
            "iframe", "noscript", "svg", "button", "select"}
    BLOCK = {"h1": "# ", "h2": "## ", "h3": "### ", "h4": "#### ",
             "h5": "##### ", "h6": "###### ", "li": "- ", "blockquote": "> "}

    def __init__(self):
        from html.parser import HTMLParser

        extractor = self

        class Parser(HTMLParser):
            def __init__(self):
                super().__init__(convert_charrefs=True)
                self.skip_depth = 0
                self.pre_depth = 0
                self.href: Optional[str] = None
                self.out: list[str] = []
                self.buf: list[str] = []
                self.block_prefix = ""
                self.title = ""
                self.in_title = False

            def flush(self):
                text = "".join(self.buf).strip()
                self.buf = []
                if text:
                    self.out.append(f"{self.block_prefix}{text}")
                self.block_prefix = ""

            def handle_starttag(self, tag, attrs):
                if tag in extractor.SKIP:
                    self.skip_depth += 1
                    return
                if self.skip_depth:
                    return
                if tag == "title":
                    self.in_title = True
                elif tag == "pre":
                    self.flush()
                    self.pre_depth += 1
                    self.out.append("```")
                elif tag in extractor.BLOCK:
                    self.flush()
                    self.block_prefix = extractor.BLOCK[tag]
                elif tag in ("p", "div", "section", "article", "tr", "br"):
                    self.flush()
                elif tag == "a":
                    self.href = dict(attrs).get("href")
                    if self.href and not self.href.startswith("http"):
                        self.href = None
                    if self.href:
                        self.buf.append("[")
                elif tag in ("strong", "b"):
                    self.buf.append("**")
                elif tag in ("em", "i"):
                    self.buf.append("*")
                elif tag == "code" and not self.pre_depth:
                    self.buf.append("`")

            def handle_endtag(self, tag):
                if tag in extractor.SKIP:
                    self.skip_depth = max(0, self.skip_depth - 1)
                    return
                if self.skip_depth:
                    return
                if tag == "title":
                    self.in_title = False
                elif tag == "pre":
                    self.flush()
                    self.pre_depth = max(0, self.pre_depth - 1)
                    self.out.append("```")
                elif tag in extractor.BLOCK or tag in ("p", "div", "section", "article", "tr"):
                    self.flush()
                elif tag == "a" and self.href:
                    self.buf.append(f"]({self.href})")
                    self.href = None
                elif tag in ("strong", "b"):
                    self.buf.append("**")
                elif tag in ("em", "i"):
                    self.buf.append("*")
                elif tag == "code" and not self.pre_depth:
                    self.buf.append("`")

            def handle_data(self, data):
                if self.skip_depth:
                    return
                if self.in_title and not self.title:
                    self.title = data.strip()
                    return
                if self.pre_depth:
                    self.out.append(data.rstrip("\n"))
                else:
                    self.buf.append(data)

        self.parser = Parser()

    def extract(self, html: str) -> tuple[str, str]:
        self.parser.feed(html)
        self.parser.flush()
        lines = [l for l in self.parser.out if l.strip()]
        return self.parser.title, "\n\n".join(lines)


@ai_router.post("/clip")
async def clip_url(body: ClipRequest, _: UserSession = Depends(require_auth)):
    """Fetch a web page and return its main content as Markdown."""
    url = body.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="URL invalide (http/https uniquement)")
    # GitHub blob pages: fetch the raw file instead of the HTML viewer
    gh = re.match(r"https://github\.com/([^/]+/[^/]+)/blob/(.+)", url)
    if gh:
        url = f"https://raw.githubusercontent.com/{gh.group(1)}/{gh.group(2)}"
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
            resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0 (alcove clipper)"})
            resp.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Impossible de récupérer la page : {e}")

    content_type = resp.headers.get("content-type", "")
    if "html" not in content_type:
        # Raw text/markdown file — return as-is
        return {"title": url.rsplit("/", 1)[-1], "markdown": resp.text[:100_000], "url": body.url}

    title, markdown = _MarkdownExtractor().extract(resp.text[:1_500_000])
    if len(markdown) > 100_000:
        markdown = markdown[:100_000] + "\n\n*[contenu tronqué]*"
    return {"title": title or url, "markdown": markdown, "url": body.url}


# ── RAG helpers ────────────────────────────────────────────────────────────────

_EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")
_CHUNK_SIZE = 400   # tokens ≈ chars / 4, so ~1600 chars
_CHUNK_OVERLAP = 60


def _extract_text_from_pad(pad: PadStore) -> str:
    """Extract searchable text from a pad (document or canvas)."""
    pad_type = getattr(pad, "pad_type", "canvas") or "canvas"
    data = pad.data or {}
    if pad_type == "document":
        return data.get("content", "")
    # Canvas: collect text elements
    elements = data.get("elements", [])
    parts = []
    for el in elements:
        t = el.get("text", "").strip()
        if t:
            parts.append(t)
    return "\n".join(parts)


def _chunk_text(text: str, size: int = _CHUNK_SIZE, overlap: int = _CHUNK_OVERLAP) -> list[str]:
    words = text.split()
    if not words:
        return []
    chunks, i = [], 0
    while i < len(words):
        chunk = " ".join(words[i:i + size])
        if chunk.strip():
            chunks.append(chunk)
        i += size - overlap
    return chunks


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


async def _embed(text: str, model: str = _EMBED_MODEL) -> list[float]:
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            f"{OLLAMA_URL}/api/embeddings",
            json={"model": model, "prompt": text},
        )
        resp.raise_for_status()
        return resp.json()["embedding"]


async def _embed_model_available(model: str = _EMBED_MODEL) -> bool:
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{OLLAMA_URL}/api/tags")
            resp.raise_for_status()
            names = [m["name"] for m in resp.json().get("models", [])]
            # Accept any variant: "nomic-embed-text:latest" matches "nomic-embed-text"
            return any(n.split(":")[0] == model.split(":")[0] for n in names)
    except Exception:
        return False


# ── RAG endpoints ──────────────────────────────────────────────────────────────

@ai_router.post("/index")
async def index_pad(
    body: IndexPadRequest,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """Generate and store embeddings for a single pad."""
    embed_model = body.model or _EMBED_MODEL

    stmt = _sa_select(PadStore).where(
        PadStore.id == UUID(body.pad_id),
        PadStore.owner_id == user.id,
    )
    result = await session.execute(stmt)
    pad = result.scalar_one_or_none()
    if not pad:
        raise HTTPException(404, "Pad not found")

    text = _extract_text_from_pad(pad)
    chunks = _chunk_text(text)
    if not chunks:
        await PadEmbedding.delete_for_pad(session, pad.id)
        await session.commit()
        return {"indexed": 0}

    chunk_data = []
    for idx, chunk in enumerate(chunks):
        vec = await _embed(chunk, embed_model)
        chunk_data.append((idx, chunk, vec))

    await PadEmbedding.upsert_chunks(session, pad.id, chunk_data)
    await session.commit()
    return {"indexed": len(chunk_data)}


@ai_router.post("/index-all")
async def index_all_pads(
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """Index all pads for the current user (streaming progress via SSE)."""
    async def stream():
        def evt(msg: str, kind: str = "log") -> str:
            return f"data: {json.dumps({'kind': kind, 'msg': msg})}\n\n"

        stmt = _sa_select(PadStore).where(PadStore.owner_id == user.id)
        result = await session.execute(stmt)
        pads = list(result.scalars().all())

        total = len(pads)
        yield evt(f"📚 Indexation de {total} pads…", "step")

        indexed = 0
        for i, pad in enumerate(pads):
            text = _extract_text_from_pad(pad)
            chunks = _chunk_text(text)
            if chunks:
                chunk_data = []
                for idx, chunk in enumerate(chunks):
                    vec = await _embed(chunk)
                    chunk_data.append((idx, chunk, vec))
                await PadEmbedding.upsert_chunks(session, pad.id, chunk_data)
                await session.commit()
                indexed += 1
            yield evt(f"  [{i+1}/{total}] {pad.display_name} — {len(chunks)} chunks")

        yield evt(f"✅ {indexed} pads indexés", "success")
        yield evt("done", "done")
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@ai_router.post("/semantic-search")
async def semantic_search(
    body: RagChatRequest,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """Find the top-k most relevant pad chunks for a question."""
    q_vec = await _embed(body.question)

    rows = await PadEmbedding.get_all(session)
    if not rows:
        return {"results": []}

    # Load pad metadata for display
    pad_ids = list({r.pad_id for r in rows})
    stmt = _sa_select(PadStore).where(
        PadStore.id.in_(pad_ids),
        PadStore.owner_id == user.id,
    )
    result = await session.execute(stmt)
    pads_by_id = {p.id: p for p in result.scalars().all()}

    scored = []
    for row in rows:
        if row.pad_id not in pads_by_id:
            continue
        score = _cosine(q_vec, row.embedding)
        scored.append((score, row))

    scored.sort(key=lambda x: x[0], reverse=True)
    top = scored[:body.top_k]

    return {
        "results": [
            {
                "score": round(score, 4),
                "pad_id": str(row.pad_id),
                "pad_name": pads_by_id[row.pad_id].display_name,
                "excerpt": row.chunk_text[:300],
            }
            for score, row in top
            if score > 0.3
        ]
    }


@ai_router.post("/rag-chat")
async def rag_chat(
    body: RagChatRequest,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """RAG-augmented chat: retrieves relevant chunks, then answers via Ollama."""
    model = OLLAMA_DEFAULT_MODEL

    # 1. Embed question & retrieve top-k chunks
    q_vec = await _embed(body.question)
    rows = await PadEmbedding.get_all(session)

    pad_ids = list({r.pad_id for r in rows})
    pads_by_id: dict = {}
    if pad_ids:
        stmt = _sa_select(PadStore).where(
            PadStore.id.in_(pad_ids),
            PadStore.owner_id == user.id,
        )
        result = await session.execute(stmt)
        pads_by_id = {p.id: p for p in result.scalars().all()}

    scored = sorted(
        [((_cosine(q_vec, r.embedding), r)) for r in rows if r.pad_id in pads_by_id],
        key=lambda x: x[0], reverse=True,
    )
    top = [(s, r) for s, r in scored[:body.top_k] if s > 0.3]

    # 2. Build context
    if top:
        ctx_parts = []
        for score, row in top:
            pad_name = pads_by_id[row.pad_id].display_name
            ctx_parts.append(f"[{pad_name}]\n{row.chunk_text}")
        context = "\n\n---\n\n".join(ctx_parts)
        if body.lang == "fr":
            system = (
                "Tu es un assistant qui répond aux questions en te basant sur les notes de l'utilisateur.\n"
                "Voici les extraits pertinents de ses notes :\n\n"
                f"{context}\n\n"
                "Réponds en français, de façon concise et précise. "
                "Cite les noms des notes sources entre crochets quand tu les utilises."
            )
        else:
            system = (
                "You are an assistant that answers questions based on the user's notes.\n"
                "Here are the relevant excerpts:\n\n"
                f"{context}\n\n"
                "Answer concisely. Cite source note names in brackets when you use them."
            )
    else:
        if body.lang == "fr":
            system = "Tu es un assistant. Aucune note pertinente n'a été trouvée pour cette question."
        else:
            system = "You are an assistant. No relevant notes were found for this question."

    sources = [
        {"pad_id": str(r.pad_id), "pad_name": pads_by_id[r.pad_id].display_name, "score": round(s, 3)}
        for s, r in top
    ]

    async def stream():
        # First emit the sources metadata
        yield f"data: {json.dumps({'kind': 'sources', 'sources': sources})}\n\n"

        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": body.question},
        ]
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST", f"{OLLAMA_URL}/api/chat",
                json={"model": model, "messages": messages, "stream": True},
            ) as resp:
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    data = json.loads(line)
                    token = data.get("message", {}).get("content", "")
                    if token:
                        yield f"data: {json.dumps({'message': {'content': token}})}\n\n"
                    if data.get("done"):
                        yield "data: [DONE]\n\n"
                        return

    return StreamingResponse(stream(), media_type="text/event-stream")


@ai_router.post("/suggest-links")
async def suggest_links(body: SuggestLinksRequest, _: UserSession = Depends(require_auth)):
    """Suggest [[wiki links]] to other pads based on document content."""
    model = OLLAMA_DEFAULT_MODEL
    titles_list = "\n".join(f"- {t}" for t in body.pad_titles[:100])

    if body.lang == "fr":
        prompt = (
            f"Voici une liste de notes disponibles :\n{titles_list}\n\n"
            f"Voici le contenu d'une note :\n{body.content[:3000]}\n\n"
            "Identifie les notes de la liste qui sont pertinentes à citer dans cette note "
            "sous forme de liens [[NomDeLaNote]]. "
            "Réponds UNIQUEMENT avec un tableau JSON de strings, ex: [\"NomNote1\", \"NomNote2\"]. "
            "Maximum 5 suggestions. Si aucune n'est pertinente, retourne []."
        )
    else:
        prompt = (
            f"Here is a list of available notes:\n{titles_list}\n\n"
            f"Here is a note's content:\n{body.content[:3000]}\n\n"
            "Identify notes from the list that are relevant to cite in this note "
            "as [[NoteName]] links. "
            "Reply ONLY with a JSON array of strings, e.g. [\"Note1\", \"Note2\"]. "
            "Max 5 suggestions. If none are relevant, return []."
        )

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{OLLAMA_URL}/api/chat",
                json={"model": model, "messages": [{"role": "user", "content": prompt}], "stream": False},
            )
            raw = resp.json().get("message", {}).get("content", "")
            start, end = raw.find("["), raw.rfind("]") + 1
            if start >= 0 and end > start:
                suggestions = json.loads(raw[start:end])
                # Only return titles that actually exist
                valid = [s for s in suggestions if s in body.pad_titles]
                return {"suggestions": valid[:5]}
            return {"suggestions": []}
    except Exception as e:
        return {"suggestions": [], "error": str(e)}


class QuizExtractRequest(BaseModel):
    pad_ids: List[str]

class QuizGenerateRequest(BaseModel):
    pad_ids: List[str]
    topic: Optional[str] = None
    lang: Optional[str] = "fr"
    n: Optional[int] = 8


@ai_router.post("/quiz/extract")
async def quiz_extract(body: QuizExtractRequest, user: UserSession = Depends(require_auth), session: AsyncSession = Depends(get_session)):
    """Extract existing Q:/A: pairs from multiple document pads."""
    result = []
    for pid_str in body.pad_ids:
        try:
            pid = UUID(pid_str)
        except Exception:
            continue
        stmt = _sa_select(PadStore).where(PadStore.id == pid, PadStore.owner_id == user.id)
        row = (await session.execute(stmt)).scalar_one_or_none()
        if not row or row.pad_type != "document":
            continue
        if isinstance(row.data, dict):
            content = row.data.get("content", "")
        elif isinstance(row.data, str):
            try:
                content = json.loads(row.data).get("content", "")
            except Exception:
                content = ""
        else:
            content = ""
        pairs = []
        for m in re.finditer(r'^Q:[ \t]*(.+?)\n^A:[ \t]*(.+)', content, re.MULTILINE):
            pairs.append({"q": m.group(1).strip(), "a": m.group(2).strip()})
        if pairs:
            result.append({"padId": str(row.id), "padName": row.display_name or "Sans titre", "cards": pairs})
    return {"decks": result}


@ai_router.post("/quiz/generate")
async def quiz_generate(body: QuizGenerateRequest, user: UserSession = Depends(require_auth), session: AsyncSession = Depends(get_session)):
    """AI-generate Q:/A: flashcards from multiple document pads."""
    import json as _json
    contents = []
    for pid_str in body.pad_ids:
        try:
            pid = UUID(pid_str)
        except Exception:
            continue
        stmt = _sa_select(PadStore).where(PadStore.id == pid, PadStore.owner_id == user.id)
        row = (await session.execute(stmt)).scalar_one_or_none()
        if not row or row.pad_type != "document":
            continue
        content = ""
        if isinstance(row.data, dict):
            content = row.data.get("content", "")
        elif isinstance(row.data, str):
            try:
                content = _json.loads(row.data).get("content", "")
            except Exception:
                content = ""
        if content:
            contents.append(f"=== {row.display_name or 'Sans titre'} ===\n{content[:2000]}")

    if not contents:
        return {"flashcards": "", "error": "Aucun contenu document trouvé"}

    combined = "\n\n".join(contents)[:5000]
    n = min(body.n or 8, 20)
    topic_hint = f" sur le sujet '{body.topic}'" if body.topic else ""

    if body.lang == "fr":
        prompt = (
            f"Voici le contenu de plusieurs notes :\n\n{combined}\n\n"
            f"Génère exactement {n} flashcards pédagogiques{topic_hint} sous ce format EXACT :\n\n"
            "Q: [question claire et concise]\nA: [réponse courte et précise]\n\n"
            "Génère uniquement les paires Q:/A:, sans introduction ni commentaire."
        )
    else:
        prompt = (
            f"Here is the content of several notes:\n\n{combined}\n\n"
            f"Generate exactly {n} educational flashcards{topic_hint} in this EXACT format:\n\n"
            "Q: [clear question]\nA: [short answer]\n\n"
            "Output only Q:/A: pairs, no intro."
        )

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{OLLAMA_URL}/api/chat",
                json={"model": OLLAMA_DEFAULT_MODEL, "messages": [{"role": "user", "content": prompt}], "stream": False},
            )
            raw = resp.json().get("message", {}).get("content", "")
            if "Q:" in raw and "A:" in raw:
                return {"flashcards": raw.strip()}
            return {"flashcards": "", "error": "Pas de flashcards générées"}
    except Exception as e:
        return {"flashcards": "", "error": str(e)}


@ai_router.post("/generate-flashcards")
async def generate_flashcards(body: GenerateFlashcardsRequest, _: UserSession = Depends(require_auth)):
    """Generate Q:/A: flashcard blocks from document content."""
    model = OLLAMA_DEFAULT_MODEL

    if body.lang == "fr":
        prompt = (
            f"Voici le contenu d'une note :\n\n{body.content[:4000]}\n\n"
            "Génère entre 3 et 8 flashcards pédagogiques sous ce format EXACT "
            "(respecte bien les préfixes Q: et A: en début de ligne) :\n\n"
            "Q: [question claire et concise]\n"
            "A: [réponse courte et précise]\n\n"
            "Génère uniquement les paires Q:/A:, sans introduction ni commentaire."
        )
    else:
        prompt = (
            f"Here is a note's content:\n\n{body.content[:4000]}\n\n"
            "Generate between 3 and 8 educational flashcards in this EXACT format "
            "(keep Q: and A: at the start of each line):\n\n"
            "Q: [clear, concise question]\n"
            "A: [short, precise answer]\n\n"
            "Output only the Q:/A: pairs, no intro or commentary."
        )

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{OLLAMA_URL}/api/chat",
                json={"model": model, "messages": [{"role": "user", "content": prompt}], "stream": False},
            )
            raw = resp.json().get("message", {}).get("content", "")
            # Validate: must contain at least one Q:/A: pair
            if "Q:" in raw and "A:" in raw:
                return {"flashcards": raw.strip()}
            return {"flashcards": "", "error": "No flashcards generated"}
    except Exception as e:
        return {"flashcards": "", "error": str(e)}


class GenerateDiagramRequest(BaseModel):
    model: Optional[str] = None
    content: str
    kind: Optional[str] = None  # e.g. "flowchart", "sequence", "mindmap" — free text hint, optional
    lang: Optional[str] = "fr"


_MERMAID_KINDS = "flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, mindmap, or pie"


@ai_router.post("/generate-diagram")
async def generate_diagram(body: GenerateDiagramRequest, _: UserSession = Depends(require_auth)):
    """Generate a Mermaid diagram (as a ```mermaid code block) from document content."""
    model = body.model or OLLAMA_DEFAULT_MODEL
    kind_instr = f"Use a Mermaid \"{body.kind}\" diagram." if body.kind else f"Pick whichever Mermaid diagram type ({_MERMAID_KINDS}) best represents this content."

    if body.lang == "fr":
        prompt = (
            f"Voici le contenu d'une note :\n\n{body.content[:4000]}\n\n"
            f"Génère un diagramme Mermaid qui représente visuellement les idées, étapes ou relations clés de ce contenu. {kind_instr}\n"
            "Réponds UNIQUEMENT avec un bloc de code markdown ```mermaid ... ```, sans aucun texte avant ou après."
        )
    else:
        prompt = (
            f"Here is a note's content:\n\n{body.content[:4000]}\n\n"
            f"Generate a Mermaid diagram that visually represents the key ideas, steps, or relationships in this content. {kind_instr}\n"
            "Reply ONLY with a ```mermaid ... ``` markdown code block, no text before or after."
        )

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{OLLAMA_URL}/api/chat",
                json={"model": model, "messages": [{"role": "user", "content": prompt}], "stream": False},
            )
            resp.raise_for_status()
            raw = resp.json().get("message", {}).get("content", "")
            raw = re.sub(r"<think>[\s\S]*?</think>", "", raw).strip()
            m = re.search(r"```mermaid\s*\n([\s\S]*?)```", raw)
            diagram = m.group(1).strip() if m else raw.strip()
            if not diagram:
                return {"diagram": "", "error": "No diagram generated"}
            return {"diagram": f"```mermaid\n{diagram}\n```"}
    except Exception as e:
        return {"diagram": "", "error": str(e)}
