"""Server-side RAG helpers left over after Phase 3C.

Since chunking + embedding + Ollama calls all moved to the browser, this
module keeps only the two pure utilities the server still needs:

  * extract_text_from_pad — the client asks for the "indexable text" of a
    pad it doesn't hold locally (canvas pads, in particular, live in Redis
    + DB, not in the frontend's document buffer).
  * rank_rows — cosine ranking over stored embeddings for KNN search. Pure
    CPU, handed to run_in_threadpool by the endpoint.

Everything else — embed(), embed_model_available(), index_pad(),
schedule_reindex(), the background debounce queue — was deleted in Phase 3C.
"""
import math

from database.models.pad_model import PadStore


def extract_text_from_pad(pad: PadStore) -> str:
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
