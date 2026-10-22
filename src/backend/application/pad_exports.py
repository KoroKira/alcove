"""Pure helpers for lossless, path-safe pad archive exports."""

import json
import re
from typing import Any, Iterable


def _safe_segment(value: str) -> str:
    """Make one archive path segment safe while keeping names readable."""
    cleaned = re.sub(r"[^\w.-]+", "_", value, flags=re.UNICODE).strip("._")
    return cleaned if cleaned and cleaned not in {".", ".."} else "untitled"


def build_pad_export_files(pads: Iterable[Any]) -> list[tuple[str, str]]:
    """Return (archive path, UTF-8 text) pairs for all active pad types.

    Documents and LaTeX stay directly editable. Canvas files retain the
    Excalidraw JSON shape. Structured pads use a versioned JSON envelope that
    preserves both the pad metadata and original data. A manifest gives each
    archive entry its stable pad ID and original organization.
    """
    files: list[tuple[str, str]] = []
    manifest: list[dict[str, Any]] = []
    used_paths: set[str] = set()

    for pad in pads:
        pad_id = str(pad.id)
        name = _safe_segment(pad.display_name or "untitled")
        folder = getattr(pad, "folder", None)
        folder_parts = [
            _safe_segment(part)
            for part in re.split(r"[/\\]+", folder or "")
            if part and part not in {".", ".."}
        ]
        prefix = "/".join([*folder_parts, f"{name}--{pad_id}"])
        pad_type = getattr(pad, "pad_type", "canvas") or "canvas"
        data = pad.data if pad.data is not None else {}
        format_name = data.get("format", "markdown") if isinstance(data, dict) else "markdown"

        if pad_type in {"document", "latex"}:
            is_latex = pad_type == "latex" or format_name == "latex"
            extension = ".tex" if is_latex else ".md"
            body = data.get("content", "") if isinstance(data, dict) else data
            if not isinstance(body, str):
                body = json.dumps(body, ensure_ascii=False, indent=2)
            archive_path = prefix + extension
            content = body
        elif pad_type == "canvas":
            archive_path = prefix + ".excalidraw"
            content = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False)
        else:
            archive_path = prefix + ".json"
            envelope = {
                "schema": "alcove.pad-export/v1",
                "pad": {
                    "id": pad_id,
                    "display_name": pad.display_name,
                    "pad_type": pad_type,
                    "folder": folder,
                    "tags": list(getattr(pad, "tags", None) or []),
                    "created_at": pad.created_at.isoformat() if pad.created_at else None,
                    "updated_at": pad.updated_at.isoformat() if pad.updated_at else None,
                },
                "data": data,
            }
            content = json.dumps(envelope, ensure_ascii=False, indent=2, allow_nan=False)

        # UUIDs are expected to be unique, but also guard against malformed
        # legacy rows and path collisions before writing a ZIP member.
        if archive_path in used_paths:
            raise ValueError(f"duplicate pad export path for {pad_id}")
        used_paths.add(archive_path)
        files.append((archive_path, content))
        manifest.append({
            "id": pad_id,
            "display_name": pad.display_name,
            "pad_type": pad_type,
            "folder": folder,
            "file": archive_path,
            "updated_at": pad.updated_at.isoformat() if pad.updated_at else None,
        })

    files.append((
        "manifest.json",
        json.dumps(
            {"schema": "alcove.export/v1", "pads": manifest},
            ensure_ascii=False,
            indent=2,
            allow_nan=False,
        ),
    ))
    return files
