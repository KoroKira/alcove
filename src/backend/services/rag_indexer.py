"""Server-side RAG helpers left over after Phase 3C.

Since chunking + embedding + Ollama calls all moved to the browser, this
module keeps only the two pure utilities the server still needs:

  * extract_text_from_pad — the client asks for the "indexable text" of a
    pad it doesn't hold locally (structured pads and canvas pads live in
    Redis + DB, not in the frontend's document buffer).
  * rank_rows — cosine ranking over stored embeddings for KNN search. Pure
    CPU, handed to run_in_threadpool by the endpoint.

Everything else — embed(), embed_model_available(), index_pad(),
schedule_reindex(), the background debounce queue — was deleted in Phase 3C.
"""
from __future__ import annotations

import math
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from database.models.pad_model import PadStore


def extract_text_from_pad(pad: PadStore) -> str:
    """Extract user-authored text from every supported pad type."""
    pad_type = getattr(pad, "pad_type", "canvas") or "canvas"
    data = pad.data or {}
    if not isinstance(data, dict):
        return ""

    if pad_type == "document":
        return _text(data.get("content"))
    if pad_type == "latex":
        # New LaTeX pads persist source under `source`; older imported pads
        # may still use the document-compatible `content` field.
        return _text(data.get("source") or data.get("content"))
    if pad_type == "canvas":
        parts = []
        for element in _list(data.get("elements")):
            if not isinstance(element, dict):
                continue
            text = _text(element.get("text"))
            label = element.get("label")
            if not text and isinstance(label, dict):
                text = _text(label.get("text"))
            if text:
                parts.append(text)
        return "\n".join(parts)
    if pad_type == "kanban":
        parts = []
        schema = data.get("fieldSchema")
        for column in _list(data.get("columns")):
            if not isinstance(column, dict):
                continue
            column_title = _text(column.get("title"))
            if column_title:
                parts.append(column_title)
            for card in _list(column.get("cards")):
                if not isinstance(card, dict):
                    continue
                parts.extend(_named_values(card, ("title", "desc", "priority", "dueDate")))
                parts.extend(_string_values(card.get("labels")))
                parts.extend(_field_values(card.get("fields"), schema))
                parts.extend(_attachment_names(card.get("attachments")))
        return "\n".join(parts)
    if pad_type == "gantt":
        parts = []
        schema = data.get("fieldSchema")
        for task in _list(data.get("tasks")):
            if not isinstance(task, dict):
                continue
            parts.extend(_named_values(task, ("name", "desc", "assignee", "priority", "start", "end")))
            parts.extend(_field_values(task.get("fields"), schema))
            parts.extend(_attachment_names(task.get("attachments")))
        return "\n".join(parts)
    if pad_type == "database":
        columns = _list(data.get("columns"))
        names = {
            column.get("id"): _text(column.get("name"))
            for column in columns if isinstance(column, dict) and column.get("id")
        }
        parts = [name for name in names.values() if name]
        for row in _list(data.get("rows")):
            if not isinstance(row, dict) or not isinstance(row.get("cells"), dict):
                continue
            for column_id, value in row["cells"].items():
                text = _text(value)
                if text:
                    label = names.get(column_id)
                    parts.append(f"{label}: {text}" if label else text)
        return "\n".join(parts)
    return ""


def _text(value) -> str:
    """Normalize one user-authored scalar without indexing JSON metadata."""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return ""


def _list(value) -> list:
    return value if isinstance(value, list) else []


def _string_values(values) -> list[str]:
    return [text for value in _list(values) if (text := _text(value))]


def _named_values(record: dict, keys: tuple[str, ...]) -> list[str]:
    return [text for key in keys if (text := _text(record.get(key)))]


def _field_values(values, schema) -> list[str]:
    if not isinstance(values, list):
        return []
    names = {
        field.get("id"): _text(field.get("name"))
        for field in schema if isinstance(field, dict) and field.get("id")
    } if isinstance(schema, list) else {}
    parts = []
    for field in values:
        if not isinstance(field, dict):
            continue
        value = field.get("value")
        text = _text(value)
        if isinstance(value, bool):
            text = "true" if value else "false"
        if text:
            label = names.get(field.get("fieldId"))
            parts.append(f"{label}: {text}" if label else text)
    return parts


def _attachment_names(attachments) -> list[str]:
    return [
        text for item in _list(attachments)
        if isinstance(item, dict) and (text := _text(item.get("name")))
    ]


def rank_rows(q_vec: list[float], rows: list) -> list:
    """Score every chunk row against the query and return them sorted desc.

    Pure CPU work (cosine over every chunk) — callers should hand this to
    run_in_threadpool so it never blocks the async event loop. `rows` come
    from PadEmbedding.get_all_for_owner:
    (pad_id, chunk_text, embedding, display_name).
    """
    qn = math.sqrt(sum(x * x for x in q_vec))
    scored = []
    for r in rows:
        emb = r.embedding
        rn = math.sqrt(sum(x * x for x in emb))
        if qn == 0 or rn == 0:
            score = 0.0
        else:
            score = sum(x * y for x, y in zip(q_vec, emb)) / (qn * rn)
        scored.append((score, r))
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored
