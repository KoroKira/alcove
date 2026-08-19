"""
Single source of truth for serializing a pad to the JSON shape the frontend
consumes. Both the domain `Pad` object and raw `PadStore` SQL rows expose the
same attribute names, so one function covers every code path — which is exactly
what was missing when `theme` NULL got coerced to 'dark' in one path only.

Rules enforced here, once:
  - `theme` is passed through verbatim (None = follow the app-wide theme).
    NEVER coerce it to a default — that forces a theme override on every pad.
  - `pad_type` defaults to 'canvas', `tags` to [], `sharing_policy` to 'private'.
  - UUIDs and datetimes are stringified.
"""
from typing import Any, Dict, Optional


def _iso(value: Any) -> Optional[str]:
    return value.isoformat() if value is not None else None


def serialize_pad(obj: Any, *, include_data: bool = False,
                  include_whitelist: bool = False,
                  worker_id: Any = None) -> Dict[str, Any]:
    """Serialize any pad-like object (domain Pad or PadStore row).

    Only the metadata fields are required on `obj`; `data`/`whitelist` are opt-in
    since raw list queries don't select them.
    """
    out: Dict[str, Any] = {
        "id": str(obj.id),
        "owner_id": str(obj.owner_id),
        "display_name": obj.display_name,
        "created_at": _iso(getattr(obj, "created_at", None)),
        "updated_at": _iso(getattr(obj, "updated_at", None)),
        "sharing_policy": getattr(obj, "sharing_policy", None) or "private",
        # Pass theme through as-is — None means "follow the app-wide theme".
        "theme": getattr(obj, "theme", None),
        "is_scratch": bool(getattr(obj, "is_scratch", False)),
        "pad_type": getattr(obj, "pad_type", None) or "canvas",
        "tags": list(getattr(obj, "tags", None) or []),
        # None/empty = ungrouped.
        "folder": getattr(obj, "folder", None) or None,
        # None = fallback iconique par type dans le Dashboard ; sinon URL
        # de miniature (YouTube API, OG-image, cover PDF, snapshot canvas).
        "thumbnail_url": getattr(obj, "thumbnail_url", None) or None,
    }
    if include_data:
        out["data"] = getattr(obj, "data", None)
    if include_whitelist:
        out["whitelist"] = [str(uid) for uid in (getattr(obj, "whitelist", None) or [])]
    if worker_id is not None or hasattr(obj, "worker_id"):
        wid = worker_id if worker_id is not None else getattr(obj, "worker_id", None)
        out["worker_id"] = wid if wid else None
    return out
