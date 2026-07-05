/**
 * Lightweight subsequence fuzzy matcher (VS Code "quick open" style).
 * Returns a score (higher = better) or null when `query` isn't a subsequence
 * of `text`. Rewards consecutive matches, word-boundary hits, and early matches.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;

  let score = 0;
  let qi = 0;
  let prevMatchIdx = -1;
  let consecutive = 0;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      let bonus = 1;
      // Consecutive-character streak bonus
      if (prevMatchIdx === ti - 1) {
        consecutive += 1;
        bonus += consecutive * 4;
      } else {
        consecutive = 0;
      }
      // Word-boundary bonus (start of string, or after a separator)
      const prevChar = t[ti - 1];
      if (ti === 0 || prevChar === ' ' || prevChar === '-' || prevChar === '_' || prevChar === '/') {
        bonus += 8;
      }
      // Earlier matches are slightly better
      bonus += Math.max(0, 4 - Math.floor(ti / 8));
      score += bonus;
      prevMatchIdx = ti;
      qi += 1;
    }
  }

  return qi === q.length ? score : null;
}

/**
 * Sort + filter an array by fuzzy score against `query`. When the query is
 * empty, everything passes with score 0 (caller decides the fallback order).
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
): { item: T; score: number }[] {
  const q = query.trim();
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const s = fuzzyScore(q, getText(item));
    if (s !== null) scored.push({ item, score: s });
  }
  if (q) scored.sort((a, b) => b.score - a.score);
  return scored;
}
