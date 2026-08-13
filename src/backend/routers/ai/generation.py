"""Generation endpoints: everything that turns pad content into new text —
summaries, tags, titles, structured extracts, wikilink suggestions, flashcards,
quizzes, Mermaid diagrams. All share the same Ollama chat-completion shape."""
import re
import json
import math
import asyncio
from uuid import UUID
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select as sa_select
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import UserSession, require_auth
from config import OLLAMA_URL, OLLAMA_DEFAULT_MODEL
from database.database import get_session
from database.models.pad_model import PadStore

from ._shared import ensure_ollama_running, server_is_running


router = APIRouter()


# ── Pydantic models ─────────────────────────────────────────────────────────

class SummarizeRequest(BaseModel):
    model: Optional[str] = None
    content: str
    lang: Optional[str] = "fr"


class SuggestTagsRequest(BaseModel):
    model: Optional[str] = None
    content: str
    title: str
    lang: Optional[str] = "fr"


class TitleRequest(BaseModel):
    model: Optional[str] = None
    content: str
    lang: Optional[str] = "fr"


class ExtractInfoRequest(BaseModel):
    model: Optional[str] = None
    content: str
    lang: Optional[str] = "fr"


class StructureDocRequest(BaseModel):
    model: Optional[str] = None
    content: str
    title: Optional[str] = ""
    lang: Optional[str] = "fr"
    length: Optional[str] = "long"  # "short" | "long"


class SuggestLinksRequest(BaseModel):
    model: Optional[str] = None
    content: str
    pad_titles: List[str]
    lang: Optional[str] = "fr"


class GenerateFlashcardsRequest(BaseModel):
    model: Optional[str] = None
    content: str
    lang: Optional[str] = "fr"


class QuizExtractRequest(BaseModel):
    pad_ids: List[str]


class QuizGenerateRequest(BaseModel):
    pad_ids: List[str]
    topic: Optional[str] = None
    lang: Optional[str] = "fr"
    n: Optional[int] = 8


class GenerateDiagramRequest(BaseModel):
    model: Optional[str] = None
    content: str
    kind: Optional[str] = None  # e.g. "flowchart", "sequence", "mindmap" — free text hint, optional
    lang: Optional[str] = "fr"


_MERMAID_KINDS = "flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, mindmap, or pie"


# ── Summarize (streaming) ───────────────────────────────────────────────────

@router.post("/summarize")
async def summarize(body: SummarizeRequest, _: UserSession = Depends(require_auth)):
    model = body.model or OLLAMA_DEFAULT_MODEL
    lang_instr = "in French" if body.lang == "fr" else "in English"
    prompt = (
        f"Summarize the following document concisely {lang_instr}, "
        f"in 3-5 bullet points. Do not add any preamble.\n\n{body.content[:8000]}"
    )

    async def stream():
        if not await server_is_running():
            if not await ensure_ollama_running(12):
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


# ── Suggest tags ────────────────────────────────────────────────────────────

@router.post("/suggest-tags")
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


# ── Title ───────────────────────────────────────────────────────────────────

@router.post("/title")
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


# ── Extract structured info (from a YT description, etc.) ───────────────────

@router.post("/extract-info")
async def extract_info(body: ExtractInfoRequest, _: UserSession = Depends(require_auth)):
    """Extract structured key info (people, theme, sources) from a text — handy
    for a YouTube description that names speakers, topics and links."""
    model = body.model or OLLAMA_DEFAULT_MODEL
    # Deterministic: pull URLs straight out of the text (dedup, keep order).
    urls = list(dict.fromkeys(re.findall(r"https?://[^\s)\]<>\"']+", body.content)))[:15]

    if body.lang == "fr":
        prompt = (
            "À partir du texte ci-dessous (souvent une description de vidéo), extrais en français :\n"
            "- **Intervenants** : personnes / invités / auteurs cités\n"
            "- **Thème** : le sujet principal en une phrase\n"
            "- **Points clés** : 3 à 5 puces\n"
            "Réponds en Markdown avec ces sections. Sois concis. N'invente rien : si une info manque, écris « — ».\n\n"
            f"{body.content[:6000]}"
        )
    else:
        prompt = (
            "From the text below (often a video description), extract:\n"
            "- **People**: speakers / guests / authors mentioned\n"
            "- **Theme**: the main topic in one sentence\n"
            "- **Key points**: 3 to 5 bullets\n"
            "Reply in Markdown with these sections. Be concise. Do not invent: use \"—\" if missing.\n\n"
            f"{body.content[:6000]}"
        )
    info = ""
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{OLLAMA_URL}/api/chat",
                json={"model": model, "messages": [{"role": "user", "content": prompt}], "stream": False},
            )
            resp.raise_for_status()
            info = resp.json().get("message", {}).get("content", "")
            info = re.sub(r"<think>[\s\S]*?</think>", "", info).strip()
    except Exception as e:
        return {"info": "", "urls": urls, "error": str(e)}

    if urls:
        info += "\n\n**Sources / liens**\n\n" + "\n".join(f"- {u}" for u in urls)
    return {"info": info, "urls": urls}


# ── Structured document (map-reduce) ────────────────────────────────────────
# "One AI per portion + a mother AI": each chunk is analysed independently
# (MAP), then a single synthesis pass (REDUCE) merges everything into a coherent
# structured note. Handles long content (no 8k truncation) and yields a real
# document skeleton instead of a flat bullet list.


def _chunk_for_map(text: str, target_chars: int = 6000, max_chunks: int = 10) -> list[str]:
    """Split on paragraph boundaries into ~target_chars chunks, capped."""
    text = (text or "").strip()
    if not text:
        return []
    paras = re.split(r"\n\s*\n", text)
    chunks: list[str] = []
    cur = ""
    for p in paras:
        if cur and len(cur) + len(p) > target_chars:
            chunks.append(cur.strip())
            cur = ""
        cur += p + "\n\n"
    if cur.strip():
        chunks.append(cur.strip())
    if len(chunks) > max_chunks:
        group = math.ceil(len(chunks) / max_chunks)
        chunks = ["\n\n".join(chunks[i:i + group]) for i in range(0, len(chunks), group)]
    return chunks


def _parse_json_obj(raw: str) -> dict:
    """Tolerant: pull the first {...} block out of a model reply."""
    raw = re.sub(r"<think>[\s\S]*?</think>", "", raw or "")
    start, end = raw.find("{"), raw.rfind("}") + 1
    if start >= 0 and end > start:
        try:
            return json.loads(raw[start:end])
        except Exception:
            return {}
    return {}


async def _map_chunk(client, model: str, idx: int, chunk: str, lang: str) -> tuple[int, dict]:
    instr = "en français" if lang == "fr" else "in English"
    prompt = (
        f"Tu analyses UNE portion d'un document plus long. Extrais uniquement ce qui est dans cette portion, {instr}.\n"
        "Réponds STRICTEMENT en JSON, rien d'autre :\n"
        '{"summary": "2-3 phrases", "points": ["..."], "entities": ["..."], "quotes": ["..."]}\n'
        "N'invente rien. `quotes` = citations verbatim courtes (0-2), sinon [].\n\n"
        f"Portion :\n{chunk}"
    )
    try:
        resp = await client.post(
            f"{OLLAMA_URL}/api/chat",
            json={"model": model, "messages": [{"role": "user", "content": prompt}],
                  "stream": False, "format": "json"},
        )
        resp.raise_for_status()
        data = _parse_json_obj(resp.json().get("message", {}).get("content", ""))
        return idx, {
            "summary": str(data.get("summary", "")).strip(),
            "points": [str(x).strip() for x in (data.get("points") or []) if str(x).strip()][:6],
            "entities": [str(x).strip() for x in (data.get("entities") or []) if str(x).strip()][:8],
            "quotes": [str(x).strip() for x in (data.get("quotes") or []) if str(x).strip()][:2],
        }
    except Exception:
        return idx, {"summary": "", "points": [], "entities": [], "quotes": []}


async def _reduce_chunks(client, model: str, results: list[dict], title: str, lang: str,
                         length: str = "long") -> str:
    digest = json.dumps(results, ensure_ascii=False)[:12000]
    short = length == "short"
    if lang == "fr":
        sections = (
            "## TL;DR\n(2-3 phrases)\n## Points clés\n(3-5 puces)\n## À retenir\n(puces actionnables)"
            if short else
            "## TL;DR\n(2-3 phrases)\n## Points clés\n(puces)\n## Plan détaillé\n(sections ### thématiques avec le détail)\n"
            "## Intervenants / entités\n(puces)\n## Citations notables\n(> citations, ou « — »)\n## À retenir\n(puces actionnables)"
        )
        prompt = (
            "Tu es un éditeur. À partir des analyses de portions ci-dessous (JSON), rédige UNE note Markdown "
            "cohérente et structurée en français. Fusionne, dédoublonne, ordonne logiquement. N'invente rien.\n"
            f"Produis EXACTEMENT ces sections (garde les titres, omets une section si vraiment vide) :\n{sections}\n\n"
            f"{'Sois CONCIS.' if short else 'Sois complet et détaillé.'} "
            "Commence DIRECTEMENT par « ## TL;DR », sans aucune phrase d'introduction.\n\n"
            f"Titre du document : {title}\n\nAnalyses :\n{digest}"
        )
    else:
        sections = (
            "## TL;DR\n## Key points\n## Takeaways"
            if short else
            "## TL;DR\n## Key points\n## Detailed outline\n(thematic ### sections)\n## People / entities\n"
            "## Notable quotes\n## Takeaways"
        )
        prompt = (
            "You are an editor. From the per-portion analyses below (JSON), write ONE coherent, structured "
            "Markdown note in English. Merge, dedupe, order logically. Do not invent.\n"
            f"Produce EXACTLY these sections (keep the headings, omit one only if truly empty):\n{sections}\n\n"
            f"{'Be CONCISE.' if short else 'Be thorough and detailed.'} "
            "Start DIRECTLY with \"## TL;DR\", no introductory sentence.\n\n"
            f"Document title: {title}\n\nAnalyses:\n{digest}"
        )
    resp = await client.post(
        f"{OLLAMA_URL}/api/chat",
        json={"model": model, "messages": [{"role": "user", "content": prompt}], "stream": False},
    )
    resp.raise_for_status()
    out = re.sub(r"<think>[\s\S]*?</think>", "", resp.json().get("message", {}).get("content", "")).strip()
    # Drop any chatty preamble before the first Markdown heading.
    h = out.find("## ")
    return out[h:].strip() if h > 0 else out


@router.post("/structure-document")
async def structure_document(body: StructureDocRequest, _: UserSession = Depends(require_auth)):
    """Map-reduce structured summary. Streams progress, then the final Markdown."""
    model = body.model or OLLAMA_DEFAULT_MODEL
    lang = body.lang or "fr"
    title = body.title or ""
    chunks = _chunk_for_map(body.content)

    async def stream():
        def evt(kind: str, **kw) -> str:
            return f"data: {json.dumps({'kind': kind, **kw})}\n\n"

        if not chunks:
            yield evt("document", content="")
            yield "data: [DONE]\n\n"
            return

        try:
            async with httpx.AsyncClient(timeout=180) as client:
                results: list[Optional[dict]] = [None] * len(chunks)
                yield evt("progress", msg=f"Découpage en {len(chunks)} portion(s)…")

                # MAP — concurrent; stream progress as each portion completes.
                tasks = [asyncio.ensure_future(_map_chunk(client, model, i, c, lang))
                         for i, c in enumerate(chunks)]
                done = 0
                for fut in asyncio.as_completed(tasks):
                    idx, res = await fut
                    results[idx] = res
                    done += 1
                    yield evt("progress", msg=f"Analyse {done}/{len(chunks)}…")

                clean = [r for r in results if r]
                # Short content (single portion): skip the reduce, format directly.
                yield evt("progress", msg="Synthèse (IA mère)…")
                body_md = await _reduce_chunks(client, model, clean, title, lang, body.length or "long")
                yield evt("document", content=body_md)
                yield "data: [DONE]\n\n"
        except Exception as e:
            yield evt("error", error=str(e))
            yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


# ── Suggest links ───────────────────────────────────────────────────────────

@router.post("/suggest-links")
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


# ── Flashcards / Quiz ───────────────────────────────────────────────────────

def _extract_doc_content(row: PadStore) -> str:
    """Pull the markdown content out of a document pad, tolerating str-encoded JSON."""
    if isinstance(row.data, dict):
        return row.data.get("content", "") or ""
    if isinstance(row.data, str):
        try:
            return json.loads(row.data).get("content", "") or ""
        except Exception:
            return ""
    return ""


@router.post("/quiz/extract")
async def quiz_extract(
    body: QuizExtractRequest,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """Extract existing Q:/A: pairs from multiple document pads."""
    result = []
    for pid_str in body.pad_ids:
        try:
            pid = UUID(pid_str)
        except Exception:
            continue
        stmt = sa_select(PadStore).where(PadStore.id == pid, PadStore.owner_id == user.id)
        row = (await session.execute(stmt)).scalar_one_or_none()
        if not row or row.pad_type != "document":
            continue
        content = _extract_doc_content(row)
        pairs = []
        for m in re.finditer(r'^Q:[ \t]*(.+?)\n^A:[ \t]*(.+)', content, re.MULTILINE):
            pairs.append({"q": m.group(1).strip(), "a": m.group(2).strip()})
        if pairs:
            result.append({"padId": str(row.id), "padName": row.display_name or "Sans titre", "cards": pairs})
    return {"decks": result}


@router.post("/quiz/generate")
async def quiz_generate(
    body: QuizGenerateRequest,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """AI-generate Q:/A: flashcards from multiple document pads."""
    contents = []
    for pid_str in body.pad_ids:
        try:
            pid = UUID(pid_str)
        except Exception:
            continue
        stmt = sa_select(PadStore).where(PadStore.id == pid, PadStore.owner_id == user.id)
        row = (await session.execute(stmt)).scalar_one_or_none()
        if not row or row.pad_type != "document":
            continue
        content = _extract_doc_content(row)
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


@router.post("/generate-flashcards")
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
            if "Q:" in raw and "A:" in raw:
                return {"flashcards": raw.strip()}
            return {"flashcards": "", "error": "No flashcards generated"}
    except Exception as e:
        return {"flashcards": "", "error": str(e)}


# ── Diagram ─────────────────────────────────────────────────────────────────

@router.post("/generate-diagram")
async def generate_diagram(body: GenerateDiagramRequest, _: UserSession = Depends(require_auth)):
    """Generate a Mermaid diagram (as a ```mermaid code block) from document content."""
    model = body.model or OLLAMA_DEFAULT_MODEL
    kind_instr = (
        f"Use a Mermaid \"{body.kind}\" diagram." if body.kind
        else f"Pick whichever Mermaid diagram type ({_MERMAID_KINDS}) best represents this content."
    )

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
