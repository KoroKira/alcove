"""AI router package: chat, RAG, Ollama admin, generation, clip, memory.

Split out of the old monolithic routers/ai_router.py. All URLs stay identical
because the parent APIRouter mounts every sub-router under /api/ai."""
from fastapi import APIRouter

from .chat import router as _chat
from .ollama_admin import router as _ollama
from .rag import router as _rag
from .generation import router as _generation
from .clip import router as _clip
from .memory import router as _memory
from .video_report import router as _video_report
from .ollama_proxy import router as _ollama_proxy


ai_router = APIRouter(prefix="/api/ai")
ai_router.include_router(_chat)
ai_router.include_router(_ollama)
ai_router.include_router(_rag)
ai_router.include_router(_generation)
ai_router.include_router(_clip)
ai_router.include_router(_memory)
ai_router.include_router(_video_report)
ai_router.include_router(_ollama_proxy)


__all__ = ["ai_router"]
