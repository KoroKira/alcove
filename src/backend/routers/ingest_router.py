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

import io
import json
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
from routers.ai_router import _MarkdownExtractor  # reuse the stdlib readability

ingest_router = APIRouter(prefix="/api/ingest")

_UA = "Mozilla/5.0 (alcove ingest)"
_MAX_CHARS = 200_000


class IngestUrlRequest(BaseModel):
    url: str


# ── Web ─────────────────────────────────────────────────────────────────────

async def fetch_web(url: str) -> dict:
    """Fetch a web page (or raw text/markdown file) → {title, markdown}."""
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "URL invalide (http/https uniquement)")
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
    title, markdown = _MarkdownExtractor().extract(resp.text[:1_500_000])
    if len(markdown) > _MAX_CHARS:
        markdown = markdown[:_MAX_CHARS] + "\n\n*[contenu tronqué]*"
    return {
        "title": title or url,
        "markdown": markdown,
        "metadata": {"source_url": url},
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
    return {
        "title": title or filename,
        "markdown": text[:_MAX_CHARS],
        "metadata": {"source_url": src_url, "filename": filename},
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
    chapters = [c.get("title", "") for c in (info.get("chapters") or []) if c.get("title")]
    webpage_url = info.get("webpage_url") or url

    # Transcript: fetch a caption track and parse it.
    transcript = ""
    track = _pick_caption_track(info)
    if track:
        cap_url, ext = _caption_fmt_url(track)
        if cap_url:
            try:
                async with httpx.AsyncClient(follow_redirects=True, timeout=20) as client:
                    r = await client.get(cap_url, headers={"User-Agent": _UA})
                    r.raise_for_status()
                if ext == "json3":
                    transcript = parse_json3_captions(r.json())
                else:
                    transcript = parse_vtt_captions(r.text)
            except Exception:
                transcript = ""

    # Assemble the Markdown body.
    md = []
    if description:
        md.append("## Description\n\n" + description)
    if chapters:
        md.append("## Chapitres\n\n" + "\n".join(f"- {c}" for c in chapters))
    if transcript:
        md.append("## Transcription\n\n" + transcript[:_MAX_CHARS])
    else:
        md.append(
            "> [!NOTE]\n> Aucun sous-titre disponible pour cette vidéo. "
            "La transcription locale (Whisper) sera proposée en Phase 2."
        )

    return {
        "title": title,
        "markdown": "\n\n".join(md),
        "metadata": {
            "source_url": webpage_url,
            "author": uploader,
            "duration": duration,
            "upload_date": upload_date,
            "has_transcript": bool(transcript),
        },
        "source_type": "youtube",
    }


# ── YouTube — Whisper fallback (Phase 2) ────────────────────────────────────
# When a video has no captions, download its audio and transcribe it locally
# with faster-whisper. Model is fetched from HuggingFace on first use (~base =
# 145 MB) and cached; everything runs on-device, nothing leaves the machine.

_WHISPER_MODEL_NAME = os.getenv("WHISPER_MODEL", "base")
_whisper_model = None  # lazily-loaded singleton


def _get_whisper():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel(_WHISPER_MODEL_NAME, device="cpu", compute_type="int8")
    return _whisper_model


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


def _whisper_transcribe(url: str) -> dict:
    """Blocking: download audio + run Whisper. Run me in a threadpool."""
    path = _download_audio(url)
    try:
        model = _get_whisper()
        segments, info = model.transcribe(path, vad_filter=True)
        text = " ".join(s.text.strip() for s in segments).strip()
        return {"transcript": text, "language": info.language, "model": _WHISPER_MODEL_NAME}
    finally:
        shutil.rmtree(os.path.dirname(path), ignore_errors=True)


@ingest_router.post("/youtube/transcribe")
async def youtube_transcribe(body: IngestUrlRequest, _: UserSession = Depends(require_auth)):
    """Local Whisper transcription for a video that has no captions."""
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
        result = await run_in_threadpool(_whisper_transcribe, url)
    except Exception as e:
        raise HTTPException(502, f"Transcription échouée : {e}")
    if not result.get("transcript"):
        raise HTTPException(422, "Transcription vide")
    return result
