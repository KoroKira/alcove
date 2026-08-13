"""Purpose-built video → structured report generator.

The generic `/structure-document` endpoint treats a video transcript like any
other article, which is why the resulting notes are flat and unverifiable.
This endpoint is the video-specific replacement: it knows about timestamps,
knows about chapters, and *forces* the model to cite `[MM:SS]` anchors so the
reader can jump back to any claim in the embedded player.

Pipeline:
  1. If the source has YouTube chapters → each chapter is one "chunk".
     Otherwise → chunk the timestamped transcript into ~4 minute windows.
  2. MAP: analyse each chunk with a strict-JSON prompt. Extract summary,
     key moments (with timestamp), quotes (with timestamp), entities.
  3. REDUCE: assemble everything into a Markdown report structured by
     chapters, with all timestamps preserved.

Streams progress via SSE for the UI, then emits the final Markdown."""
import json
import math
import asyncio
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from dependencies import UserSession, require_auth
from config import OLLAMA_URL, OLLAMA_DEFAULT_MODEL

from .generation import _parse_json_obj  # tolerant JSON extractor


router = APIRouter()


# ── Request shape ───────────────────────────────────────────────────────────

class TranscriptSegment(BaseModel):
    start: float
    end: float
    text: str
    speaker: Optional[str] = None  # set when diarization ran; e.g. "Intervenant 1"


class VideoChapter(BaseModel):
    title: str
    start_time: Optional[float] = None
    end_time: Optional[float] = None


class VideoReportRequest(BaseModel):
    title: str
    url: Optional[str] = None
    description: Optional[str] = ""
    author: Optional[str] = ""
    duration: Optional[float] = None
    chapters: List[VideoChapter] = []
    transcript_segments: List[TranscriptSegment] = []
    model: Optional[str] = None
    lang: Optional[str] = "fr"


# ── Helpers ─────────────────────────────────────────────────────────────────

def _fmt_hms(seconds: float) -> str:
    s = int(round(max(0.0, seconds)))
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def _stamp_segments(segments: List[TranscriptSegment]) -> str:
    """Render segments as one `[MM:SS] text` line each. Every 8 segments we
    insert a blank line, so the model visually chunks on paragraph breaks.

    When a segment carries a speaker label we emit `[MM:SS] Speaker: text` so
    the model can attribute quotes and moments in its output.
    """
    lines = []
    for i, s in enumerate(segments):
        if i and i % 8 == 0:
            lines.append("")
        prefix = f"[{_fmt_hms(s.start)}]"
        if s.speaker:
            lines.append(f"{prefix} {s.speaker} : {s.text.strip()}")
        else:
            lines.append(f"{prefix} {s.text.strip()}")
    return "\n".join(lines)


def _has_speakers(segments: List[TranscriptSegment]) -> bool:
    return any(s.speaker for s in segments)


def _chunks_from_chapters(
    chapters: List[VideoChapter],
    segments: List[TranscriptSegment],
    total_duration: Optional[float],
) -> List[dict]:
    """One chunk per YouTube chapter. Segments inside each chapter's [start,end)
    window get bundled with it. Chapters with zero segments (e.g. "Intro"
    that got skipped by the caption feed) are still kept so the outline is
    complete."""
    if not chapters:
        return []
    out = []
    for i, ch in enumerate(chapters):
        start = ch.start_time or 0.0
        end = ch.end_time or (
            chapters[i + 1].start_time
            if i + 1 < len(chapters) and chapters[i + 1].start_time is not None
            else total_duration or float("inf")
        )
        chapter_segments = [s for s in segments if s.start >= start and s.start < end]
        out.append({
            "title": ch.title,
            "start": start,
            "end": end if end != float("inf") else start,
            "segments": chapter_segments,
        })
    return out


def _chunks_by_time(
    segments: List[TranscriptSegment], window_seconds: float = 240.0, max_chunks: int = 12,
) -> List[dict]:
    """Fallback when the video has no YT chapters: cut the transcript into
    ~4min slices, keeping every chunk small enough to fit comfortably in the
    LLM's context, and capping the total count so map+reduce stays cheap."""
    if not segments:
        return []
    total = segments[-1].end - segments[0].start
    # Grow the window if we'd otherwise exceed max_chunks (long videos, ~2h+).
    if total / window_seconds > max_chunks:
        window_seconds = math.ceil(total / max_chunks / 30) * 30  # round up to 30s
    out = []
    cur_start = segments[0].start
    cur: list[TranscriptSegment] = []
    for s in segments:
        if s.start - cur_start >= window_seconds and cur:
            out.append({
                "title": f"{_fmt_hms(cur_start)} — {_fmt_hms(cur[-1].end)}",
                "start": cur_start,
                "end": cur[-1].end,
                "segments": cur,
            })
            cur = []
            cur_start = s.start
        cur.append(s)
    if cur:
        out.append({
            "title": f"{_fmt_hms(cur_start)} — {_fmt_hms(cur[-1].end)}",
            "start": cur_start,
            "end": cur[-1].end,
            "segments": cur,
        })
    return out


# ── LLM calls ───────────────────────────────────────────────────────────────

_MAP_INSTRUCTIONS_FR = (
    "Tu analyses un extrait de vidéo. Le texte ci-dessous est la transcription "
    "chronologique de cet extrait, chaque ligne préfixée par son timecode "
    "[MM:SS] ou [H:MM:SS]. IMPORTANT : conserve toujours les timecodes tels "
    "quels dans ta réponse — ce sont eux qui permettent au lecteur de vérifier "
    "chaque affirmation.\n\n"
    "Réponds STRICTEMENT en JSON, rien d'autre :\n"
    '{"summary": "2-3 phrases sur ce qui est dit dans cet extrait", '
    '"moments": [{"time": "MM:SS", "speaker": "Intervenant 1"|null, "point": "ce qui est dit/décidé/expliqué à ce moment"}], '
    '"quotes": [{"time": "MM:SS", "speaker": "Intervenant 1"|null, "text": "citation courte verbatim"}], '
    '"entities": ["personnes, œuvres, outils, concepts cités"]}\n\n'
    "- `moments` : 2 à 5 moments clés, dans l'ordre chronologique. Chaque "
    "  entrée doit correspondre à un vrai instant que l'on peut retrouver.\n"
    "- `quotes` : 0 à 2 citations verbatim COURTES (< 25 mots). N'INVENTE PAS.\n"
    "- `speaker` : reprends EXACTEMENT le libellé (ex. « Intervenant 1 ») "
    "  quand une ligne le mentionne ; sinon `null`.\n"
    "- `entities` : noms propres, produits, concepts. Vide si aucun.\n"
    "- Ne parle JAMAIS d'\"extrait\", de \"portion\" ou de \"partie\" dans tes phrases : "
    "  écris comme si tu résumais du contenu, pas comme si tu commentais une tâche."
)

_MAP_INSTRUCTIONS_EN = (
    "You are analyzing a segment of a video. The text below is the chronological "
    "transcript of this segment, each line prefixed with its `[MM:SS]` (or "
    "`[H:MM:SS]`) timestamp. IMPORTANT: always keep the timestamps verbatim in "
    "your reply — they let the reader verify every claim.\n\n"
    "Reply STRICTLY in JSON, nothing else:\n"
    '{"summary": "2-3 sentences on what is said in this segment", '
    '"moments": [{"time": "MM:SS", "speaker": "Speaker 1"|null, "point": "what is said/decided/explained at that moment"}], '
    '"quotes": [{"time": "MM:SS", "speaker": "Speaker 1"|null, "text": "short verbatim quote"}], '
    '"entities": ["people, works, tools, concepts mentioned"]}\n\n'
    "- `moments`: 2 to 5 key moments, chronological. Each must map to a real instant.\n"
    "- `quotes`: 0 to 2 SHORT verbatim quotes (< 25 words). NEVER invent.\n"
    "- `speaker`: reprint the exact label (e.g. \"Intervenant 1\") when a line "
    "  carries one; otherwise `null`.\n"
    "- `entities`: proper nouns, products, concepts. Empty if none.\n"
    "- Never say \"segment\", \"portion\" or \"part\" in your sentences — write as "
    "  if summarizing content, not commenting on a task."
)


async def _analyse_chapter(
    client: httpx.AsyncClient, model: str, chapter: dict, lang: str,
) -> dict:
    """MAP step for one chapter. Returns the parsed JSON dict (best-effort)."""
    if not chapter["segments"]:
        return {"title": chapter["title"], "start": chapter["start"], "end": chapter["end"],
                "summary": "", "moments": [], "quotes": [], "entities": []}

    stamped = _stamp_segments(chapter["segments"])
    header = (
        f"Titre du chapitre : « {chapter['title']} » "
        f"({_fmt_hms(chapter['start'])} → {_fmt_hms(chapter['end'])})\n\n"
        if lang == "fr" else
        f"Chapter title: “{chapter['title']}” "
        f"({_fmt_hms(chapter['start'])} → {_fmt_hms(chapter['end'])})\n\n"
    )
    instr = _MAP_INSTRUCTIONS_FR if lang == "fr" else _MAP_INSTRUCTIONS_EN
    prompt = f"{instr}\n\n{header}Transcription :\n{stamped[:8000]}"

    try:
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
        data = _parse_json_obj(resp.json().get("message", {}).get("content", ""))
    except Exception:
        data = {}

    def _speaker(x):
        v = x.get("speaker") if isinstance(x, dict) else None
        s = str(v).strip() if v not in (None, "", "null") else ""
        return s or None

    def _clean_moments(items):
        out = []
        for m in (items or []):
            if not isinstance(m, dict):
                continue
            t = str(m.get("time", "")).strip()
            p = str(m.get("point", "")).strip()
            if t and p:
                out.append({"time": t, "point": p, "speaker": _speaker(m)})
        return out[:5]

    def _clean_quotes(items):
        out = []
        for q in (items or []):
            if not isinstance(q, dict):
                continue
            t = str(q.get("time", "")).strip()
            tx = str(q.get("text", "")).strip()
            if t and tx and len(tx) < 400:
                out.append({"time": t, "text": tx, "speaker": _speaker(q)})
        return out[:2]

    return {
        "title": chapter["title"],
        "start": chapter["start"],
        "end": chapter["end"],
        "summary": str(data.get("summary", "")).strip(),
        "moments": _clean_moments(data.get("moments")),
        "quotes": _clean_quotes(data.get("quotes")),
        "entities": [str(x).strip() for x in (data.get("entities") or []) if str(x).strip()][:10],
    }


_REDUCE_PROMPT_FR = (
    "Tu es un éditeur. Tu reçois l'analyse chapitre par chapitre d'une vidéo, "
    "au format JSON. Rédige UN rapport de lecture Markdown, en français, dense "
    "et lisible.\n\n"
    "Contraintes STRICTES :\n"
    "- Conserve tous les timecodes tels quels (format `[MM:SS]` ou `[H:MM:SS]`).\n"
    "- Le rapport DOIT commencer par « ## Résumé » puis « ## Points clés » ; "
    "  saute directement dedans, sans phrase d'intro.\n"
    "- Écris comme si tu synthétisais un livre : à la 3e personne, sans dire "
    "  « la vidéo », « l'intervenant explique que », etc. Cite plutôt l'auteur "
    "  par son nom quand tu le connais.\n"
    "- Ne fabrique rien : si l'analyse ne contient pas quelque chose, ne l'invente pas.\n\n"
    "Structure attendue :\n"
    "## Résumé\n(3-5 phrases synthétisant l'apport global.)\n\n"
    "## Points clés\n(6-10 puces courtes, chacune préfixée de son `[MM:SS]`.)\n\n"
    "## Plan détaillé\n(Une sous-section `### [MM:SS] Titre du chapitre` par "
    "chapitre, avec 2-4 phrases de synthèse dedans, et des puces `[MM:SS] …` "
    "pour les moments notables.)\n\n"
    "## Citations notables\n(> `[MM:SS]` : citation. Une par ligne. Omet la "
    "section si vide.)\n\n"
    "## Entités / références\n(Puces plates : personnes, outils, œuvres cités.)\n\n"
    "## À creuser\n(3-5 questions ouvertes que le lecteur pourrait explorer, "
    "sans timecodes.)"
)

_REDUCE_PROMPT_EN = (
    "You are an editor. You receive the chapter-by-chapter analysis of a video "
    "as JSON. Write ONE Markdown reading report, in English, dense and readable.\n\n"
    "STRICT constraints:\n"
    "- Preserve every timestamp verbatim (`[MM:SS]` or `[H:MM:SS]`).\n"
    "- The report MUST start with `## Summary` then `## Key points`; jump right "
    "  in, no introductory sentence.\n"
    "- Write as if summarizing a book: third person, no \"the video\", \"the "
    "  speaker explains\". Prefer citing the author by name when known.\n"
    "- Do not invent. If the analysis doesn't say it, don't add it.\n\n"
    "Expected structure:\n"
    "## Summary\n(3-5 sentences.)\n\n"
    "## Key points\n(6-10 short bullets, each prefixed with `[MM:SS]`.)\n\n"
    "## Detailed outline\n(One `### [MM:SS] Chapter title` sub-section per "
    "chapter, with 2-4 sentences of synthesis and bullets `[MM:SS] …` for "
    "notable moments.)\n\n"
    "## Notable quotes\n(> `[MM:SS]`: quote. One per line. Omit if empty.)\n\n"
    "## Entities / references\n(Flat bullets: people, tools, works.)\n\n"
    "## Follow-ups\n(3-5 open questions the reader could explore, no timestamps.)"
)


async def _reduce_report(
    client: httpx.AsyncClient,
    model: str,
    analyses: List[dict],
    meta: VideoReportRequest,
) -> str:
    digest = json.dumps(
        [{
            "title": a["title"], "start": _fmt_hms(a["start"]), "end": _fmt_hms(a["end"]),
            "summary": a["summary"], "moments": a["moments"],
            "quotes": a["quotes"], "entities": a["entities"],
        } for a in analyses],
        ensure_ascii=False,
    )[:14000]

    speakers = sorted({
        m.get("speaker")
        for a in analyses
        for m in (a.get("moments") or []) + (a.get("quotes") or [])
        if m and m.get("speaker")
    })
    speaker_hint_fr = (
        f"\nIntervenants détectés : {', '.join(speakers)}. Quand un moment / une "
        "citation cite un intervenant, préfixe la ligne par son nom "
        "(ex. « [12:34] Intervenant 1 : … »).\n"
        if speakers else ""
    )
    speaker_hint_en = (
        f"\nSpeakers detected: {', '.join(speakers)}. When a moment / quote "
        "belongs to a speaker, prefix the line with their name "
        "(e.g. \"[12:34] Speaker 1: …\").\n"
        if speakers else ""
    )

    lang = meta.lang or "fr"
    if lang == "fr":
        header = (
            f"Titre : {meta.title}\n"
            f"Auteur/chaîne : {meta.author or '—'}\n"
            f"Durée : {_fmt_hms(meta.duration) if meta.duration else '—'}"
            f"{speaker_hint_fr}\n"
        )
        prompt = f"{_REDUCE_PROMPT_FR}\n\n{header}\nAnalyses :\n{digest}"
    else:
        header = (
            f"Title: {meta.title}\n"
            f"Author/channel: {meta.author or '—'}\n"
            f"Duration: {_fmt_hms(meta.duration) if meta.duration else '—'}"
            f"{speaker_hint_en}\n"
        )
        prompt = f"{_REDUCE_PROMPT_EN}\n\n{header}\nAnalyses:\n{digest}"

    resp = await client.post(
        f"{OLLAMA_URL}/api/chat",
        json={"model": model, "messages": [{"role": "user", "content": prompt}], "stream": False},
    )
    resp.raise_for_status()
    import re
    raw = resp.json().get("message", {}).get("content", "")
    raw = re.sub(r"<think>[\s\S]*?</think>", "", raw).strip()
    # Trim any chatty preamble before the first section heading.
    h = raw.find("## ")
    return raw[h:].strip() if h > 0 else raw


# ── Endpoint ────────────────────────────────────────────────────────────────

@router.get("/diarization-status")
async def diarization_status(_: UserSession = Depends(require_auth)):
    """Cheap probe the UI hits before showing the "detect speakers" checkbox.
    Doesn't load the model — just checks the import + token."""
    from services import diarization
    available, reason = diarization.is_available()
    return {"available": available, "reason": reason}


@router.post("/video-report")
async def video_report(body: VideoReportRequest, _: UserSession = Depends(require_auth)):
    """Produce a structured, timestamped Markdown report from a video's
    transcript + metadata. Streams progress via SSE, ends with a `document`
    event carrying the final report."""
    model = body.model or OLLAMA_DEFAULT_MODEL
    lang = body.lang or "fr"

    async def stream():
        def evt(kind: str, **kw) -> str:
            return f"data: {json.dumps({'kind': kind, **kw})}\n\n"

        if not body.transcript_segments:
            yield evt("error", error="Transcription vide — impossible d'analyser cette vidéo.")
            yield "data: [DONE]\n\n"
            return

        # 1. Build chunks — chapters first, time-slices as fallback.
        if body.chapters:
            chunks = _chunks_from_chapters(body.chapters, body.transcript_segments, body.duration)
            yield evt("progress", msg=f"📖 {len(chunks)} chapitre(s) YouTube détecté(s)")
        else:
            chunks = _chunks_by_time(body.transcript_segments)
            yield evt("progress", msg=f"⏱️ Découpage temporel : {len(chunks)} bloc(s) de ~4 min")

        # 2. MAP — analyse chunks concurrently, stream progress.
        try:
            async with httpx.AsyncClient(timeout=240) as client:
                results: list[Optional[dict]] = [None] * len(chunks)
                tasks = [
                    asyncio.ensure_future(_analyse_chapter(client, model, ch, lang))
                    for ch in chunks
                ]
                done = 0
                for coro in asyncio.as_completed(tasks):
                    res = await coro
                    # Preserve original order — find slot by (start, title).
                    for i, ch in enumerate(chunks):
                        if results[i] is None and ch["title"] == res["title"] and ch["start"] == res["start"]:
                            results[i] = res
                            break
                    done += 1
                    yield evt("progress", msg=f"Analyse {done}/{len(chunks)}…")

                # 3. REDUCE — one editor pass.
                yield evt("progress", msg="✍️ Rédaction du rapport…")
                report_md = await _reduce_report(client, model, [r for r in results if r], body)

            yield evt("document", content=report_md)
            yield "data: [DONE]\n\n"

        except Exception as e:
            yield evt("error", error=str(e))
            yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")
