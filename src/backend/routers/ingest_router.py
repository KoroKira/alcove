"""Content ingestion — turn an external source (web page, PDF, YouTube video)
into Markdown + metadata that the frontend can drop into a pad.

Design: these endpoints ONLY fetch and extract. Pad creation and the "what do
you want to do with it" AI actions (summarize / tags / flashcards / RAG) are
driven from the frontend, reusing the existing /api/ai/* endpoints.

Privacy: the only outbound traffic is this server fetching the *public* source
the user asked for. Nothing of the user's data leaves the machine; all AI
processing stays on Ollama (and, for Phase 2, a local Whisper model).
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
import shutil
import tempfile
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from dependencies import UserSession, require_auth
from routers.ai.clip import _MarkdownExtractor  # reuse the stdlib readability

logger = logging.getLogger(__name__)

ingest_router = APIRouter(prefix="/api/ingest")

_UA = "Mozilla/5.0 (alcove ingest)"
_MAX_CHARS = 200_000


class IngestUrlRequest(BaseModel):
    url: str


# ── Web ─────────────────────────────────────────────────────────────────────

# Meta tags that carry the "hero image" of a page — checked in priority
# order. og:image is the standard ; twitter:image is the fallback for
# sites that only ship a Twitter card ; og:image:secure_url wins over
# og:image when a page ships both (spec says the https variant is
# preferred). Regex covers both attribute orderings (property/name first
# vs content first) since HTML lets you write them either way.
_OG_IMAGE_META_NAMES = ("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src")


def _extract_og_image(html: str, base_url: str) -> Optional[str]:
    """Pull the first hero image URL from a page's <meta> tags. Returns
    an absolute URL (protocol-relative and root-relative sources get
    resolved against base_url). None if nothing matches."""
    # Attributes can appear in any order — try both.
    patterns = []
    for name in _OG_IMAGE_META_NAMES:
        esc = re.escape(name)
        patterns.append(re.compile(
            rf'<meta[^>]+(?:property|name)=["\']{esc}["\'][^>]+content=["\']([^"\']+)["\']',
            re.IGNORECASE,
        ))
        patterns.append(re.compile(
            rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']{esc}["\']',
            re.IGNORECASE,
        ))
    for pat in patterns:
        m = pat.search(html)
        if m:
            src = m.group(1).strip()
            if not src:
                continue
            if src.startswith("//"):
                return "https:" + src
            if src.startswith("/"):
                from urllib.parse import urlparse
                p = urlparse(base_url)
                return f"{p.scheme}://{p.netloc}{src}"
            if src.startswith(("http://", "https://")):
                return src
    return None


def _reddit_comments_to_markdown(children: list[dict], depth: int = 0, max_comments: int = 15) -> list[str]:
    """Flatten Reddit's nested comment tree into a depth-indented list,
    capped at max_comments top-level-equivalent entries so a huge thread
    doesn't blow past _MAX_CHARS. "more" stub nodes (Reddit's "load more
    comments" placeholders) are skipped — they carry no text."""
    lines: list[str] = []
    count = 0
    for child in children:
        if count >= max_comments:
            break
        if child.get("kind") != "t1":
            continue
        data = child.get("data", {})
        body = (data.get("body") or "").strip()
        author = data.get("author", "[deleted]")
        if body and body != "[deleted]" and body != "[removed]":
            indent = "  " * depth
            lines.append(f"{indent}- **{author}** : {body[:600]}")
            count += 1
        replies = data.get("replies")
        if isinstance(replies, dict):
            nested = replies.get("data", {}).get("children", [])
            lines.extend(_reddit_comments_to_markdown(nested, depth + 1, max_comments - count))
    return lines


async def _fetch_reddit(url: str) -> dict:
    """Reddit posts expose their full thread as public JSON at
    `{permalink}.json` — no auth, no API key, just the same URL a browser
    would load with `.json` appended. Returns {title, markdown, metadata,
    source_type} matching fetch_web's shape so callers don't need to know
    the source was Reddit rather than a generic page."""
    json_url = url.split("?")[0].rstrip("/") + ".json"
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
            resp = await client.get(json_url, headers={"User-Agent": _UA}, params={"raw_json": 1})
            resp.raise_for_status()
            data = resp.json()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Impossible de récupérer le post Reddit : {e}")

    if not isinstance(data, list) or len(data) < 1:
        raise HTTPException(502, "Réponse Reddit inattendue.")

    post = data[0]["data"]["children"][0]["data"]
    title = post.get("title", "Post Reddit")
    subreddit = post.get("subreddit_name_prefixed", post.get("subreddit", ""))
    author = post.get("author", "[deleted]")
    score = post.get("score", 0)
    selftext = (post.get("selftext") or "").strip()
    external_url = post.get("url_overridden_by_dest") or post.get("url", "")
    permalink = f"https://www.reddit.com{post.get('permalink', '')}"

    parts = [f"**{subreddit}** · posté par u/{author} · {score} points", ""]
    if selftext:
        parts.append(selftext)
    elif external_url and external_url != permalink:
        parts.append(f"Lien externe : {external_url}")
    parts.append("")

    comments = data[1]["data"]["children"] if len(data) > 1 else []
    comment_lines = _reddit_comments_to_markdown(comments)
    if comment_lines:
        parts.append("## Commentaires")
        parts.append("")
        parts.extend(comment_lines)

    markdown = "\n".join(parts)
    if len(markdown) > _MAX_CHARS:
        markdown = markdown[:_MAX_CHARS] + "\n\n*[contenu tronqué]*"

    thumb = post.get("thumbnail")
    meta: dict[str, Any] = {"source_url": permalink}
    if thumb and thumb.startswith("http"):
        meta["thumbnail"] = thumb

    return {"title": title, "markdown": markdown, "metadata": meta, "source_type": "reddit"}


async def fetch_web(url: str) -> dict:
    """Fetch a web page (or raw text/markdown file) → {title, markdown}."""
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "URL invalide (http/https uniquement)")
    # Reddit posts: pull the public JSON thread (post + top comments) instead
    # of scraping the client-rendered HTML, which readability can't parse.
    if re.match(r"https?://(www\.|old\.)?reddit\.com/r/[^/]+/comments/", url):
        return await _fetch_reddit(url)
    # GitHub blob pages: fetch the raw file instead of the HTML viewer.
    gh = re.match(r"https://github\.com/([^/]+/[^/]+)/blob/(.+)", url)
    if gh:
        url = f"https://raw.githubusercontent.com/{gh.group(1)}/{gh.group(2)}"
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
            resp = await client.get(url, headers={"User-Agent": _UA})
            resp.raise_for_status()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Impossible de récupérer la page : {e}")

    ctype = resp.headers.get("content-type", "")
    if "html" not in ctype:
        return {
            "title": url.rsplit("/", 1)[-1] or url,
            "markdown": resp.text[:_MAX_CHARS],
            "metadata": {"source_url": url},
            "source_type": "web",
        }
    html = resp.text[:1_500_000]
    title, markdown = _MarkdownExtractor().extract(html)
    if len(markdown) > _MAX_CHARS:
        markdown = markdown[:_MAX_CHARS] + "\n\n*[contenu tronqué]*"
    meta: dict[str, Any] = {"source_url": url}
    og = _extract_og_image(html, url)
    if og:
        meta["thumbnail"] = og
    return {
        "title": title or url,
        "markdown": markdown,
        "metadata": meta,
        "source_type": "web",
    }


@ingest_router.post("/web")
async def ingest_web(body: IngestUrlRequest, _: UserSession = Depends(require_auth)):
    return await fetch_web(body.url)


# ── PDF ─────────────────────────────────────────────────────────────────────

def extract_pdf(data: bytes) -> tuple[str, str]:
    """(title, text) from a PDF byte string. Empty text ⇒ likely scanned."""
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    meta_title = ""
    try:
        meta_title = (reader.metadata.title or "") if reader.metadata else ""
    except Exception:
        meta_title = ""
    parts = []
    for page in reader.pages:
        try:
            t = page.extract_text() or ""
        except Exception:
            t = ""
        if t.strip():
            parts.append(t.strip())
    return meta_title, "\n\n".join(parts)


def render_pdf_cover(data: bytes, max_width: int = 640) -> Optional[str]:
    """Render page 1 of a PDF to a base64 JPEG data URI, ~640px wide.

    Powers the Dashboard card thumbnail — an actual cover page carries so
    much more identity signal than a generic PDF icon that the extra tens
    of KB in the DB row pays for itself immediately. Silent None on any
    failure : the frontend already handles a missing thumbnail cleanly.
    """
    try:
        import pypdfium2 as pdfium
        from PIL import Image
        import base64
        pdf = pdfium.PdfDocument(data)
        if len(pdf) == 0:
            return None
        page = pdf[0]
        # Scale so the wider dimension lands near max_width — pypdfium2 uses
        # a "scale" multiplier over the base 72 DPI, so scale = target_px /
        # (page_width_pt). One render, no PIL resample.
        w_pt = page.get_width()
        scale = max_width / max(w_pt, 1.0)
        pil_img = page.render(scale=scale).to_pil().convert("RGB")
        buf = io.BytesIO()
        pil_img.save(buf, format="JPEG", quality=78, optimize=True)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return f"data:image/jpeg;base64,{b64}"
    except Exception:
        return None


@ingest_router.post("/pdf")
async def ingest_pdf(
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
    _: UserSession = Depends(require_auth),
):
    src_url = None
    filename = "document.pdf"
    if file is not None:
        data = await file.read()
        filename = file.filename or filename
    elif url:
        src_url = url.strip()
        if not src_url.startswith(("http://", "https://")):
            raise HTTPException(400, "URL invalide (http/https uniquement)")
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
                resp = await client.get(src_url, headers={"User-Agent": _UA})
                resp.raise_for_status()
        except Exception as e:
            raise HTTPException(502, f"Impossible de récupérer le PDF : {e}")
        data = resp.content
        filename = src_url.rsplit("/", 1)[-1] or filename
    else:
        raise HTTPException(400, "Fournir un fichier PDF ou une URL")

    title, text = await run_in_threadpool(extract_pdf, data)
    if not text.strip():
        raise HTTPException(
            422,
            "Aucun texte extractible (PDF probablement scanné — l'OCR n'est pas géré ici).",
        )
    cover = await run_in_threadpool(render_pdf_cover, data)
    meta: dict[str, Any] = {"source_url": src_url, "filename": filename}
    if cover:
        meta["thumbnail"] = cover
    return {
        "title": title or filename,
        "markdown": text[:_MAX_CHARS],
        "metadata": meta,
        "source_type": "pdf",
    }


# ── YouTube ─────────────────────────────────────────────────────────────────

def parse_json3_captions(payload: dict) -> str:
    """YouTube json3 caption payload → plain transcript text."""
    lines = []
    for ev in payload.get("events", []):
        segs = ev.get("segs") or []
        text = "".join(s.get("utf8", "") for s in segs).strip()
        if text and text != "\n":
            lines.append(text)
    # Collapse the word-by-word cascades auto-captions produce.
    return "\n".join(lines)


def parse_vtt_captions(vtt: str) -> str:
    """Minimal WebVTT → plain transcript text (dedup consecutive lines)."""
    out, last = [], None
    for raw in vtt.splitlines():
        line = raw.strip()
        if (not line or line == "WEBVTT" or "-->" in line
                or line.isdigit() or line.startswith(("NOTE", "Kind:", "Language:"))):
            continue
        line = re.sub(r"<[^>]+>", "", line)  # strip <c>/<00:00:00.000> tags
        if line and line != last:
            out.append(line)
            last = line
    return "\n".join(out)


# ── Timestamped caption parsing ────────────────────────────────────────────
#
# Same content as the plain parsers above, but preserves per-caption timing so
# downstream code can feed the LLM a transcript the model can cite from, and
# so the UI can render clickable jump-to-timestamp buttons.

def parse_json3_segments(payload: dict) -> list[dict]:
    """YouTube json3 → [{start, end, text}] in seconds."""
    out = []
    for ev in payload.get("events", []):
        segs = ev.get("segs") or []
        text = "".join(s.get("utf8", "") for s in segs).strip()
        if not text or text == "\n":
            continue
        start_ms = ev.get("tStartMs")
        dur_ms = ev.get("dDurationMs") or 0
        if start_ms is None:
            continue
        start = start_ms / 1000.0
        out.append({"start": start, "end": start + dur_ms / 1000.0, "text": text})
    return out


_VTT_TS_RE = re.compile(
    r"(?P<start>\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(?P<end>\d{2}:\d{2}:\d{2}\.\d{3})"
)


def _vtt_time_to_seconds(ts: str) -> float:
    h, m, s = ts.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def parse_vtt_segments(vtt: str) -> list[dict]:
    """WebVTT → [{start, end, text}]. Dedups consecutive identical cues."""
    out: list[dict] = []
    lines = vtt.splitlines()
    i = 0
    last_text: Optional[str] = None
    while i < len(lines):
        line = lines[i].strip()
        m = _VTT_TS_RE.search(line)
        if not m:
            i += 1
            continue
        start = _vtt_time_to_seconds(m.group("start"))
        end = _vtt_time_to_seconds(m.group("end"))
        i += 1
        buf: list[str] = []
        while i < len(lines) and lines[i].strip() != "":
            cue = re.sub(r"<[^>]+>", "", lines[i]).strip()
            if cue:
                buf.append(cue)
            i += 1
        text = " ".join(buf).strip()
        if text and text != last_text:
            out.append({"start": start, "end": end, "text": text})
            last_text = text
    return out


def format_hms(seconds: float) -> str:
    """Format seconds as `MM:SS` (or `HH:MM:SS` past the hour)."""
    s = int(round(max(0.0, seconds)))
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h:d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def segments_to_markdown(segments: list[dict], group_every_seconds: float = 30.0) -> str:
    """Render segments as `[MM:SS] text\\n[MM:SS] text` grouped every ~30s so
    the LLM sees a manageable number of anchor points and the reader gets a
    readable transcript (raw per-caption lines are too dense)."""
    if not segments:
        return ""
    out: list[str] = []
    bucket: list[str] = []
    bucket_start = segments[0]["start"]
    for seg in segments:
        if bucket and seg["start"] - bucket_start >= group_every_seconds:
            out.append(f"[{format_hms(bucket_start)}] " + " ".join(bucket))
            bucket = []
            bucket_start = seg["start"]
        bucket.append(seg["text"])
    if bucket:
        out.append(f"[{format_hms(bucket_start)}] " + " ".join(bucket))
    return "\n".join(out)


def _pick_caption_track(info: dict) -> Optional[list]:
    """Best available caption track (manual > auto; fr/en preferred)."""
    for source in ("subtitles", "automatic_captions"):
        tracks = info.get(source) or {}
        for lang in ("fr", "fr-FR", "en", "en-US", "en-GB"):
            if tracks.get(lang):
                return tracks[lang]
        for _lang, fmts in tracks.items():
            if fmts:
                return fmts
    return None


def _caption_fmt_url(fmts: list) -> tuple[Optional[str], Optional[str]]:
    """Pick a fetchable caption URL, preferring json3, then vtt. → (url, ext)."""
    for ext in ("json3", "vtt", "srv3"):
        for f in fmts:
            if f.get("ext") == ext and f.get("url"):
                return f["url"], ext
    if fmts and fmts[0].get("url"):
        return fmts[0]["url"], fmts[0].get("ext")
    return None, None


def _extract_youtube_info(url: str) -> dict:
    """Blocking yt-dlp metadata extraction (run me in a threadpool)."""
    import yt_dlp

    opts = {
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["fr", "en"],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(url, download=False)


# Standard YouTube video-id shapes: watch?v=..., youtu.be/..., embed/, shorts/,
# live/, v/. Anything that survives is treated as opaque.
_YT_ID_RE = re.compile(
    r"(?:v=|youtu\.be/|/embed/|/shorts/|/live/|/v/)([A-Za-z0-9_-]{11})"
)


def _extract_video_id(url: str) -> Optional[str]:
    m = _YT_ID_RE.search(url or "")
    return m.group(1) if m else None


def _pick_thumbnail(info: dict, video_id: Optional[str]) -> Optional[str]:
    """Highest-resolution thumbnail from yt-dlp's list, falling back to the
    predictable maxresdefault URL when we have the video id."""
    thumbs = info.get("thumbnails") or []
    if thumbs:
        # yt-dlp orders low → high; pick highest with a real URL.
        for t in reversed(thumbs):
            if t.get("url"):
                return t["url"]
    if video_id:
        return f"https://i.ytimg.com/vi/{video_id}/maxresdefault.jpg"
    return info.get("thumbnail")


@ingest_router.post("/youtube")
async def ingest_youtube(body: IngestUrlRequest, _: UserSession = Depends(require_auth)):
    url = body.url.strip()
    if "youtube.com" not in url and "youtu.be" not in url:
        raise HTTPException(400, "URL YouTube attendue")
    try:
        info = await run_in_threadpool(_extract_youtube_info, url)
    except Exception as e:
        raise HTTPException(502, f"Impossible de lire la vidéo : {e}")

    title = info.get("title") or url
    description = (info.get("description") or "").strip()
    uploader = info.get("uploader") or info.get("channel") or ""
    duration = info.get("duration")
    upload_date = info.get("upload_date")  # YYYYMMDD
    webpage_url = info.get("webpage_url") or url
    video_id = _extract_video_id(webpage_url) or _extract_video_id(url)
    thumbnail = _pick_thumbnail(info, video_id)

    # Chapters — preserve start_time so the UI can jump to them and the
    # report generator can anchor its structure on them.
    raw_chapters = info.get("chapters") or []
    chapters: list[dict] = []
    for c in raw_chapters:
        t = (c.get("title") or "").strip()
        if not t:
            continue
        start = c.get("start_time")
        chapters.append({
            "title": t,
            "start_time": float(start) if start is not None else None,
            "end_time": float(c["end_time"]) if c.get("end_time") is not None else None,
        })

    # Transcript: fetch a caption track and parse it — both a plain text form
    # (backward compat) and a timestamped segment list (for the report + UI).
    transcript = ""
    transcript_segments: list[dict] = []
    track = _pick_caption_track(info)
    if track:
        cap_url, ext = _caption_fmt_url(track)
        if cap_url:
            try:
                async with httpx.AsyncClient(follow_redirects=True, timeout=20) as client:
                    r = await client.get(cap_url, headers={"User-Agent": _UA})
                    r.raise_for_status()
                if ext == "json3":
                    payload = r.json()
                    transcript = parse_json3_captions(payload)
                    transcript_segments = parse_json3_segments(payload)
                else:
                    transcript = parse_vtt_captions(r.text)
                    transcript_segments = parse_vtt_segments(r.text)
            except Exception:
                transcript = ""
                transcript_segments = []

    # Assemble the Markdown body. Timestamped transcript ([MM:SS] anchors) so
    # the report generator has verifiable source moments and the UI can turn
    # them into clickable jumps.
    md: list[str] = []
    if description:
        md.append("## Description\n\n" + description)
    if chapters:
        md.append("## Chapitres\n\n" + "\n".join(
            f"- [{format_hms(c['start_time'])}] {c['title']}" if c.get("start_time") is not None
            else f"- {c['title']}"
            for c in chapters
        ))
    if transcript_segments:
        formatted = segments_to_markdown(transcript_segments)
        md.append("## Transcription\n\n" + formatted[:_MAX_CHARS])
    elif transcript:
        md.append("## Transcription\n\n" + transcript[:_MAX_CHARS])
    else:
        md.append(
            "> [!NOTE]\n> Aucun sous-titre disponible pour cette vidéo. "
            "Utilise « Transcrire localement » pour lancer Whisper."
        )

    return {
        "title": title,
        "markdown": "\n\n".join(md),
        "metadata": {
            "source_url": webpage_url,
            "video_id": video_id,
            "thumbnail": thumbnail,
            "author": uploader,
            "duration": duration,
            "upload_date": upload_date,
            "chapters": chapters,
            "has_transcript": bool(transcript_segments or transcript),
            "transcript_segments": transcript_segments,
        },
        "source_type": "youtube",
    }


# ── YouTube — Whisper fallback (Phase 2) ────────────────────────────────────
# When a video has no captions, download its audio and transcribe it locally
# with faster-whisper. Model is fetched from HuggingFace on first use (~small =
# 465 MB) and cached; everything runs on-device, nothing leaves the machine.

_WHISPER_MODEL_NAME = os.getenv("WHISPER_MODEL", "small")
_whisper_pipeline = None  # lazily-loaded singleton (model + batched-inference wrapper)

# Serializes whisper compute across concurrent requests (batch uploads, multiple
# tabs...). Running two transcriptions at once doesn't parallelize on CPU — it
# just makes both slower (measured: forcing more threads caused SMT contention).
# Queuing them one at a time is strictly faster in aggregate.
_whisper_lock = asyncio.Lock()


def _get_whisper():
    global _whisper_pipeline
    if _whisper_pipeline is None:
        from faster_whisper import BatchedInferencePipeline, WhisperModel
        model = WhisperModel(_WHISPER_MODEL_NAME, device="cpu", compute_type="int8")
        # Batching VAD-detected speech chunks through one pipeline beats plain
        # sequential decoding on CPU — measured ~2.2x throughput on a 6-core/12-thread
        # Ryzen (15.3x realtime vs 6.9x for the "small" model). Forcing more
        # cpu_threads instead made things *slower* (SMT contention on int8 GEMM).
        _whisper_pipeline = BatchedInferencePipeline(model=model)
    return _whisper_pipeline


def _download_audio(url: str) -> str:
    """Download bestaudio to a temp file, return its path (caller cleans up)."""
    import yt_dlp

    tmpdir = tempfile.mkdtemp(prefix="alcove_yt_")
    opts = {
        "format": "bestaudio/best",
        "outtmpl": os.path.join(tmpdir, "audio.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        return ydl.prepare_filename(info)


def _run_whisper(path: str, diarize: bool = False) -> dict:
    """Blocking: run Whisper on a local audio/video file. Run me in a threadpool.

    Returns both the concatenated transcript (backward compat) AND the
    per-segment timing, so downstream consumers can:
      - Show a jump-to-timestamp UI in the note
      - Feed a *timestamped* transcript to the LLM report generator so it can
        cite moments the reader can verify

    If `diarize=True` we additionally run pyannote (lazily) and stamp each
    segment with a speaker label. Silently degrades to `diarized=False` if
    pyannote isn't installed / no HF_TOKEN — the transcript still comes back,
    just without speaker labels.
    """
    pipeline = _get_whisper()
    # `faster_whisper.Segment` is a NamedTuple: (start, end, text, ...)
    segments_iter, info = pipeline.transcribe(path, vad_filter=True, batch_size=16)
    segments = [
        {"start": float(s.start or 0.0), "end": float(s.end or 0.0), "text": s.text.strip()}
        for s in segments_iter
        if (s.text or "").strip()
    ]

    diarized = False
    speaker_count = 0
    if diarize and segments:
        from services import diarization
        available, reason = diarization.is_available()
        if not available:
            logger.info("diarization requested but unavailable: %s", reason)
        else:
            try:
                turns = diarization.diarize_file(path)
                fused = diarization.fuse_segments_with_speakers(segments, turns)
                segments, _ = diarization.relabel_speakers_readable(fused, turns)
                speaker_count = len({s.get("speaker") for s in segments if s.get("speaker")})
                diarized = True
                logger.info("diarization done: %d speakers over %d segments", speaker_count, len(segments))
            except Exception:
                logger.exception("diarization failed — returning transcript without speakers")

    text = " ".join(s["text"] for s in segments).strip()
    return {
        "transcript": text,
        "segments": segments,
        "language": info.language,
        "model": _WHISPER_MODEL_NAME,
        "diarized": diarized,
        "speaker_count": speaker_count,
    }


def _whisper_transcribe(url: str, diarize: bool = False) -> dict:
    """Blocking: download audio + run Whisper. Run me in a threadpool."""
    path = _download_audio(url)
    try:
        return _run_whisper(path, diarize=diarize)
    finally:
        shutil.rmtree(os.path.dirname(path), ignore_errors=True)


class TranscribeRequest(IngestUrlRequest):
    diarize: bool = False


@ingest_router.post("/youtube/transcribe")
async def youtube_transcribe(body: TranscribeRequest, _: UserSession = Depends(require_auth)):
    """Local Whisper transcription for a video that has no captions.

    Accepts `diarize: true` to additionally identify speaker turns via
    pyannote (opt-in — requires pyannote.audio + HF_TOKEN, see
    services/diarization.py). Diarization silently degrades if unavailable;
    the response's `diarized` field tells the caller whether labels were set.
    """
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        raise HTTPException(
            501, "faster-whisper n'est pas installé (pip install faster-whisper).",
        )
    url = body.url.strip()
    if "youtube.com" not in url and "youtu.be" not in url:
        raise HTTPException(400, "URL YouTube attendue")
    try:
        async with _whisper_lock:
            result = await run_in_threadpool(_whisper_transcribe, url, body.diarize)
    except Exception as e:
        raise HTTPException(502, f"Transcription échouée : {e}")
    if not result.get("transcript"):
        raise HTTPException(422, "Transcription vide")
    return result


# ── Local audio/video upload — Whisper transcription ────────────────────────

# Upload cap: raw camera footage runs several GB/hour, so default generously
# (streaming write means large caps don't cost RAM — see _save_upload_capped).
_MAX_MEDIA_BYTES = int(os.getenv("MEDIA_MAX_MB", "20000")) * 1024 * 1024  # default 20 GB
_MEDIA_EXTS = {
    ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".wma",
    ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v",
}


async def _save_upload_capped(file: UploadFile, max_bytes: int) -> tuple[str, str]:
    """Stream the upload to a temp file, aborting early past max_bytes (no full
    in-memory buffering — matters here since inputs can be multi-GB videos)."""
    ext = os.path.splitext(file.filename or "media")[1].lower()
    tmpdir = tempfile.mkdtemp(prefix="alcove_media_")
    path = os.path.join(tmpdir, f"media{ext}")
    total = 0
    try:
        with open(path, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(413, f"Fichier trop volumineux (max {max_bytes // 1_000_000} Mo).")
                out.write(chunk)
    except Exception:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise
    logger.info("media upload saved: filename=%r bytes_received=%d on_disk=%d", file.filename, total, os.path.getsize(path))
    return tmpdir, path


@ingest_router.post("/media/transcribe")
async def media_transcribe(
    file: UploadFile = File(...),
    diarize: bool = Form(False),
    _: UserSession = Depends(require_auth),
):
    """Local Whisper transcription for an uploaded audio/video file.

    `diarize=true` (multipart form field) additionally runs pyannote for
    speaker turn detection — opt-in, silently degrades if unavailable.
    """
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        raise HTTPException(
            501, "faster-whisper n'est pas installé (pip install faster-whisper).",
        )
    ext = os.path.splitext(file.filename or "media")[1].lower()
    logger.info("media_transcribe request: filename=%r content_type=%r diarize=%s",
                file.filename, file.content_type, diarize)
    if ext not in _MEDIA_EXTS:
        raise HTTPException(415, f"Format non supporté : {ext or 'inconnu'}")
    tmpdir, path = await _save_upload_capped(file, _MAX_MEDIA_BYTES)
    try:
        async with _whisper_lock:
            result = await run_in_threadpool(_run_whisper, path, diarize)
    except Exception as e:
        raise HTTPException(502, f"Transcription échouée : {e}")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    if not result.get("transcript"):
        raise HTTPException(422, "Transcription vide")
    return result


# ── Unified file ingestion (markitdown) ─────────────────────────────────────
#
# Routes any uploaded file to the best available extractor and returns clean
# Markdown. Covers docx/pptx/xlsx/epub/html/csv/json out of the box; falls back
# to the existing pypdf pipeline for PDFs (markitdown's PDF path is optional
# and heavier). Keeps the same response shape as /pdf, /web etc. so the
# frontend can treat all ingestion sources uniformly.

_MARKITDOWN_EXT = {
    ".docx", ".doc",
    ".pptx", ".ppt",
    ".xlsx", ".xls",
    ".epub",
    ".html", ".htm",
    ".csv", ".tsv",
    ".json", ".xml",
    ".rtf",
    ".md", ".markdown", ".txt",
}


def _markitdown_convert(data: bytes, filename: str) -> tuple[str, str]:
    """Blocking: run markitdown on an in-memory file. Returns (title, markdown).

    Raises RuntimeError with a human message when the input can't be handled —
    caller turns that into an HTTP 422.
    """
    try:
        from markitdown import MarkItDown
    except ImportError as e:
        raise RuntimeError(
            "markitdown n'est pas installé côté serveur — "
            "vérifie que requirements.txt a bien été appliqué."
        ) from e
    # Persist to a NamedTemporaryFile because MarkItDown wants a path/stream
    # with a real filename to sniff the format.
    suffix = os.path.splitext(filename)[1] or ""
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        md = MarkItDown()
        result = md.convert(tmp_path)
    except Exception as e:
        raise RuntimeError(f"markitdown a échoué : {e}") from e
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
    title = (getattr(result, "title", None) or "").strip() or filename
    text = (getattr(result, "text_content", None) or "").strip()
    return title, text


@ingest_router.post("/file")
async def ingest_file(
    file: UploadFile = File(...),
    _: UserSession = Depends(require_auth),
):
    """Upload any supported document and get Markdown back.

    Routing:
      .pdf                → existing pypdf pipeline (unchanged, better tuned)
      .docx/.pptx/.xlsx/… → markitdown
      unknown extensions  → 415
    """
    filename = file.filename or "upload"
    ext = os.path.splitext(filename)[1].lower()
    data = await file.read()

    if not data:
        raise HTTPException(400, "Fichier vide")

    if ext == ".pdf":
        # Delegate to the existing PDF extractor for consistent behavior.
        title, text = await run_in_threadpool(extract_pdf, data)
        if not text.strip():
            raise HTTPException(
                422,
                "Aucun texte extractible du PDF (probablement scanné — OCR non géré).",
            )
        return {
            "title": title or filename,
            "markdown": text[:_MAX_CHARS],
            "metadata": {"filename": filename},
            "source_type": "pdf",
        }

    if ext not in _MARKITDOWN_EXT:
        raise HTTPException(
            415,
            f"Format non supporté : {ext or '?'}. "
            f"Formats acceptés : PDF, {', '.join(sorted(_MARKITDOWN_EXT))}.",
        )

    try:
        title, text = await run_in_threadpool(_markitdown_convert, data, filename)
    except RuntimeError as e:
        raise HTTPException(422, str(e))

    if not text.strip():
        raise HTTPException(422, "Le fichier ne contient pas de texte extractible.")

    return {
        "title": title,
        "markdown": text[:_MAX_CHARS],
        "metadata": {"filename": filename},
        "source_type": ext.lstrip("."),
    }
