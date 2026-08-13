"""Wiki-LLM style agent memory.

The idea: instead of accumulating opaque chat history, the assistant keeps a
tiny handful of *editable* markdown pads (a "wiki") that hold durable facts
about the user and their projects. These pads:

  - Live under folder="_agent" on regular document pads (nothing new in the DB)
  - Have fixed slugs so the model knows what to write to (profile / preferences
    / projets)
  - Are auto-injected into every chat/rag system prompt
  - Are only ever written after user confirmation — the extract endpoint
    proposes, the UI accepts, the write endpoint records a PadVersion first so
    every change is undoable via the existing history.
"""
import re
import json
from uuid import UUID
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select as sa_select
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import UserSession, require_auth
from config import OLLAMA_URL, OLLAMA_DEFAULT_MODEL
from database.database import get_session
from database.models.pad_model import PadStore
from database.models.version_model import PadVersion


router = APIRouter()


AGENT_FOLDER = "_agent"

# Ordered — the UI shows them in this order and the LLM sees them in this order.
MEMORY_SLOTS: list[dict] = [
    {
        "slug": "profile",
        "display_name": "Profil",
        "purpose": "Qui est l'utilisateur : rôle, contexte, ce sur quoi il travaille en général.",
        "seed": "# Profil\n\n_Ce document est édité par l'assistant IA au fil des conversations._\n\n",
    },
    {
        "slug": "preferences",
        "display_name": "Préférences",
        "purpose": "Comment l'utilisateur aime que l'assistant réponde : longueur, ton, format, langue.",
        "seed": "# Préférences\n\n_Édité par l'assistant IA quand tu confirmes une préférence._\n\n",
    },
    {
        "slug": "projets",
        "display_name": "Projets",
        "purpose": "Projets en cours, objectifs, décisions prises. Une section par projet.",
        "seed": "# Projets\n\n_L'assistant ajoute ici les projets dont tu parles._\n\n",
    },
]

_VALID_SLUGS = {s["slug"] for s in MEMORY_SLOTS}
_SLOT_BY_SLUG = {s["slug"]: s for s in MEMORY_SLOTS}


# ── Pad lookup / creation ────────────────────────────────────────────────────

async def _get_memory_pad(
    session: AsyncSession, owner_id: UUID, slug: str, create: bool = False,
) -> Optional[PadStore]:
    """Look up the agent-memory pad by (owner, folder, display_name).

    display_name doubles as the human title AND the slug key — we normalize on
    the seed's slug ("profile", "preferences", "projets") so lookups are exact.
    """
    slot = _SLOT_BY_SLUG.get(slug)
    if slot is None:
        return None
    stmt = sa_select(PadStore).where(
        PadStore.owner_id == owner_id,
        PadStore.folder == AGENT_FOLDER,
        PadStore.display_name == slug,
    )
    pad = (await session.execute(stmt)).scalar_one_or_none()
    if pad is None and create:
        pad = PadStore(
            owner_id=owner_id,
            display_name=slug,
            data={"content": slot["seed"], "format": "markdown"},
            pad_type="document",
            folder=AGENT_FOLDER,
            tags=["agent-memory"],
        )
        session.add(pad)
        await session.commit()
        await session.refresh(pad)
    return pad


async def _read_all_memory(session: AsyncSession, owner_id: UUID) -> dict[str, dict]:
    """Return {slug: {content, pad_id, display_name, updated_at}} for every slot.

    IMPORTANT: this is READ-ONLY — it never creates pads. Empty slots are
    returned with pad_id=None and empty content. Pads are only materialised
    when the user explicitly accepts a proposal (in write_memory), so the
    sidebar stays clean until the memory is actually used.
    """
    out = {}
    for slot in MEMORY_SLOTS:
        pad = await _get_memory_pad(session, owner_id, slot["slug"], create=False)
        content = ""
        if pad and isinstance(pad.data, dict):
            content = pad.data.get("content", "") or ""
        out[slot["slug"]] = {
            "slug": slot["slug"],
            "display_name": slot["display_name"],
            "content": content,
            "pad_id": str(pad.id) if pad else None,
            "updated_at": pad.updated_at.isoformat() if pad and pad.updated_at else None,
        }
    return out


# ── System-prompt injection ──────────────────────────────────────────────────

async def load_memory_prompt_block(session: AsyncSession, owner_id: UUID) -> str:
    """Compact memory block for the chat system prompt. Empty string if no
    memory pads exist yet or if all existing ones are effectively empty."""
    items = await _read_all_memory(session, owner_id)
    parts: list[str] = []
    for slot in MEMORY_SLOTS:
        content = items[slot["slug"]]["content"].strip()
        # Strip the seed header + italic note so a pristine slot doesn't
        # pollute the prompt.
        body = re.sub(r"^#\s+.*\n+(_.*_\n+)?", "", content, count=1).strip()
        if body:
            parts.append(f"### {slot['display_name']}\n{body}")
    if not parts:
        return ""
    return (
        "--- Mémoire persistante (faits durables sur l'utilisateur, à respecter) ---\n"
        + "\n\n".join(parts)
        + "\n--- fin mémoire ---"
    )


# ── Section-aware markdown edits ─────────────────────────────────────────────

def _replace_or_append_section(content: str, section: str, new_body: str) -> str:
    """Find `## {section}` in `content` and replace its body up to the next
    heading of the same or higher level. If no such section exists, append it."""
    section = section.strip()
    if not section:
        return content.rstrip() + "\n\n" + new_body.strip() + "\n"
    heading = f"## {section}"
    pattern = re.compile(
        rf"(^{re.escape(heading)}\s*\n)(.*?)(?=^\#{{1,2}}\s|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    if pattern.search(content):
        return pattern.sub(lambda m: f"{m.group(1)}{new_body.strip()}\n\n", content)
    return content.rstrip() + f"\n\n{heading}\n{new_body.strip()}\n"


# ── Endpoints ────────────────────────────────────────────────────────────────

def _is_seed_only(content: str) -> bool:
    """True when a pad's content is just the pristine seed header / preamble
    (nothing the user or the assistant actually recorded)."""
    stripped = re.sub(r"^#\s+.*\n+(_.*_\n+)?", "", (content or "").strip(), count=1)
    return not stripped.strip()


async def _cleanup_seed_only_agent_pads(session: AsyncSession, owner_id: UUID) -> int:
    """One-shot cleanup: remove any `_agent/*` pads created by the old
    auto-on-read behavior that still contain only their seed template. Safe
    because pads with any real content are left alone."""
    stmt = sa_select(PadStore).where(
        PadStore.owner_id == owner_id,
        PadStore.folder == AGENT_FOLDER,
    )
    pads = list((await session.execute(stmt)).scalars().all())
    removed = 0
    for pad in pads:
        data = pad.data if isinstance(pad.data, dict) else {}
        if _is_seed_only(data.get("content", "")):
            await session.delete(pad)
            removed += 1
    if removed:
        await session.commit()
    return removed


@router.get("/memory")
async def get_memory(
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """List agent-memory slots. Never creates pads — that only happens when
    the user accepts a proposal (POST /memory/write). Also opportunistically
    prunes any leftover seed-only pads from earlier versions."""
    await _cleanup_seed_only_agent_pads(session, user.id)
    items = await _read_all_memory(session, user.id)
    return {"slots": [items[s["slug"]] for s in MEMORY_SLOTS]}


class MemoryWriteRequest(BaseModel):
    slug: str
    op: str = "append"  # "append" | "replace_section" | "replace"
    section: Optional[str] = None
    content: str
    reason: Optional[str] = None  # free-text audit trail, stored on the version


@router.post("/memory/write")
async def write_memory(
    body: MemoryWriteRequest,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """Modify one agent-memory pad. Always snapshots the previous content into
    PadVersion first, so the user can undo through the existing history UI."""
    if body.slug not in _VALID_SLUGS:
        raise HTTPException(400, f"slug must be one of {sorted(_VALID_SLUGS)}")
    if body.op not in {"append", "replace_section", "replace"}:
        raise HTTPException(400, "op must be append | replace_section | replace")

    pad = await _get_memory_pad(session, user.id, body.slug, create=True)
    if pad is None:
        raise HTTPException(500, "Could not create memory pad")

    old_content = (pad.data or {}).get("content", "") if isinstance(pad.data, dict) else ""

    # Snapshot BEFORE modifying — so undo is always the previous state.
    try:
        await PadVersion.create(
            session, pad_id=pad.id, data=pad.data, pad_type="document",
            reason=f"agent:{body.op}:{(body.reason or '')[:60]}",
        )
    except Exception:
        pass  # snapshot failure shouldn't block a memory write

    new_body = body.content.strip()
    if body.op == "replace":
        new_content = new_body + ("\n" if not new_body.endswith("\n") else "")
    elif body.op == "replace_section":
        new_content = _replace_or_append_section(old_content, body.section or "", new_body)
    else:  # append
        sep = "\n\n" if old_content.strip() else ""
        new_content = old_content.rstrip() + sep + new_body + "\n"

    pad.data = {"content": new_content, "format": "markdown"}
    await pad.save(session)
    return {
        "ok": True,
        "pad_id": str(pad.id),
        "slug": body.slug,
        "content": new_content,
    }


class MemoryExtractMessage(BaseModel):
    role: str
    content: str


class MemoryExtractRequest(BaseModel):
    messages: List[MemoryExtractMessage]
    model: Optional[str] = None


@router.post("/memory/extract")
async def extract_memory(
    body: MemoryExtractRequest,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """Ask the model whether anything DURABLE about the user is worth saving
    from the recent exchange. Returns a proposal — never writes."""
    if not body.messages:
        return {"should_save": False}

    model = body.model or OLLAMA_DEFAULT_MODEL

    # Only look at the last few turns — extraction is about the *recent* signal.
    tail = body.messages[-6:]
    convo = "\n\n".join(
        f"[{m.role}] {m.content[:1500]}" for m in tail if m.content.strip()
    )
    if not convo:
        return {"should_save": False}

    slot_desc = "\n".join(
        f"- \"{s['slug']}\" : {s['purpose']}" for s in MEMORY_SLOTS
    )
    prompt = (
        "Tu analyses une conversation entre un utilisateur et un assistant. Ta tâche : "
        "détecter s'il y a UN fait DURABLE sur l'utilisateur, ses préférences ou ses projets "
        "qui mérite d'être noté dans la mémoire persistante de l'assistant.\n\n"
        "Cibles possibles :\n" + slot_desc + "\n\n"
        "N'invente RIEN. Ignore les questions ponctuelles et les demandes d'aide. "
        "Ne propose que si le fait est nouveau, stable dans le temps, et utile à retenir "
        "pour de futures conversations.\n\n"
        "Réponds STRICTEMENT en JSON, rien d'autre :\n"
        '{"should_save": bool, "target": "profile"|"preferences"|"projets"|null, '
        '"section": string|null, "content": string, "reason": string}\n\n'
        "`content` = 1-2 phrases à ajouter, formulées à la 3e personne (« L'utilisateur … »).\n"
        "`section` = nom d'une section markdown (##) où stocker, ou null pour un append simple.\n"
        "`reason` = pourquoi ça vaut la peine d'être mémorisé (1 phrase).\n"
        "Si rien de durable, renvoie {\"should_save\": false}.\n\n"
        "Conversation :\n" + convo
    )

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{OLLAMA_URL}/api/chat",
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": False,
                    "format": "json",
                },
            )
            resp.raise_for_status()
            raw = resp.json().get("message", {}).get("content", "")
    except Exception as e:
        return {"should_save": False, "error": str(e)}

    raw = re.sub(r"<think>[\s\S]*?</think>", "", raw or "").strip()
    start, end = raw.find("{"), raw.rfind("}") + 1
    data: dict = {}
    if start >= 0 and end > start:
        try:
            data = json.loads(raw[start:end])
        except Exception:
            data = {}

    should_save = bool(data.get("should_save"))
    target = data.get("target")
    content = (data.get("content") or "").strip()

    # Validate the proposal — the model might target a slug we don't allow, or
    # return should_save=true with no content.
    if not should_save or target not in _VALID_SLUGS or not content:
        return {"should_save": False}

    return {
        "should_save": True,
        "target": target,
        "section": (data.get("section") or None),
        "content": content,
        "reason": (data.get("reason") or "").strip() or None,
    }
