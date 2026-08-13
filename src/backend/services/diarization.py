"""Speaker diarization — attribute each Whisper segment to a speaker turn.

Diarization is *heavy* (pyannote ships a ~1 GB model, gated on a HuggingFace
token) and only useful for multi-speaker content (interviews, podcasts, panel
discussions). It's therefore:

  - Opt-in (a `diarize=True` flag on the transcribe endpoints).
  - Lazily imported so the app boots even without the extras installed.
  - Fully local at inference time — the token is a one-time gate to *download*
    the pyannote weights from HuggingFace. After that, nothing leaves the
    machine.

Install:
    pip install "pyannote.audio>=3.1"
Then set the environment variable:
    HF_TOKEN=your_hf_token   # get one at https://huggingface.co/settings/tokens
And accept the model license once, at:
    https://huggingface.co/pyannote/speaker-diarization-3.1

Fusion strategy: for each Whisper segment we pick the diarization turn with
the largest temporal overlap. Simple, deterministic, and correct 95%+ of the
time — the fancier alternatives (per-word alignment, forced re-decoding)
cost a lot for a modest quality bump.
"""
from __future__ import annotations

import os
import logging
from typing import Optional

logger = logging.getLogger(__name__)

_pipeline_singleton: Optional[object] = None
_load_error: Optional[str] = None  # cached "why we can't diarize" string


def is_available() -> tuple[bool, Optional[str]]:
    """(available, reason_if_not). Cheap to call — no model load."""
    try:
        import pyannote.audio  # noqa: F401
    except ImportError:
        return False, "pyannote.audio non installé (pip install 'pyannote.audio>=3.1')"
    if not os.getenv("HF_TOKEN"):
        return False, "Variable HF_TOKEN manquante (huggingface.co/settings/tokens)"
    return True, None


def _get_pipeline() -> object:
    """Lazily construct the shared pyannote pipeline. Raises on failure."""
    global _pipeline_singleton, _load_error
    if _pipeline_singleton is not None:
        return _pipeline_singleton
    if _load_error is not None:
        raise RuntimeError(_load_error)

    from pyannote.audio import Pipeline
    token = os.getenv("HF_TOKEN")
    if not token:
        _load_error = "HF_TOKEN missing"
        raise RuntimeError(_load_error)

    try:
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=token,
        )
    except Exception as e:
        # The most common failure: user hasn't accepted the model license.
        _load_error = (
            f"Impossible de charger pyannote/speaker-diarization-3.1 : {e}. "
            f"As-tu accepté la licence sur huggingface.co ?"
        )
        raise RuntimeError(_load_error) from e

    _pipeline_singleton = pipeline
    logger.info("pyannote diarization pipeline loaded")
    return pipeline


def diarize_file(audio_path: str) -> list[dict]:
    """Run diarization on a local audio/video file. Returns
    [{start, end, speaker: "SPEAKER_00"}] sorted by start.

    Blocking — call via run_in_threadpool.
    """
    pipeline = _get_pipeline()
    annotation = pipeline(audio_path)  # pyannote.core.Annotation
    turns: list[dict] = []
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        turns.append({
            "start": float(turn.start),
            "end": float(turn.end),
            "speaker": str(speaker),  # e.g. "SPEAKER_00"
        })
    turns.sort(key=lambda t: t["start"])
    return turns


def _best_speaker(seg_start: float, seg_end: float, turns: list[dict]) -> Optional[str]:
    """Pick the speaker whose turn overlaps the most with [seg_start, seg_end).
    None if no turn overlaps at all (music, silence, uncertain regions)."""
    best_speaker: Optional[str] = None
    best_overlap = 0.0
    for t in turns:
        if t["end"] <= seg_start:
            continue
        if t["start"] >= seg_end:
            break  # turns are sorted, no later turn can overlap
        overlap = min(seg_end, t["end"]) - max(seg_start, t["start"])
        if overlap > best_overlap:
            best_overlap = overlap
            best_speaker = t["speaker"]
    return best_speaker


def fuse_segments_with_speakers(
    segments: list[dict], turns: list[dict],
) -> list[dict]:
    """Assign `speaker` to each Whisper segment via max-overlap. Non-destructive:
    returns a new list, doesn't mutate inputs."""
    out = []
    for s in segments:
        speaker = _best_speaker(float(s["start"]), float(s["end"]), turns)
        out.append({**s, "speaker": speaker})
    return out


def relabel_speakers_readable(
    segments: list[dict], turns: list[dict],
) -> tuple[list[dict], list[dict]]:
    """Rename `SPEAKER_00` → `Intervenant 1` (ordered by first appearance).
    Applies to both the segment list and the turns list so downstream code
    sees consistent labels."""
    order: list[str] = []
    for s in segments:
        sp = s.get("speaker")
        if sp and sp not in order:
            order.append(sp)
    remap = {sp: f"Intervenant {i + 1}" for i, sp in enumerate(order)}
    new_segments = [
        {**s, "speaker": remap.get(s.get("speaker"), s.get("speaker"))}
        for s in segments
    ]
    new_turns = [
        {**t, "speaker": remap.get(t["speaker"], t["speaker"])}
        for t in turns
    ]
    return new_segments, new_turns
