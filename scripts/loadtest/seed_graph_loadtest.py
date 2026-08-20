# Seeds a synthetic knowledge-graph-shaped dataset (a few hub pads + a long
# tail, linked via real [[wikilinks]] so /api/pad/graph parses real edges)
# for load-testing GraphView's force layout at scale. LOCAL DEV DB ONLY —
# connects with the no-password default from docker-compose.local.yml and
# writes directly to pad_ws.pads for the fixed dev-mode owner id. Never point
# this at a real deployment; it does not clean up after itself (delete with
# `DELETE FROM pad_ws.pads WHERE display_name LIKE 'Node %';` when done).
# Companion to bench_repulsion.mjs, which benchmarks the physics algorithm
# itself (no browser/DB needed) — see HANDOVER.md chantier B for results.
import asyncio
import random
import uuid
from datetime import datetime, timezone

import asyncpg

OWNER_ID = "00000000-0000-0000-0000-000000000001"
N = 3000
HUB_COUNT = 15  # a handful of highly-connected nodes, like a real KB


async def main():
    conn = await asyncpg.connect(
        user="postgres", password="", database="pad",
        host="127.0.0.1", port=5432,
    )

    titles = [f"Node {i:05d}" for i in range(N)]
    ids = [uuid.uuid4() for _ in range(N)]
    hubs = random.sample(range(N), HUB_COUNT)

    rows = []
    now = datetime.now(timezone.utc)
    for i in range(N):
        # scale-free-ish: most nodes link to 1-3 others, biased toward hubs
        n_links = random.randint(1, 3)
        targets = set()
        for _ in range(n_links):
            if random.random() < 0.6:
                targets.add(random.choice(hubs))
            else:
                targets.add(random.randint(0, N - 1))
        targets.discard(i)
        content = f"# {titles[i]}\n\n" + " ".join(f"[[{titles[t]}]]" for t in targets)
        rows.append((
            OWNER_ID, titles[i], {"content": content}, "private", False,
            "document", [], ids[i], now, now,
        ))

    await conn.executemany(
        """
        INSERT INTO pad_ws.pads
          (owner_id, display_name, data, sharing_policy, is_scratch, pad_type, tags, id, created_at, updated_at)
        VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10)
        """,
        [(r[0], r[1], __import__("json").dumps(r[2]), r[3], r[4], r[5], r[6], r[7], r[8], r[9]) for r in rows],
    )

    print(f"inserted {N} nodes with {HUB_COUNT} hubs")
    await conn.close()


asyncio.run(main())
