"""Smart / Deep Research — an agentic pipeline on the user's own building blocks.

Flow: understand intent → decompose into sub-questions → per sub-question
{search → LLM relevance filter → fetch → extract points} → (optionally recurse
into gap-driven sub-searches, bounded depth) → dense cited final report.

Only the search step reaches out (to the configured backend); page fetching and
all LLM work stay local. Retrieval is in-memory — nothing is written to the RAG.
Everything is hard-bounded so the loop can't run away on modest hardware.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from dependencies import UserSession, require_auth
from config import OLLAMA_URL, OLLAMA_DEFAULT_MODEL
from routers.ingest_router import fetch_web

research_router = APIRouter(prefix="/api/research")

SEARCH_BACKEND = os.getenv("SEARCH_BACKEND", "duckduckgo")

# Hard caps so a "depth 3" request can't explode into hundreds of calls.
MAX_SUBQ = 10
MAX_SOURCES_PER_SUBQ = 4
MAX_TOTAL_SOURCES = 24


class ResearchRequest(BaseModel):
    topic: str
    lang: Optional[str] = "fr"
    length: Optional[str] = "long"
    depth: int = 1                 # 1..3 levels of recursive sub-search
    max_subquestions: int = 6      # per level
    sources_per_subq: int = 3


# ── Search backends ──────────────────────────────────────────────────────────

def _search_ddg(query: str, k: int) -> list[dict]:
    from ddgs import DDGS
    try:
        return [
            {"title": r.get("title", ""), "url": r.get("href", ""), "snippet": r.get("body", "")}
            for r in DDGS().text(query, max_results=k)
        ]
    except Exception:
        return []


async def web_search(query: str, k: int = 5) -> list[dict]:
    if SEARCH_BACKEND == "duckduckgo":
        return await run_in_threadpool(_search_ddg, query, k)
    return await run_in_threadpool(_search_ddg, query, k)


# ── LLM helpers ──────────────────────────────────────────────────────────────

async def _chat_json(client, model: str, prompt: str) -> dict:
    resp = await client.post(
        f"{OLLAMA_URL}/api/chat",
        json={"model": model, "messages": [{"role": "user", "content": prompt}],
              "stream": False, "format": "json"},
    )
    resp.raise_for_status()
    raw = re.sub(r"<think>[\s\S]*?</think>", "", resp.json().get("message", {}).get("content", ""))
    s, e = raw.find("{"), raw.rfind("}") + 1
    if s >= 0 and e > s:
        try:
            return json.loads(raw[s:e])
        except Exception:
            return {}
    return {}


async def _chat_text(client, model: str, prompt: str) -> str:
    resp = await client.post(
        f"{OLLAMA_URL}/api/chat",
        json={"model": model, "messages": [{"role": "user", "content": prompt}], "stream": False},
    )
    resp.raise_for_status()
    out = re.sub(r"<think>[\s\S]*?</think>", "", resp.json().get("message", {}).get("content", "")).strip()
    h = out.find("## ")
    return out[h:].strip() if h > 0 else out


# ── Prompts ──────────────────────────────────────────────────────────────────

def _intent_prompt(topic: str, n: int, lang: str) -> str:
    if lang == "fr":
        return (
            f"Demande de l'utilisateur : « {topic} ».\n"
            "1) Reformule en une phrase ce que l'utilisateur cherche vraiment (intention, périmètre).\n"
            f"2) Décompose en {n} sous-questions de recherche précises, complémentaires et couvrant tous les angles.\n"
            'Réponds STRICTEMENT en JSON : {"intent": "...", "subquestions": ["...", "..."]}'
        )
    return (
        f"User request: \"{topic}\".\n"
        "1) Restate in one sentence what the user really wants (intent, scope).\n"
        f"2) Decompose into {n} precise, complementary research sub-questions covering all angles.\n"
        'Reply STRICTLY as JSON: {"intent": "...", "subquestions": ["...", "..."]}'
    )


def _filter_prompt(intent: str, subq: str, candidates: list[dict], keep: int, lang: str) -> str:
    listing = "\n".join(f"[{i}] {c['title']} — {c.get('snippet', '')[:140]}" for i, c in enumerate(candidates))
    if lang == "fr":
        return (
            f"Intention de recherche : {intent}\nSous-question : « {subq} »\n"
            f"Voici des résultats de recherche. Sélectionne UNIQUEMENT les {keep} plus pertinents et fiables "
            "pour répondre à la sous-question (écarte hors-sujet, putaclic, contenus non fiables).\n"
            'Réponds STRICTEMENT en JSON : {"keep": [indices]} (les numéros entre crochets).\n\n'
            f"{listing}"
        )
    return (
        f"Research intent: {intent}\nSub-question: \"{subq}\"\n"
        f"Here are search results. Select ONLY the {keep} most relevant and reliable to answer the "
        "sub-question (drop off-topic, clickbait, unreliable).\n"
        'Reply STRICTLY as JSON: {"keep": [indices]}.\n\n'
        f"{listing}"
    )


def _map_prompt(subq: str, src: dict, lang: str) -> str:
    if lang == "fr":
        return (
            f"Sous-question : « {subq} ».\nSource « {src['title']} ». Extrais UNIQUEMENT les faits de cette "
            "source pertinents pour la sous-question (chiffres, dates, définitions, positions). N'invente rien.\n"
            'Réponds STRICTEMENT en JSON : {"points": ["fait", "..."]} (vide si rien de pertinent).\n\n'
            f"{src['content']}"
        )
    return (
        f"Sub-question: \"{subq}\".\nSource \"{src['title']}\". Extract ONLY facts from this source relevant "
        "to the sub-question (figures, dates, definitions, positions). Do not invent.\n"
        'Reply STRICTLY as JSON: {"points": ["fact", "..."]} (empty if nothing relevant).\n\n'
        f"{src['content']}"
    )


def _gap_prompt(topic: str, answered: list[str], lang: str, k: int) -> str:
    done = "\n".join(f"- {q}" for q in answered)
    if lang == "fr":
        return (
            f"Sujet global : « {topic} ».\nSous-questions déjà traitées :\n{done}\n\n"
            f"Quelles sont les lacunes ou aspects importants NON encore couverts ? Propose au plus {k} nouvelles "
            "sous-questions de recherche pour approfondir (ou une liste vide si la couverture est suffisante).\n"
            'Réponds STRICTEMENT en JSON : {"subquestions": ["...", "..."]}'
        )
    return (
        f"Overall topic: \"{topic}\".\nSub-questions already covered:\n{done}\n\n"
        f"What important gaps remain? Propose at most {k} new sub-questions to dig deeper (or an empty list if "
        'coverage is enough).\nReply STRICTLY as JSON: {"subquestions": ["...", "..."]}'
    )


def _report_prompt(topic: str, intent: str, corpus: str, lang: str, length: str) -> str:
    short = length == "short"
    if lang == "fr":
        struct = (
            "## Résumé exécutif\n## Points clés\n## Sources principales"
            if short else
            "## Résumé exécutif\n(un paragraphe dense)\n## Contexte\n## Analyse détaillée\n"
            "(plusieurs sections ### thématiques, développées, avec chiffres et nuances)\n"
            "## Chiffres clés\n## Points de vigilance / incertitudes\n## Conclusion"
        )
        return (
            f"Tu es un analyste de recherche. Intention : {intent}\n"
            f"Rédige un RAPPORT {'concis' if short else 'DENSE et approfondi'} en français sur « {topic} », "
            "UNIQUEMENT à partir des extraits sourcés ci-dessous. Cite chaque affirmation avec [n] (numéro de source). "
            "Développe, croise les sources, signale les contradictions, ne te contente pas de lister — analyse. "
            "N'invente aucun fait absent des extraits.\n"
            f"Structure (garde les titres), commence DIRECTEMENT par « ## Résumé exécutif » :\n{struct}\n\n"
            f"Extraits sourcés :\n{corpus}"
        )
    struct = ("## Executive summary\n## Key points\n## Main sources" if short else
              "## Executive summary\n## Context\n## Detailed analysis\n(several thematic ### sections)\n"
              "## Key figures\n## Caveats / uncertainties\n## Conclusion")
    return (
        f"You are a research analyst. Intent: {intent}\n"
        f"Write a {'concise' if short else 'DENSE, in-depth'} report in English on \"{topic}\", ONLY from the "
        "sourced excerpts below. Cite every claim with [n]. Cross-reference sources, flag contradictions, analyse "
        f"(don't just list). Invent nothing.\nStructure, start with \"## Executive summary\":\n{struct}\n\n"
        f"Sourced excerpts:\n{corpus}"
    )


# ── Endpoint ─────────────────────────────────────────────────────────────────

@research_router.post("")
async def research(body: ResearchRequest, _: UserSession = Depends(require_auth)):
    """Agentic deep research: intent → sub-questions → filtered multi-source →
    bounded recursion → dense cited report."""
    model = OLLAMA_DEFAULT_MODEL
    topic = (body.topic or "").strip()
    lang = body.lang or "fr"
    if not topic:
        raise HTTPException(400, "Sujet de recherche requis")
    depth = max(1, min(body.depth, 3))
    per_level = max(3, min(body.max_subquestions, MAX_SUBQ))
    per_subq = max(1, min(body.sources_per_subq, MAX_SOURCES_PER_SUBQ))

    async def stream():
        def evt(kind: str, **kw) -> str:
            return f"data: {json.dumps({'kind': kind, **kw})}\n\n"

        try:
            async with httpx.AsyncClient(timeout=120) as client:
                # 0. Intent + initial sub-questions.
                yield evt("progress", msg="Compréhension de la demande…")
                plan = await _chat_json(client, model, _intent_prompt(topic, per_level, lang))
                intent = str(plan.get("intent", topic)).strip() or topic
                subqs = [str(q).strip() for q in (plan.get("subquestions") or []) if str(q).strip()][:per_level]
                if not subqs:
                    subqs = [topic]
                yield evt("progress", msg=f"Intention : {intent}")

                sources: dict[str, dict] = {}   # url -> {idx, title}
                collected: dict[str, list] = {}  # subq -> list of (src_idx, point)
                seen_urls: set[str] = set()
                answered: list[str] = []

                async def _process_source(subq: str, src: dict):
                    try:
                        page = await fetch_web(src["url"])
                        content = (page.get("markdown") or "")[:5000]
                    except Exception:
                        content = src.get("snippet", "")
                    if not content.strip():
                        return src["url"], []
                    obj = await _chat_json(client, model, _map_prompt(subq, {**src, "content": content}, lang))
                    pts = [str(x).strip() for x in (obj.get("points") or []) if str(x).strip()][:6]
                    return src["url"], pts

                level = 1
                while subqs and level <= depth and len(sources) < MAX_TOTAL_SOURCES:
                    yield evt("progress", msg=f"— Niveau {level} : {len(subqs)} sous-question(s) —")
                    for si, subq in enumerate(subqs):
                        if len(sources) >= MAX_TOTAL_SOURCES:
                            break
                        yield evt("progress", msg=f"[N{level}] {si + 1}/{len(subqs)} · {subq}")

                        # search (dedupe against everything already seen)
                        cands: list[dict] = []
                        for r in await web_search(subq, 6):
                            u = r.get("url", "")
                            if u.startswith("http") and u not in seen_urls and all(c["url"] != u for c in cands):
                                cands.append(r)
                        if not cands:
                            continue

                        # LLM relevance filter
                        filt = await _chat_json(client, model, _filter_prompt(intent, subq, cands, per_subq, lang))
                        idxs = [i for i in (filt.get("keep") or []) if isinstance(i, int) and 0 <= i < len(cands)]
                        kept = [cands[i] for i in idxs][:per_subq] or cands[:per_subq]
                        yield evt("progress", msg=f"    {len(kept)} source(s) pertinente(s) retenue(s) / {len(cands)}")

                        # register + fetch + map (concurrent within the sub-question)
                        for src in kept:
                            if src["url"] not in sources and len(sources) < MAX_TOTAL_SOURCES:
                                sources[src["url"]] = {"idx": len(sources) + 1, "title": src["title"] or src["url"]}
                            seen_urls.add(src["url"])
                        kept = [s for s in kept if s["url"] in sources]

                        results = await asyncio.gather(*[_process_source(subq, s) for s in kept])
                        bucket = collected.setdefault(subq, [])
                        for url, pts in results:
                            idx = sources[url]["idx"]
                            for p in pts:
                                bucket.append((idx, p))
                        answered.append(subq)

                    # gap-driven deepening
                    if level < depth and len(sources) < MAX_TOTAL_SOURCES:
                        yield evt("progress", msg="Analyse des lacunes…")
                        gap = await _chat_json(client, model, _gap_prompt(topic, answered, lang, per_level))
                        subqs = [str(q).strip() for q in (gap.get("subquestions") or [])
                                 if str(q).strip() and str(q).strip() not in answered][:per_level]
                        if subqs:
                            yield evt("progress", msg=f"Approfondissement niveau {level + 1} : {len(subqs)} question(s)")
                    else:
                        subqs = []
                    level += 1

                # Build the sourced corpus grouped by sub-question.
                blocks = []
                for subq, pts in collected.items():
                    if pts:
                        blocks.append(f"### {subq}\n" + "\n".join(f"[{idx}] {p}" for idx, p in pts))
                corpus = "\n\n".join(blocks)[:16000]
                if not corpus.strip():
                    yield evt("error", error="Aucune information exploitable trouvée.")
                    yield "data: [DONE]\n\n"
                    return

                # Final dense report.
                yield evt("progress", msg="Rédaction du rapport dense citée…")
                report = await _chat_text(client, model, _report_prompt(topic, intent, corpus, lang, body.length or "long"))

                src_list = sorted(sources.values(), key=lambda s: s["idx"])
                srcs = [{"idx": s["idx"], "title": s["title"],
                         "url": next(u for u, v in sources.items() if v["idx"] == s["idx"])} for s in src_list]
                sources_md = "\n".join(f"{s['idx']}. [{s['title']}]({s['url']})" for s in srcs)
                yield evt("document", content=report, intent=intent, sources=srcs,
                          sources_md=sources_md, subquestions=list(collected.keys()))
                yield "data: [DONE]\n\n"
        except Exception as e:
            yield evt("error", error=str(e))
            yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")
