"""Tests that workspace full-text search covers each supported pad schema."""
from services.pad_search import match_pad as _match_pad


def test_document_body_is_searchable():
    data = {"content": "# Titre\n\nUn paragraphe qui parle de kubernetes en prod."}
    result = _match_pad("document", data, "Notes infra", "kubernetes")
    assert result is not None
    name_match, matches = result
    assert name_match is False
    assert len(matches) == 1
    assert "kubernetes" in matches[0]["excerpt"].lower()


def test_document_title_match_without_body_hit():
    data = {"content": "rien de pertinent ici"}
    result = _match_pad("document", data, "Recette kubernetes", "kubernetes")
    assert result is not None
    name_match, matches = result
    assert name_match is True
    assert matches == []


def test_canvas_element_text_is_searchable():
    data = {"elements": [
        {"id": "e1", "text": "Diagramme réseau"},
        {"id": "e2", "text": "noeud kubernetes"},
    ]}
    result = _match_pad("canvas", data, "Archi", "kubernetes")
    assert result is not None
    _, matches = result
    assert matches[0]["element_id"] == "e2"


def test_canvas_label_text_is_searchable():
    data = {"elements": [{"id": "arrow1", "label": {"text": "vers kubernetes"}}]}
    result = _match_pad("canvas", data, "Flux", "kubernetes")
    assert result is not None


def test_latex_source_is_searchable():
    result = _match_pad("latex", {"source": r"\section{Kubernetes planning}"}, "Runbook", "kubernetes")
    assert result is not None
    assert "Kubernetes" in result[1][0]["excerpt"]


def test_kanban_card_content_is_searchable():
    result = _match_pad("kanban", {
        "columns": [{"title": "À faire", "cards": [{"title": "Migrate Kubernetes", "desc": "Move cluster"}]}],
    }, "Infra", "kubernetes")
    assert result is not None
    assert result[1][0]["text"].startswith("Kubernetes")


def test_gantt_task_content_is_searchable():
    result = _match_pad("gantt", {"tasks": [{"name": "Deploy Kubernetes", "desc": "Production cluster"}]}, "Roadmap", "kubernetes")
    assert result is not None
    assert "Kubernetes" in result[1][0]["excerpt"]


def test_database_cell_content_is_searchable():
    result = _match_pad("database", {
        "columns": [{"id": "c-notes", "name": "Notes"}],
        "rows": [{"cells": {"c-notes": "Kubernetes migration"}}],
    }, "Systems", "kubernetes")
    assert result is not None
    assert "Kubernetes" in result[1][0]["excerpt"]


def test_element_with_null_label_does_not_crash():
    data = {"elements": [{"id": "x", "label": None, "text": ""}]}
    assert _match_pad("canvas", data, "Vide", "kubernetes") is None


def test_no_match_returns_none():
    data = {"content": "quelque chose"}
    assert _match_pad("document", data, "Sans rapport", "kubernetes") is None


def test_non_dict_data_is_safe():
    assert _match_pad("document", None, "Titre", "kubernetes") is None
    assert _match_pad("canvas", "corrupt", "Titre", "kubernetes") is None


def test_matches_are_capped_at_five():
    data = {"elements": [{"id": str(i), "text": "kubernetes"} for i in range(12)]}
    result = _match_pad("canvas", data, "Big", "kubernetes")
    assert result is not None
    _, matches = result
    assert len(matches) == 5
