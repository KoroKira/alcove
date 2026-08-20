# Turns a Recall "Export data" markdown dump into a SQL script that creates
# one Alcove document pad per exported item, tags included. Reads YAML
# frontmatter (title/tags) + body from each .md, skips files whose title
# already exists among previously-generated inserts (simple in-run dedup —
# doesn't check the live DB, so don't re-run against a folder you already
# imported without clearing dupes downstream).
#
# Usage: python import_recall_export.py <export_dir> [<export_dir> ...] > out.sql
# Then:  ssh alcove-server "docker exec -i alcove-postgres psql -U pad -d pad" < out.sql
import re
import sys
import uuid
from pathlib import Path

OWNER_ID = "00000000-0000-0000-0000-000000000001"


def parse_frontmatter(text: str):
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.DOTALL)
    if not m:
        return {}, text
    fm_raw, body = m.group(1), m.group(2)
    title = ""
    tags: list[str] = []
    in_tags = False
    for line in fm_raw.splitlines():
        if line.startswith("title:"):
            title = line.split("title:", 1)[1].strip().strip('"')
            in_tags = False
        elif line.startswith("tags:"):
            in_tags = True
        elif in_tags and line.strip().startswith("- "):
            tag = line.strip()[2:].strip().strip('"')
            # Recall's hierarchical tags use "/" — keep only the leaf, flat
            # tags are what Alcove's tag system expects.
            leaf = tag.split("/")[-1].strip()
            if leaf and leaf not in tags:
                tags.append(leaf)
        elif in_tags and not line.startswith(" ") and not line.strip().startswith("-"):
            in_tags = False
    return {"title": title, "tags": tags}, body


def sql_escape(s: str) -> str:
    # Dollar-quoting sidesteps apostrophe-heavy French text entirely.
    return s


def pg_array(tags: list[str]) -> str:
    escaped = [t.replace("'", "''") for t in tags[:20]]
    return "ARRAY[" + ",".join(f"'{t}'" for t in escaped) + "]::varchar[]" if escaped else "ARRAY[]::varchar[]"


def main():
    dirs = [Path(a) for a in sys.argv[1:]]
    if not dirs:
        print("usage: import_recall_export.py <dir> [<dir> ...]", file=sys.stderr)
        sys.exit(1)

    seen_titles: set[str] = set()
    statements = []

    for d in dirs:
        for md_path in sorted(d.glob("*.md")):
            text = md_path.read_text(encoding="utf-8")
            meta, body = parse_frontmatter(text)
            title = (meta.get("title") or md_path.stem).strip()[:100]
            if not title or title.lower() in seen_titles:
                continue
            seen_titles.add(title.lower())
            tags = meta.get("tags", [])
            pad_id = str(uuid.uuid4())
            content = body.strip()
            # Dollar-quote with a tag unlikely to collide with content.
            statements.append(f"""
INSERT INTO pad_ws.pads (owner_id, display_name, data, sharing_policy, is_scratch, pad_type, tags, id, created_at, updated_at)
VALUES (
  '{OWNER_ID}'::uuid,
  $title${title}$title$,
  jsonb_build_object('content', $body${content}$body$, 'format', 'markdown', 'source', 'Recall import'),
  'private', false, 'document',
  {pg_array(tags)},
  '{pad_id}'::uuid, now(), now()
);""")

    print("BEGIN;")
    print("\n".join(statements))
    print("COMMIT;")
    print(f"-- {len(statements)} pads generated", file=sys.stderr)


if __name__ == "__main__":
    main()
