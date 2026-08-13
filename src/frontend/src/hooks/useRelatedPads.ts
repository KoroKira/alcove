import { useEffect, useState } from 'react';

export interface RelatedPad {
  pad_id: string;
  pad_name: string;
  score: number;
}

// "Smart Connections" — fetches the pads semantically closest to the current
// one. Reuses the same embeddings the RAG already computes; requires the pad
// to have been indexed at least once.
//
// Returns `null` while loading, `[]` when there are no matches (or the pad
// isn't indexed yet), otherwise the top-K matches sorted by score desc.
export function useRelatedPads(padId: string | undefined, topK = 5): {
  related: RelatedPad[] | null;
  notIndexed: boolean;
} {
  const [related, setRelated] = useState<RelatedPad[] | null>(null);
  const [notIndexed, setNotIndexed] = useState(false);

  useEffect(() => {
    if (!padId) { setRelated(null); return; }
    let cancelled = false;
    setRelated(null);
    setNotIndexed(false);
    fetch('/api/ai/related-pads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad_id: padId, top_k: topK }),
    })
      .then(r => r.ok ? r.json() : { related: [] })
      .then(data => {
        if (cancelled) return;
        setRelated(data.related || []);
        setNotIndexed(data.reason === 'not-indexed');
      })
      .catch(() => { if (!cancelled) setRelated([]); });
    return () => { cancelled = true; };
  }, [padId, topK]);

  return { related, notIndexed };
}
