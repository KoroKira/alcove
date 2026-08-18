"""Post-Phase 3D remainder of the video-report module.

The map-reduce that turns a timestamped transcript into a Markdown report now
runs in the browser (see `src/frontend/src/lib/videoReport.ts`). All that's
left server-side is the diarization probe the ingest UI hits before showing
the "detect speakers" checkbox — it doesn't load the model, just checks
whether pyannote is importable and HF_TOKEN is present.
"""
from fastapi import APIRouter, Depends

from dependencies import UserSession, require_auth


router = APIRouter()


@router.get("/diarization-status")
async def diarization_status(_: UserSession = Depends(require_auth)):
    """Cheap probe the UI hits before showing the 'detect speakers' checkbox."""
    from services import diarization
    available, reason = diarization.is_available()
    return {"available": available, "reason": reason}
