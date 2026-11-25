"""Hybrid ranking: a bulk import must not drown the user's own notes."""
from services.hybrid_search import PadCandidate, fold, fuse, query_terms, score_lexical, score_semantic


def test_terms_are_folded_deduplicated_and_keep_accented_spelling():
    terms = query_terms("WAAM DED référentiel de la DED")
    assert list(terms) == ["waam", "ded", "referentiel"]
    assert terms["referentiel"] == ("referentiel", "référentiel")
    assert fold("Référentiel ÉTÉ") == "referentiel ete"
    assert query_terms("   ") == {}


def test_whole_word_matching_only():
    pads = [PadCandidate(1, "Dedicated handbook", chunks=[("dedicated waamish text", None)]),
            PadCandidate(2, "Notes", chunks=[("le procédé DED (WAAM)", None)])]
    score_lexical(query_terms("ded waam"), pads)
    assert pads[0].lexical == 0 and pads[1].matched_terms == ["ded", "waam"]


def test_own_titled_note_beats_semantically_close_bulk_import():
    # 40 long generic manuals win on cosine; the user's referential only
    # shares the exact words of the query in its title and tags.
    manuals = [
        PadCandidate(f"m{i}", f"FM {i} — Field Manual", folder="Vault", tags=["field-manual-vault"],
                     chunks=[(f"generic maintenance procedures {i}", [1.0, 0.05 * (i % 5)])])
        for i in range(40)
    ]
    ref = PadCandidate("ref", "Référentiel DED/WAAM v2", tags=["waam", "ded"],
                       chunks=[("Wire arc additive manufacturing, dépôt direct", [0.6, 0.8])])
    other = PadCandidate("other", "Courses", chunks=[("pain beurre", [0.0, 1.0])])
    pads = [*manuals, ref, other]
    score_semantic([1.0, 0.0], pads)
    score_lexical(query_terms("WAAM DED référentiel"), pads)
    top = fuse(pads, 5)
    assert top[0].pad_id == "ref"
    assert set(ref.matched_terms) == {"waam", "ded", "referentiel"}
    assert other not in top                       # below the semantic floor, no word match
    assert len({c.pad_id for c in top}) == len(top)  # one entry per pad


def test_semantic_keeps_best_chunk_and_skips_bad_vectors():
    pad = PadCandidate("p", "Note", chunks=[("faible", [0.0, 1.0]), ("forte", [1.0, 0.0]), ("cassé", [1.0])])
    score_semantic([1.0, 0.0], [pad])
    assert round(pad.semantic, 4) == 1.0 and pad.best_chunk == "forte"


def test_semantic_only_still_ranks_when_no_word_matches():
    a = PadCandidate("a", "A", chunks=[("x", [1.0, 0.0])])
    b = PadCandidate("b", "B", chunks=[("y", [0.7, 0.7])])
    score_semantic([1.0, 0.0], [a, b])
    score_lexical(query_terms("zzz"), [a, b])
    assert [c.pad_id for c in fuse([a, b], 5)] == ["a", "b"]
