"""Pure content matching used by workspace-wide pad search."""

from types import SimpleNamespace

from services.rag_indexer import extract_text_from_pad


def match_pad(pad_type: str, data, display_name: str, query: str):
    """Return a title/content match and small excerpts for one pad."""
    data = data if isinstance(data, dict) else {}
    matches = []
    if pad_type == "canvas":
        elements = data.get("elements", [])
        if isinstance(elements, list):
            for element in elements:
                if not isinstance(element, dict):
                    continue
                label = element.get("label")
                text = element.get("text", "")
                if not text and isinstance(label, dict):
                    text = label.get("text", "")
                if isinstance(text, str) and query in text.lower():
                    matches.append({
                        "element_id": element.get("id", ""),
                        "text": text[:60],
                        "excerpt": text[:120],
                    })
                    if len(matches) == 5:
                        break
    else:
        content = extract_text_from_pad(SimpleNamespace(pad_type=pad_type, data=data))
        idx = content.lower().find(query)
        if idx != -1:
            start = max(0, idx - 40)
            excerpt = content[start:idx + 80].replace("\n", " ").strip()
            matches.append({
                "element_id": "",
                "text": content[idx:idx + 60],
                "excerpt": excerpt,
            })

    name_match = query in (display_name or "").lower()
    if name_match or matches:
        return name_match, matches
    return None
