from uuid import UUID
from datetime import datetime, timezone
from typing import Dict, Any, Tuple, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import update as sa_update, select as sa_select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from dependencies import UserSession, require_auth, require_pad_access, require_pad_owner
from database.models import PadStore
from database.models.version_model import PadVersion
from database.database import get_session
from domain.pad import Pad
from domain.user import User
# schedule_reindex was removed in Phase 3C — the browser drives reindexing
# now (manual "Réindexer tout" button) since the server no longer has an
# Ollama to call for embeddings.

pad_router = APIRouter()

# Request models
class RenameRequest(BaseModel):
    display_name: str

class SharingPolicyUpdate(BaseModel):
    policy: str  # "private", "whitelist", or "public"

class WhitelistUpdate(BaseModel):
    user_id: UUID

class ThemeUpdate(BaseModel):
    theme: Optional[str] = None  # "light", "dark", or None to follow the app-wide theme

class TagsUpdate(BaseModel):
    tags: list[str]

class FolderUpdate(BaseModel):
    folder: Optional[str] = None  # None/empty clears the folder (ungroups)

class NewPadRequest(BaseModel):
    pad_type: str = "canvas"
    display_name: str = "New pad"

class DocSaveRequest(BaseModel):
    content: str
    format: str = "markdown"
    # Optimistic concurrency: the updated_at the client last observed. If the
    # server-side pad has moved on since (another device saved in between), we
    # return 409 instead of clobbering. Optional so old clients keep working
    # while the frontend rolls out.
    expected_updated_at: Optional[datetime] = None


async def _cas_save_pad_data(
    session: AsyncSession,
    pad,
    new_data: Dict[str, Any],
    expected_updated_at: Optional[datetime],
) -> datetime:
    """Save pad.data with optimistic-concurrency compare-and-swap.

    When `expected_updated_at` is given we use a single atomic UPDATE with a
    WHERE clause matching the client's baseline — race-safe against two
    concurrent PUTs from different devices, unlike a "check then save" pair
    that both readers can pass before either commits.

    When `expected_updated_at` is None we fall back to the legacy save (no
    concurrency check) so unmigrated clients keep working.

    Returns the new updated_at timestamp so the endpoint can echo it back.
    Raises HTTPException(409) with a machine-readable body on version mismatch.
    """
    from database.models import PadStore  # local import; module-level is already imported below

    if expected_updated_at is None:
        pad.data = new_data
        await pad.save(session)
        return pad.updated_at

    # Always aware-UTC so the value we echo back matches what GET returns
    # (they end up going through the same isoformat + Postgres timestamptz).
    new_updated_at = datetime.now(timezone.utc)
    stmt = (
        sa_update(PadStore)
        .where(PadStore.id == pad.id)
        .where(PadStore.updated_at == expected_updated_at)
        .values(data=new_data, updated_at=new_updated_at)
    )
    result = await session.execute(stmt)
    if result.rowcount == 0:
        # Either the pad vanished or (much more likely) a peer wrote first.
        # Read the current server timestamp so the client can surface the diff.
        got = (await session.execute(
            sa_select(PadStore.updated_at).where(PadStore.id == pad.id)
        )).scalar_one_or_none()
        raise HTTPException(
            status_code=409,
            detail={
                "code": "stale_write",
                "message": "The pad was modified by another session since you loaded it.",
                "server_updated_at": got.isoformat() if got else None,
                "client_expected": expected_updated_at.isoformat(),
            },
        )
    await session.commit()
    # Keep the in-memory pad in sync so downstream code (auto-snapshot, RAG
    # reindex, sync-to-disk) sees the fresh data. Both the store *and* the
    # domain object need the new timestamp — Pad.cache() reads pad.updated_at
    # (not pad._store.updated_at), and a stale value there poisons Redis and
    # breaks the next round of optimistic-concurrency baselines.
    pad._store.data = new_data
    pad._store.updated_at = new_updated_at
    pad.data = new_data
    pad.updated_at = new_updated_at
    await pad.cache()
    return new_updated_at

@pad_router.post("/scratch")
async def get_or_create_scratch_pad(
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Get or create the scratch pad for this user (always position 0)."""
    from sqlalchemy import select as sa_select
    from database.models.pad_model import PadStore
    from uuid import UUID as _UUID
    owner_id = _UUID(user.token_data.get('sub'))
    stmt = sa_select(PadStore).where(PadStore.owner_id == owner_id, PadStore.is_scratch == True)
    result = await session.execute(stmt)
    store = result.scalars().first()
    if store:
        from cache import RedisClient
        redis = await RedisClient.get_instance()
        pad = Pad.from_store(store, redis)
    else:
        pad = await Pad.create(session, owner_id=owner_id, display_name="Scratch")
        pad.is_scratch = True
        await pad.save(session)
    return pad.to_dict()

@pad_router.post("/new")
async def create_new_pad(
    body: NewPadRequest = None,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Create a new pad for the authenticated user"""
    try:
        req = body or NewPadRequest()
        VALID_PAD_TYPES = ("canvas", "document", "kanban", "gantt", "latex", "database")
        pad_type = req.pad_type if req.pad_type in VALID_PAD_TYPES else "canvas"
        default_names = {"document": "New document", "kanban": "New kanban", "gantt": "New gantt", "latex": "New LaTeX", "database": "New database"}
        display_name = req.display_name or default_names.get(pad_type, "New pad")
        pad = await Pad.create(
            session=session,
            owner_id=user.id,
            display_name=display_name,
        )
        pad.pad_type = pad_type
        if pad_type == "document":
            pad.data = {"content": "", "format": "markdown"}
        elif pad_type == "kanban":
            pad.data = {"columns": [
                {"id": "col-1", "title": "À faire", "cards": []},
                {"id": "col-2", "title": "En cours", "cards": []},
                {"id": "col-3", "title": "Terminé", "cards": []},
            ]}
        elif pad_type == "gantt":
            pad.data = {"tasks": []}
        elif pad_type == "latex":
            pad.data = {"source": ""}
        elif pad_type == "database":
            pad.data = {
                "columns": [
                    {"id": "c-name", "name": "Nom"},
                    {"id": "c-status", "name": "Statut"},
                    {"id": "c-notes", "name": "Notes"},
                ],
                "rows": [
                    {"id": "r-1", "cells": {"c-name": "", "c-status": "À faire", "c-notes": ""}},
                    {"id": "r-2", "cells": {"c-name": "", "c-status": "À faire", "c-notes": ""}},
                ],
                "groupBy": "c-status",
            }
        await pad.save(session)
        return pad.to_dict()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to create new pad: {str(e)}"
        )

@pad_router.get("/daily")
async def get_or_create_daily_pad(
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Get or create today's daily note pad.

    On creation, unchecked tasks from yesterday's note are carried over and a
    "## Hier" section links back to it; the frontend fills in the AI summary
    asynchronously (marker comment) so creation never blocks on Ollama.
    """
    from datetime import date, timedelta
    from database.models.pad_model import PadStore as _PadStore
    from sqlalchemy import select as _sa_select

    today = date.today()
    title = today.strftime("%Y-%m-%d")
    month_names = ["janvier","février","mars","avril","mai","juin",
                   "juillet","août","septembre","octobre","novembre","décembre"]
    pretty = f"{today.day} {month_names[today.month - 1]} {today.year}"

    stmt = _sa_select(_PadStore).where(
        _PadStore.owner_id == user.id,
        _PadStore.display_name == title,
    )
    result = await session.execute(stmt)
    store = result.scalars().first()

    if store:
        from cache import RedisClient
        redis = await RedisClient.get_instance()
        pad = Pad.from_store(store, redis)
        await pad.ensure_worker()
    else:
        yesterday_title = (today - timedelta(days=1)).strftime("%Y-%m-%d")
        y_stmt = _sa_select(_PadStore).where(
            _PadStore.owner_id == user.id,
            _PadStore.display_name == yesterday_title,
        )
        y_store = (await session.execute(y_stmt)).scalars().first()

        carried_tasks: list[str] = []
        yesterday_section = ""
        if y_store and isinstance(y_store.data, dict):
            y_content = y_store.data.get("content", "") or ""
            carried_tasks = [
                line for line in y_content.splitlines()
                if line.strip().startswith("- [ ]") and line.strip() != "- [ ]"
            ]
            yesterday_section = (
                f"\n## Hier ([[{yesterday_title}]])\n"
                f"<!-- ai-summary-pending:{y_store.id} -->\n"
            )

        objectives = "\n".join(carried_tasks) if carried_tasks else "- [ ] "
        template = (
            f"# {pretty}\n\n"
            f"## Objectifs\n{objectives}\n"
            f"{yesterday_section}\n"
            f"## Notes\n\n\n## Liens\n"
        )

        pad = await Pad.create(session=session, owner_id=user.id, display_name=title)
        pad.pad_type = "document"
        pad.data = {"content": template, "format": "markdown"}
        await pad.save(session)

    return pad.to_dict()


@pad_router.get("/activity")
async def get_activity(
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> Dict[str, Any]:
    """Daily edit counts for the activity heatmap (last ~6 months).

    Counts version snapshots per day across the user's pads; also folds in each
    pad's updated_at so days without snapshots still register."""
    from datetime import date, timedelta
    from sqlalchemy import select as _sel, func as _f, cast, Date

    since = date.today() - timedelta(days=182)

    pad_ids_stmt = _sel(PadStore.id).where(PadStore.owner_id == user.id)
    pad_ids = (await session.execute(pad_ids_stmt)).scalars().all()
    counts: Dict[str, int] = {}

    if pad_ids:
        stmt = (
            _sel(cast(PadVersion.created_at, Date).label("day"), _f.count())
            .where(PadVersion.pad_id.in_(pad_ids), cast(PadVersion.created_at, Date) >= since)
            .group_by("day")
        )
        for day, n in (await session.execute(stmt)).all():
            counts[day.isoformat()] = n

        upd_stmt = _sel(cast(PadStore.updated_at, Date).label("day"), _f.count()).where(
            PadStore.owner_id == user.id, cast(PadStore.updated_at, Date) >= since
        ).group_by("day")
        for day, n in (await session.execute(upd_stmt)).all():
            key = day.isoformat()
            counts[key] = counts.get(key, 0) + n

    return {"since": since.isoformat(), "counts": counts}


@pad_router.get("/graph")
async def get_knowledge_graph(
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Return graph nodes (pads) and edges (wikilinks) for the knowledge graph."""
    import re as _re
    from sqlalchemy import select as _sa_select

    # Nodes: only the metadata columns — never pull the (potentially huge) JSONB
    # canvas scene, which we don't need to draw a node.
    node_stmt = _sa_select(
        PadStore.id, PadStore.display_name, PadStore.pad_type, PadStore.is_scratch,
    ).where(PadStore.owner_id == user.id)
    node_rows = (await session.execute(node_stmt)).all()

    nodes = [{
        "id": str(r.id),
        "label": r.display_name,
        "type": r.pad_type or "canvas",
        "is_scratch": bool(r.is_scratch),
    } for r in node_rows]

    # Wikilinks may target any pad type, so the name→id map covers every node.
    name_to_id = {(r.display_name or "").lower(): str(r.id) for r in node_rows}

    # Edges: only document pads carry wikilinks. Extract just the `content`
    # string out of the JSONB (data->>'content') instead of the whole blob.
    edge_stmt = _sa_select(
        PadStore.id, PadStore.data["content"].astext,
    ).where(
        PadStore.owner_id == user.id,
        PadStore.pad_type == "document",
    )
    edge_rows = (await session.execute(edge_stmt)).all()

    wikilink_re = _re.compile(r"\[\[([^\]]+)\]\]")
    edges = []
    seen = set()

    for pad_id, content in edge_rows:
        if not content:
            continue
        src = str(pad_id)
        for m in wikilink_re.finditer(content):
            tgt = name_to_id.get(m.group(1).lower())
            if tgt and tgt != src and (src, tgt) not in seen:
                seen.add((src, tgt))
                edges.append({"from": src, "to": tgt})

    return {"nodes": nodes, "edges": edges}


def _match_pad(pad_type: str, data: Any, display_name: str, query: str):
    """Match one pad against a lowercase `query`.

    Returns ``(name_match, matches)`` when the title or body matches, else
    ``None``. Documents match on their `content`, canvas pads on element text —
    the previous implementation only ever looked at canvas elements, so document
    bodies were silently unsearchable. Pure function → unit-tested.
    """
    data = data if isinstance(data, dict) else {}
    matches = []
    if pad_type == "document":
        content = data.get("content", "") or ""
        idx = content.lower().find(query)
        if idx != -1:
            start = max(0, idx - 40)
            excerpt = content[start:idx + 80].replace("\n", " ").strip()
            matches.append({"element_id": "", "text": content[idx:idx + 60], "excerpt": excerpt})
    else:
        for elem in data.get("elements", []):
            text = elem.get("text", "") or (elem.get("label") or {}).get("text", "")
            if text and query in text.lower():
                matches.append({"element_id": elem.get("id", ""), "text": text[:60], "excerpt": text[:120]})

    name_match = query in (display_name or "").lower()
    if name_match or matches:
        return name_match, matches[:5]
    return None


@pad_router.get("/search")
async def search_pads(
    q: str,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session)
):
    """Full-text search across pad names, document bodies and canvas text.

    Scans *all* of the user's pads in a single query (previously only the
    currently-open tabs), and matches document `content` — not just canvas
    text elements — so notes are actually searchable.
    """
    from sqlalchemy import select as _sel

    if not q or len(q.strip()) < 2:
        return []

    query = q.strip().lower()

    stmt = _sel(PadStore).where(PadStore.owner_id == user.id)
    stores = (await session.execute(stmt)).scalars().all()

    results = []
    for store in stores:
        pad_type = getattr(store, "pad_type", "canvas") or "canvas"
        matched = _match_pad(pad_type, store.data, store.display_name, query)
        if matched is None:
            continue
        name_match, matches = matched
        results.append({
            "pad_id": str(store.id),
            "pad_name": store.display_name,
            "name_match": name_match,
            "matches": matches,
        })

    return results


@pad_router.get("/export/zip")
async def export_all_zip(
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session)
):
    """Export all pads as a ZIP archive (markdown + excalidraw files)."""
    import io, zipfile, json as _json
    from fastapi.responses import StreamingResponse
    from domain.user import User as _User
    from sqlalchemy import select as _sel

    real_user = await _User.get_by_id(session, user.id)
    if not real_user:
        raise HTTPException(status_code=401)

    stmt = _sel(PadStore).where(PadStore.owner_id == real_user.id)
    pads = (await session.execute(stmt)).scalars().all()

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for pad in pads:
            safe = __import__('re').sub(r'[^\w\-]', '_', pad.display_name or 'untitled')
            if getattr(pad, 'pad_type', 'canvas') == 'document':
                content = ''
                if isinstance(pad.data, dict):
                    content = pad.data.get('content', '')
                zf.writestr(f"{safe}.md", content or '')
            else:
                data = pad.data or {}
                zf.writestr(f"{safe}.excalidraw", _json.dumps(data, ensure_ascii=False, indent=2))
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type='application/zip',
        headers={'Content-Disposition': 'attachment; filename="pad-ws-export.zip"'},
    )


@pad_router.get("/{pad_id}")
async def get_pad(
    pad_access: Tuple[Pad, UserSession] = Depends(require_pad_access),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Get a specific pad for the authenticated user"""
    try:
        pad, user = pad_access

        # Update the user's last selected pad
        user_obj = await User.get_by_id(session, user.id)
        if user_obj:
            await user_obj.set_last_selected_pad(session, pad.id)

        # updated_at is echoed with every structured pad response so the
        # client can pass it back on save for optimistic concurrency control.
        pad_updated_at = pad.updated_at.isoformat() if pad.updated_at else None

        # Document pads: return content directly. Also surface `video` when
        # present so the frontend can offer the Regenerate button without
        # a second round-trip.
        if pad.pad_type == "document":
            data = pad.data if isinstance(pad.data, dict) else {}
            resp = {
                "content": data.get("content", ""),
                "format": data.get("format", "markdown"),
                "updated_at": pad_updated_at,
            }
            if data.get("video"):
                resp["video"] = data["video"]
            return resp

        # Structured pads (kanban, gantt, latex, database): return raw data +
        # updated_at. All of these save through PUT /{id}/data and need the
        # concurrency baseline.
        if pad.pad_type in ("kanban", "gantt", "latex", "database"):
            raw = pad.data if isinstance(pad.data, dict) else {}
            return {**raw, "updated_at": pad_updated_at}

        pad_dict = pad.to_dict()
        # Get only this user's appState
        app_state = pad_dict["data"].get("appState", {}) if isinstance(pad_dict["data"], dict) else {}
        user_app_state = app_state.get(str(user.id), {})
        pad_dict["data"]["appState"] = user_app_state
        return pad_dict["data"]
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get pad: {str(e)}"
        )

@pad_router.put("/{pad_id}/rename")
async def rename_pad(
    rename_data: RenameRequest,
    pad_access: Tuple[Pad, UserSession] = Depends(require_pad_owner),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Rename a pad (owner only)"""
    try:
        pad, _ = pad_access
        await pad.rename(session, rename_data.display_name)
        return pad.to_dict()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to rename pad: {str(e)}"
        )

@pad_router.delete("/{pad_id}")
async def delete_pad(
    pad_access: Tuple[Pad, UserSession] = Depends(require_pad_owner),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Delete a pad (owner only)"""
    try:
        pad, _ = pad_access
        success = await pad.delete(session)
        if not success:
            raise HTTPException(
                status_code=500,
                detail="Failed to delete pad"
            )
        
        return {"success": True, "message": "Pad deleted successfully"}
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to delete pad: {str(e)}"
        )

@pad_router.put("/{pad_id}/sharing")
async def update_sharing_policy(
    policy_update: SharingPolicyUpdate,
    pad_access: Tuple[Pad, UserSession] = Depends(require_pad_owner),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Update the sharing policy of a pad (owner only)"""
    try:
        pad, _ = pad_access
        await pad.set_sharing_policy(session, policy_update.policy)
        return pad.to_dict()
    except ValueError as e:
        raise HTTPException(
            status_code=400,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to update sharing policy: {str(e)}"
        )

@pad_router.post("/{pad_id}/whitelist")
async def add_to_whitelist(
    whitelist_update: WhitelistUpdate,
    pad_access: Tuple[Pad, UserSession] = Depends(require_pad_owner),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Add a user to the pad's whitelist (owner only)"""
    try:
        pad, _ = pad_access
        await pad.add_to_whitelist(session, whitelist_update.user_id)
        return pad.to_dict()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to add user to whitelist: {str(e)}"
        )

@pad_router.delete("/{pad_id}/whitelist/{user_id}")
async def remove_from_whitelist(
    user_id: UUID,
    pad_access: Tuple[Pad, UserSession] = Depends(require_pad_owner),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Remove a user from the pad's whitelist (owner only)"""
    try:
        pad, _ = pad_access
        await pad.remove_from_whitelist(session, user_id)
        return pad.to_dict()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to remove user from whitelist: {str(e)}"
        )

@pad_router.get("/{pad_id}/backlinks")
async def get_backlinks(
    pad_id: UUID,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Return all pads that link to this pad via [[wikilinks]]."""
    import re as _re
    from database.models.pad_model import PadStore as _PadStore
    from sqlalchemy import select as _sa_select

    target = await PadStore.get_by_id(session, pad_id)
    if not target:
        raise HTTPException(status_code=404, detail="Pad not found")
    target_name = target.display_name.lower()

    stmt = _sa_select(_PadStore).where(_PadStore.owner_id == user.id)
    result = await session.execute(stmt)
    stores = result.scalars().all()

    pattern = _re.compile(r"\[\[" + _re.escape(target_name) + r"\]\]", _re.IGNORECASE)
    backlinks = []
    for s in stores:
        if str(s.id) == str(pad_id):
            continue
        if (getattr(s, "pad_type", "canvas") or "canvas") != "document":
            continue
        data = s.data or {}
        content = data.get("content", "") if isinstance(data, dict) else ""
        if content and pattern.search(content):
            backlinks.append({
                "id": str(s.id),
                "display_name": s.display_name,
                "pad_type": getattr(s, "pad_type", "canvas") or "canvas",
            })

    return {"backlinks": backlinks}


@pad_router.get("/{pad_id}/versions")
async def list_versions(
    pad_id: UUID,
    pad_access: Tuple[Pad, UserSession] = Depends(require_pad_access),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """List version history for a pad."""
    versions = await PadVersion.list_for_pad(session, pad_id)
    return {"versions": [v.to_dict() for v in versions]}


@pad_router.get("/{pad_id}/versions/{version_id}")
async def get_version(
    pad_id: UUID,
    version_id: UUID,
    pad_access: Tuple[Pad, UserSession] = Depends(require_pad_access),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Get full data for a specific version."""
    from sqlalchemy import select as _sa_select
    stmt = _sa_select(PadVersion).where(PadVersion.id == version_id, PadVersion.pad_id == pad_id)
    result = await session.execute(stmt)
    version = result.scalars().first()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    return version.to_full_dict()


@pad_router.post("/{pad_id}/versions/{version_id}/restore")
async def restore_version(
    pad_id: UUID,
    version_id: UUID,
    pad_access: Tuple[Pad, UserSession] = Depends(require_pad_owner),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Restore pad to a specific version, creating a snapshot of current state first."""
    from sqlalchemy import select as _sa_select
    pad, _ = pad_access
    stmt = _sa_select(PadVersion).where(PadVersion.id == version_id, PadVersion.pad_id == pad_id)
    result = await session.execute(stmt)
    version = result.scalars().first()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    # Snapshot current state before restore
    await PadVersion.create(session, pad_id=pad_id, data=pad.data, pad_type=pad.pad_type, reason='pre-restore')
    pad.data = version.data
    await pad.cache()
    await pad.save(session)
    return {"ok": True}


@pad_router.post("/{pad_id}/versions/snapshot")
async def manual_snapshot(
    pad_id: UUID,
    pad_access: Tuple[Pad, UserSession] = Depends(require_pad_owner),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Manually save a named version snapshot."""
    pad, _ = pad_access
    v = await PadVersion.create(session, pad_id=pad_id, data=pad.data, pad_type=pad.pad_type, reason='manual')
    return {"id": str(v.id), "created_at": v.created_at.isoformat()}


@pad_router.put("/{pad_id}/doc")
async def save_doc_content(
    doc: DocSaveRequest,
    pad_access: Tuple[Pad, UserSession] = Depends(require_pad_owner),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Save document content for a document-type pad. Preserves any
    non-content keys already on `pad.data` (e.g. `video` — see the
    /video-meta endpoint) so structured metadata attached to a doc pad
    survives every content save."""
    pad, _ = pad_access
    existing = pad.data if isinstance(pad.data, dict) else {}
    old_content = existing.get('content', '')
    new_data = {**existing, "content": doc.content, "format": doc.format}
    new_updated_at = await _cas_save_pad_data(session, pad, new_data, doc.expected_updated_at)
    # Auto-snapshot every time content changes significantly (>50 chars diff)
    if abs(len(doc.content) - len(old_content)) > 50 or (old_content and not doc.content):
        try:
            await PadVersion.create(session, pad_id=pad.id, data=pad.data, pad_type='document', reason='auto')
        except Exception:
            pass
    # Sync to local disk as .md file
    try:
        from config import SYNC_DIR
        import os, re, asyncio as _asyncio
        if SYNC_DIR:
            os.makedirs(SYNC_DIR, exist_ok=True)
            safe = re.sub(r'[^\w\-]', '_', pad.display_name or 'untitled')
            path = os.path.join(SYNC_DIR, f"{safe}_{str(pad.id)[:8]}.md")
            content = doc.content
            def _write_md():
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(content)
            await _asyncio.get_running_loop().run_in_executor(None, _write_md)
    except Exception:
        pass
    return {"ok": True, "updated_at": new_updated_at.isoformat() if new_updated_at else None}

class PadDataSaveRequest(BaseModel):
    data: Dict[str, Any]
    expected_updated_at: Optional[datetime] = None

@pad_router.put("/{pad_id}/data")
async def save_pad_data(
    body: PadDataSaveRequest,
    pad_access: Tuple[Pad, UserSession] = Depends(require_pad_owner),
    session: AsyncSession = Depends(get_session),
) -> Dict[str, Any]:
    """Generic data save for kanban, gantt, and other structured pad types."""
    pad, _ = pad_access
    new_updated_at = await _cas_save_pad_data(session, pad, body.data, body.expected_updated_at)
    return {"ok": True, "updated_at": new_updated_at.isoformat() if new_updated_at else None}


class VideoMetaPayload(BaseModel):
    """Bag of video-specific fields — everything that would be prohibitively
    heavy to embed in the markdown itself (transcript_segments) or that we
    want structured for the "Regenerate" button. Free-form: the frontend
    controls the shape, backend just persists."""
    video_id: Optional[str] = None
    url: Optional[str] = None
    thumbnail: Optional[str] = None
    duration: Optional[float] = None
    author: Optional[str] = None
    chapters: Optional[list] = None
    transcript_segments: Optional[list] = None
    language: Optional[str] = None
    diarized: Optional[bool] = None


@pad_router.put("/{pad_id}/video-meta")
async def save_video_meta(
    body: VideoMetaPayload,
    pad_access: Tuple[Pad, UserSession] = Depends(require_pad_owner),
    session: AsyncSession = Depends(get_session),
) -> Dict[str, Any]:
    """Attach (or replace) the video block on a document pad. Stored under
    `pad.data.video` — a document save via /doc will preserve it. Used so
    the "Regenerate report" button can re-run /api/ai/video-report without
    needing to re-hit YouTube or re-run Whisper."""
    pad, _ = pad_access
    existing = pad.data if isinstance(pad.data, dict) else {}
    # Drop empty keys so we don't clobber existing values with None on partial
    # updates.
    payload = {k: v for k, v in body.model_dump().items() if v is not None}
    pad.data = {**existing, "video": {**(existing.get("video") or {}), **payload}}
    await pad.cache()
    await pad.save(session)
    return {"ok": True, "video": pad.data["video"]}


@pad_router.put("/{pad_id}/tags")
async def update_tags(
    tags_update: TagsUpdate,
    pad_access: Tuple[Pad, UserSession] = Depends(require_pad_owner),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Update the tags of a pad (owner only)"""
    pad, _ = pad_access
    cleaned = [t.strip()[:50] for t in (tags_update.tags or []) if t.strip()][:20]
    pad.tags = cleaned
    await pad.save(session)
    return {"tags": pad.tags}


@pad_router.put("/{pad_id}/folder")
async def update_folder(
    folder_update: FolderUpdate,
    pad_access: Tuple[Pad, UserSession] = Depends(require_pad_owner),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Set (or clear, with null/empty) the folder a pad lives under (owner only)."""
    pad, _ = pad_access
    folder = (folder_update.folder or "").strip()[:80] or None
    pad.folder = folder
    await pad.save(session)
    return {"folder": pad.folder}


@pad_router.put("/{pad_id}/theme")
async def update_theme(
    theme_update: ThemeUpdate,
    pad_access: Tuple[Pad, UserSession] = Depends(require_pad_owner),
    session: AsyncSession = Depends(get_session)
) -> Dict[str, Any]:
    """Update the theme of a pad (owner only). theme=None resets to "follow the app-wide theme"."""
    if theme_update.theme is not None and theme_update.theme not in ("light", "dark"):
        raise HTTPException(status_code=400, detail="theme must be 'light', 'dark', or null")
    try:
        pad, _ = pad_access
        pad.theme = theme_update.theme
        await pad.save(session)
        return pad.to_dict()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update theme: {str(e)}")
