import json

import pytest
from fastapi import HTTPException

from routers.ai.ollama_proxy import _validated_payload


def test_chat_context_size_is_bounded(monkeypatch):
    monkeypatch.setattr("routers.ai.ollama_proxy.AI_MAX_CONTEXT_CHARS", 10)
    raw = json.dumps({"messages": [{"role": "user", "content": "x" * 11}]}).encode()
    with pytest.raises(HTTPException) as exc:
        _validated_payload(raw, "/api/chat")
    assert exc.value.status_code == 413


def test_chat_message_count_is_bounded(monkeypatch):
    monkeypatch.setattr("routers.ai.ollama_proxy.AI_MAX_MESSAGES", 1)
    raw = json.dumps({"messages": [
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "b"},
    ]}).encode()
    with pytest.raises(HTTPException) as exc:
        _validated_payload(raw, "/api/chat")
    assert exc.value.status_code == 413


def test_embedding_text_size_is_bounded(monkeypatch):
    monkeypatch.setattr("routers.ai.ollama_proxy.AI_MAX_EMBED_CHARS", 3)
    with pytest.raises(HTTPException) as exc:
        _validated_payload(b'{"prompt":"four"}', "/api/embeddings")
    assert exc.value.status_code == 413


def test_valid_chat_payload_is_accepted():
    payload = {"messages": [{"role": "user", "content": "bonjour"}]}
    assert _validated_payload(json.dumps(payload).encode(), "/api/chat") == payload
