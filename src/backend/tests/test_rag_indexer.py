from types import SimpleNamespace

import pytest

from services.rag_indexer import extract_text_from_pad


@pytest.mark.parametrize(
    ("pad_type", "data", "expected"),
    [
        ("document", {"content": "  A searchable document.  "}, "A searchable document."),
        ("latex", {"source": r"\section{A searchable theorem}"}, r"\section{A searchable theorem}"),
        ("latex", {"content": "Legacy LaTeX source"}, "Legacy LaTeX source"),
        (
            "canvas",
            {"elements": [
                {"text": "Canvas label"},
                {"text": "", "label": {"text": "Fallback text"}},
                None,
            ]},
            "Canvas label\nFallback text",
        ),
        (
            "kanban",
            {
                "fieldSchema": [{"id": "f-status", "name": "Impact"}],
                "columns": [{"title": "À faire", "cards": [{
                    "title": "Ship the feature",
                    "desc": "Add semantic retrieval",
                    "labels": ["RAG", "daily use"],
                    "fields": [{"fieldId": "f-status", "value": "high"}],
                    "attachments": [{"name": "design-notes.pdf", "url": "/private/file"}],
                }]}],
            },
            "À faire\nShip the feature\nAdd semantic retrieval\nRAG\ndaily use\nImpact: high\ndesign-notes.pdf",
        ),
        (
            "gantt",
            {
                "fieldSchema": [{"id": "f-owner", "name": "Owner"}],
                "tasks": [{
                    "name": "Migration",
                    "desc": "Move the search index",
                    "assignee": "Alex",
                    "start": "2026-10-01",
                    "end": "2026-10-07",
                    "fields": [{"fieldId": "f-owner", "value": "Platform"}],
                }],
            },
            "Migration\nMove the search index\nAlex\n2026-10-01\n2026-10-07\nOwner: Platform",
        ),
        (
            "database",
            {
                "columns": [{"id": "c-name", "name": "Name"}, {"id": "c-notes", "name": "Notes"}],
                "rows": [{"cells": {"c-name": "Alpha", "c-notes": "A searchable record"}}],
            },
            "Name\nNotes\nName: Alpha\nNotes: A searchable record",
        ),
    ],
)
def test_extracts_user_text_from_supported_pad_types(pad_type, data, expected):
    pad = SimpleNamespace(pad_type=pad_type, data=data)
    assert extract_text_from_pad(pad) == expected


def test_unknown_or_malformed_pad_data_does_not_break_indexing():
    assert extract_text_from_pad(SimpleNamespace(pad_type="unknown", data={"content": "ignored"})) == ""
    assert extract_text_from_pad(SimpleNamespace(pad_type="document", data=None)) == ""
    assert extract_text_from_pad(SimpleNamespace(pad_type="canvas", data={"elements": None})) == ""
    assert extract_text_from_pad(SimpleNamespace(pad_type="kanban", data={"columns": None})) == ""
    assert extract_text_from_pad(SimpleNamespace(pad_type="gantt", data={"tasks": None})) == ""
    assert extract_text_from_pad(SimpleNamespace(pad_type="database", data={"columns": None, "rows": None})) == ""
