"""Tests for the pure caption/transcript parsers in ingest_router."""
from routers.ingest_router import (
    parse_json3_captions,
    parse_vtt_captions,
    _pick_caption_track,
    _caption_fmt_url,
)


def test_json3_captions_concatenates_segments():
    payload = {
        "events": [
            {"segs": [{"utf8": "Bonjour "}, {"utf8": "tout le monde"}]},
            {"segs": [{"utf8": "\n"}]},
            {"segs": [{"utf8": "deuxième ligne"}]},
        ]
    }
    out = parse_json3_captions(payload)
    assert "Bonjour tout le monde" in out
    assert "deuxième ligne" in out
    # the newline-only event is dropped
    assert out.count("\n") == 1


def test_json3_empty_events():
    assert parse_json3_captions({"events": []}) == ""
    assert parse_json3_captions({}) == ""


def test_vtt_strips_headers_timestamps_and_tags():
    vtt = """WEBVTT
Kind: captions
Language: fr

1
00:00:01.000 --> 00:00:03.000
<c>Bonjour</c> à tous

2
00:00:03.000 --> 00:00:05.000
Bonjour à tous
Deuxième phrase
"""
    out = parse_vtt_captions(vtt)
    assert "Bonjour à tous" in out
    assert "Deuxième phrase" in out
    assert "WEBVTT" not in out and "-->" not in out and "<c>" not in out
    # consecutive duplicate line is de-duplicated
    assert out.count("Bonjour à tous") == 1


def test_pick_caption_track_prefers_manual_then_lang():
    info = {
        "subtitles": {"fr": [{"ext": "json3", "url": "MANUAL_FR"}]},
        "automatic_captions": {"fr": [{"ext": "json3", "url": "AUTO_FR"}]},
    }
    track = _pick_caption_track(info)
    assert track[0]["url"] == "MANUAL_FR"


def test_pick_caption_track_falls_back_to_auto_and_any_lang():
    info = {"automatic_captions": {"de": [{"ext": "vtt", "url": "AUTO_DE"}]}}
    track = _pick_caption_track(info)
    assert track[0]["url"] == "AUTO_DE"


def test_pick_caption_track_none_when_absent():
    assert _pick_caption_track({}) is None


def test_caption_fmt_url_prefers_json3():
    fmts = [{"ext": "vtt", "url": "V"}, {"ext": "json3", "url": "J"}]
    assert _caption_fmt_url(fmts) == ("J", "json3")


def test_caption_fmt_url_falls_back_to_first():
    fmts = [{"ext": "srv1", "url": "X"}]
    assert _caption_fmt_url(fmts) == ("X", "srv1")
