# Turns a Recall "Export data" markdown dump into a SQL script that creates
# one Alcove document pad per exported item, tags included. Reads YAML
# frontmatter (title/tags) + body from each .md, skips files whose title
# already exists among previously-generated inserts (simple in-run dedup)
# or in an optional --exclude-titles file (one title per line — feed it
# `SELECT display_name FROM pad_ws.pads` to dedup against a live DB).
#
# --exclude-tags drops any item carrying one of the given tags (substring,
# case-insensitive) UNLESS the title also matches --keep-title-pattern —
# used to strip a slop-generating tag (e.g. a tutorial-content company tag)
# while still keeping the genuinely personal items under it (e.g. an
# internship report that happens to reference the same company by name).
#
# Usage: python import_recall_export.py <export_dir> [<export_dir> ...]
#          [--exclude-tags TAG,TAG] [--keep-title-pattern REGEX]
#          [--exclude-titles-file FILE] > out.sql
# Then:  ssh alcove-server "docker exec -i alcove-postgres psql -U pad -d pad" < out.sql
import argparse
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
    raw_tags: list[str] = []
    in_tags = False
    for line in fm_raw.splitlines():
        if line.startswith("title:"):
            title = line.split("title:", 1)[1].strip().strip('"')
            in_tags = False
        elif line.startswith("tags:"):
            in_tags = True
        elif in_tags and line.strip().startswith("- "):
            tag = line.strip()[2:].strip().strip('"')
            raw_tags.append(tag)
            # Recall's hierarchical tags use "/" — keep only the leaf, flat
            # tags are what Alcove's tag system expects.
            leaf = tag.split("/")[-1].strip()
            if leaf and leaf not in tags:
                tags.append(leaf)
        elif in_tags and not line.startswith(" ") and not line.strip().startswith("-"):
            in_tags = False
    return {"title": title, "tags": tags, "raw_tags": raw_tags}, body


def sql_escape(s: str) -> str:
    # Dollar-quoting sidesteps apostrophe-heavy French text entirely.
    return s


def pg_array(tags: list[str]) -> str:
    escaped = [t.replace("'", "''") for t in tags[:20]]
    return "ARRAY[" + ",".join(f"'{t}'" for t in escaped) + "]::varchar[]" if escaped else "ARRAY[]::varchar[]"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dirs", nargs="+", type=Path)
    ap.add_argument("--exclude-tags", default="", help="comma-separated, case-insensitive substring match against each item's raw (unflattened) tags")
    ap.add_argument("--keep-title-pattern", default=None, help="regex (case-insensitive); an item that would be excluded by --exclude-tags is kept anyway if its title matches this")
    ap.add_argument("--exclude-titles-file", type=Path, default=None, help="one title per line — skip items whose title already appears here (e.g. existing DB rows)")
    args = ap.parse_args()

    exclude_tags = [t.strip().lower() for t in args.exclude_tags.split(",") if t.strip()]
    keep_re = re.compile(args.keep_title_pattern, re.IGNORECASE) if args.keep_title_pattern else None

    seen_titles: set[str] = set()
    if args.exclude_titles_file and args.exclude_titles_file.exists():
        for line in args.exclude_titles_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                seen_titles.add(line.lower())

    statements = []
    skipped_dupe = 0
    skipped_tag = 0

    for d in args.dirs:
        for md_path in sorted(d.glob("*.md")):
            text = md_path.read_text(encoding="utf-8")
            meta, body = parse_frontmatter(text)
            title = (meta.get("title") or md_path.stem).strip()[:100]
            if not title:
                continue
            if title.lower() in seen_titles:
                skipped_dupe += 1
                continue

            raw_tags = meta.get("raw_tags", [])
            if exclude_tags and any(et in rt.lower() for rt in raw_tags for et in exclude_tags):
                if not (keep_re and keep_re.search(title)):
                    skipped_tag += 1
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
    print(f"-- {len(statements)} pads generated, {skipped_dupe} skipped as duplicate titles, {skipped_tag} skipped by --exclude-tags", file=sys.stderr)


if __name__ == "__main__":
    main()
