"""Validation tests for atomic document and folder creation payloads."""

import pytest
from pydantic import ValidationError

from routers.pad_router import NewPadRequest


def test_new_pad_request_accepts_initial_markdown_and_vault_folder():
    request = NewPadRequest.model_validate({
        "pad_type": "document",
        "display_name": "Daily note",
        "content": "# Daily note",
        "folder": "Journal/2026",
    })

    assert request.content == "# Daily note"
    assert request.folder == "Journal/2026"


def test_new_pad_request_rejects_folder_that_cannot_fit_pad_storage():
    with pytest.raises(ValidationError):
        NewPadRequest.model_validate({"folder": "x" * 81})
