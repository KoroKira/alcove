"""Hybrid (semantic + lexical) ranking for workspace search.

Pure CPU helpers, no I/O: the caller loads the rows and hands the work to a
thread pool. Why hybrid: a cosine-only ranking over a workspace dominated by a
bulk import (thousands of long, generic documents) lets those documents win on
vague similarity while the user's own short notes whose *title* names the exact
topic never surface. Exact words in a title, a tag or a folder are the
strongest relevance signal a personal knowledge base has, so they are fused
with the semantic rank instead of only being a fallback.

Fusion is a weighted sum of both signals normalised to [0, 1]. The lexical
score is scaled by the square of the query's *coverage* (share of the query's
IDF mass found in the pad), so a pad naming every word of the query beats a
long document that merely contains one common word of it. Plain rank fusion
(RRF) was tried first and is not enough: documents present in both rankings
with one incidental word still outrank a note that matches the whole query.
"""
from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Iterable, Optional, Sequence

LEXICAL_WEIGHT = 0.6      # nomic-style cosines are compressed (0.45-0.75): words decide ties
SEMANTIC_WEIGHT = 0.4
SEMANTIC_FLOOR = 0.3      # same relevance threshold the semantic-only search used
TITLE_WEIGHT = 3.0
TAG_WEIGHT = 2.0          # tags and folder name
CONTENT_WEIGHT = 1.0

_WORD_RE = re.compile(r"[\w][\w\-./+]*", re.UNICODE)
# Very small FR/EN stop list: only words that carry no topic on their own.
_STOP = frozenset("""
a an and are as at be by de des du d en et for from in is it l la le les of on or
ou par pour que qui sur the to un une with au aux ce ces dans est se sa son ses
""".split())


def fold(text: str) -> str:
    """Lower-case and strip accents so "référentiel" matches "referentiel"."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in decomposed if not unicodedata.combining(c)).lower()


def query_terms(query: str) -> dict[str, tuple[str, ...]]:
    """Distinct query words worth matching: folded key -> spellings to look for.

    Content is only lower-cased (folding megabytes of text per query is too
    slow), so each term is searched both as typed and without accents.
    """
    terms: dict[str, tuple[str, ...]] = {}
    for raw in _WORD_RE.findall((query or "").lower()):
        raw = raw.strip("-./+")
        key = fold(raw)
        if len(key) < 2 or key in _STOP or key in terms:
            continue
        terms[key] = tuple(dict.fromkeys((key, raw)))
        if len(terms) == 16:
            break
    return terms


def _contains(haystack: str, term: str) -> bool:
    """Whole-word match on an already folded haystack."""
    start = 0
    while True:
        idx = haystack.find(term, start)
        if idx == -1:
            return False
        before = haystack[idx - 1] if idx else " "
        end = idx + len(term)
        after = haystack[end] if end < len(haystack) else " "
        if not (before.isalnum() or before == "_") and not (after.isalnum() or after == "_"):
            return True
        start = idx + 1


@dataclass
class PadCandidate:
    """Everything the ranking knows about one readable pad."""
    pad_id: object
    title: str
    folder: Optional[str] = None
    tags: Sequence[str] = ()
    chunks: list = field(default_factory=list)       # [(chunk_text, embedding)]
    semantic: float = 0.0
    best_chunk: Optional[str] = None
    lexical: float = 0.0
    matched_terms: list = field(default_factory=list)
    score: float = 0.0


def score_semantic(q_vec: Sequence[float], candidates: Iterable[PadCandidate]) -> None:
    """Best cosine over each pad's chunks (one vectorised pass)."""
    import numpy as np

    flat_vectors, owners = [], []
    cands = list(candidates)
    dim = len(q_vec)
    for i, cand in enumerate(cands):
        for text, emb in cand.chunks:
            if isinstance(emb, list) and len(emb) == dim:
                flat_vectors.append(emb)
                owners.append((i, text))
    if not flat_vectors:
        return
    q = np.asarray(q_vec, dtype=np.float32)
    qn = float(np.linalg.norm(q))
    if qn == 0:
        return
    mat = np.asarray(flat_vectors, dtype=np.float32)
    norms = np.linalg.norm(mat, axis=1)
    norms[norms == 0] = np.inf
    sims = (mat @ q) / (norms * qn)
    for (i, text), sim in zip(owners, sims.tolist()):
        cand = cands[i]
        if sim > cand.semantic:
            cand.semantic = sim
            cand.best_chunk = text


def score_lexical(terms: dict[str, tuple[str, ...]], candidates: Iterable[PadCandidate]) -> None:
    """IDF-weighted word matches in title (x3), tags/folder (x2) and content."""
    cands = list(candidates)
    if not terms or not cands:
        return
    per_pad: list[dict[str, float]] = []
    df = {t: 0 for t in terms}
    for cand in cands:
        title = fold(cand.title)
        labels = fold(" ".join([cand.folder or "", *[t for t in (cand.tags or []) if isinstance(t, str)]]))
        hits: dict[str, float] = {}
        best_chunk, best_chunk_hits = None, 0
        content_terms: set[str] = set()
        for text, _emb in cand.chunks:
            lowered = (text or "").lower()
            found = [t for t, forms in terms.items() if any(_contains(lowered, f) for f in forms)]
            content_terms.update(found)
            if len(found) > best_chunk_hits:
                best_chunk, best_chunk_hits = text, len(found)
        for term in terms:
            weight = 0.0
            if _contains(title, term):
                weight += TITLE_WEIGHT
            if _contains(labels, term):
                weight += TAG_WEIGHT
            if term in content_terms:
                weight += CONTENT_WEIGHT
            if weight:
                hits[term] = weight
                df[term] += 1
        if best_chunk is not None and cand.best_chunk is None:
            cand.best_chunk = best_chunk
        per_pad.append(hits)
    n = len(cands)
    terms = list(terms)
    idf = {t: math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5)) for t in terms}
    total_idf = sum(idf.values()) or 1.0
    for cand, hits in zip(cands, per_pad):
        coverage = sum(idf[t] for t in hits) / total_idf
        cand.lexical = sum(idf[t] * w for t, w in hits.items()) * coverage * coverage
        cand.matched_terms = [t for t in terms if t in hits]


def fuse(candidates: Iterable[PadCandidate], top_k: int) -> list[PadCandidate]:
    """Weighted fusion of normalised semantic and lexical scores, best first."""
    cands = [c for c in candidates if c.semantic > SEMANTIC_FLOOR or c.lexical > 0]
    if not cands:
        return []
    max_sem = max(c.semantic for c in cands)
    max_lex = max(c.lexical for c in cands)
    sem_span = max_sem - SEMANTIC_FLOOR
    for c in cands:
        sem = (c.semantic - SEMANTIC_FLOOR) / sem_span if sem_span > 0 and c.semantic > SEMANTIC_FLOOR else 0.0
        lex = c.lexical / max_lex if max_lex > 0 else 0.0
        c.score = SEMANTIC_WEIGHT * sem + LEXICAL_WEIGHT * lex
    cands.sort(key=lambda c: (-c.score, -c.lexical, -c.semantic))
    return cands[:top_k]
