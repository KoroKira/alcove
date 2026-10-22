"""Isolated tests for export fidelity and archive path safety."""

import json
from datetime import datetime, timezone
from types import SimpleNamespace

from application.pad_exports import build_pad_export_files


def _pad(*, id: str, name: str, pad_type: str, data: dict, folder: str | None = None):
    now = datetime(2026, 10, 22, tzinfo=timezone.utc)
    return SimpleNamespace(
        id=id,
        display_name=name,
        pad_type=pad_type,
        data=data,
        folder=folder,
        tags=["work"],
        created_at=now,
        updated_at=now,
    )


def test_exports_each_pad_type_without_losing_content_or_colliding():
    pads = [
        _pad(id="a1111111-0000-0000-0000-000000000001", name="Plan", pad_type="document", data={"content": "# Plan", "format": "markdown"}, folder="Work/Ideas"),
        _pad(id="a2222222-0000-0000-0000-000000000002", name="Plan", pad_type="document", data={"content": "\\section{Plan}", "format": "latex"}, folder="Work/Ideas"),
        _pad(id="a3333333-0000-0000-0000-000000000003", name="Sketch", pad_type="canvas", data={"elements": [{"id": "shape-1"}]}),
        _pad(id="a4444444-0000-0000-0000-000000000004", name="Sprint", pad_type="kanban", data={"columns": [{"id": "todo"}]}),
        _pad(id="a5555555-0000-0000-0000-000000000005", name="Timeline", pad_type="gantt", data={"tasks": [{"id": "task-1"}]}),
        _pad(id="a6666666-0000-0000-0000-000000000006", name="Equation", pad_type="latex", data={"content": "x^2", "format": "latex"}),
    ]

    files = dict(build_pad_export_files(pads))

    assert len(files) == len(pads) + 1
    assert "Work/Ideas/Plan--a1111111-0000-0000-0000-000000000001.md" in files
    assert files["Work/Ideas/Plan--a1111111-0000-0000-0000-000000000001.md"] == "# Plan"
    assert files["Work/Ideas/Plan--a2222222-0000-0000-0000-000000000002.tex"] == "\\section{Plan}"
    assert json.loads(files["Sketch--a3333333-0000-0000-0000-000000000003.excalidraw"]) == pads[2].data

    kanban = json.loads(files["Sprint--a4444444-0000-0000-0000-000000000004.json"])
    assert kanban["schema"] == "alcove.pad-export/v1"
    assert kanban["pad"]["pad_type"] == "kanban"
    assert kanban["data"] == pads[3].data
    gantt = json.loads(files["Timeline--a5555555-0000-0000-0000-000000000005.json"])
    assert gantt["data"] == pads[4].data
    assert files["Equation--a6666666-0000-0000-0000-000000000006.tex"] == "x^2"

    manifest = json.loads(files["manifest.json"])
    assert manifest["schema"] == "alcove.export/v1"
    assert len(manifest["pads"]) == len(pads)
    assert {item["id"] for item in manifest["pads"]} == {pad.id for pad in pads}


def test_export_paths_cannot_escape_archive_root():
    pad = _pad(
        id="b1111111-0000-0000-0000-000000000001",
        name="../../private/report",
        pad_type="document",
        data={"content": "safe"},
        folder="../../outside/../notes",
    )

    files = build_pad_export_files([pad])
    archive_paths = [path for path, _ in files]

    assert all(not path.startswith("/") for path in archive_paths)
    assert all(".." not in path.split("/") for path in archive_paths)
    assert any(path.startswith("outside/notes/") for path in archive_paths)
