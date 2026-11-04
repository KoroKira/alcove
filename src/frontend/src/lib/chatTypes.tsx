/**
 * Shared types + the [[N]] citation renderer for agentic RAG chat messages.
 * Used by both AIPanel's RAG tab and the full-page ChatView (chantier #16) —
 * extracted here so the two surfaces render identically without copy-pasting
 * the same ~150 lines of JSX in two places.
 */
import React from 'react';
import type { AgenticSource, AgenticStep } from './rag';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: RagSource[];
  // Fanout sub-queries the agentic flow generated for this turn.
  subqueries?: string[];
  // Named reasoning-trace steps (chantier #18) — preferred over `subqueries`
  // for display when present; falls back to the plain subqueries list for
  // any code path that hasn't been updated to emit steps.
  steps?: AgenticStep[];
  // Follow-up questions proposed after the answer settled.
  followups?: string[];
}

// Extends AgenticSource — the chat UI and agenticRagChat agree on shape so no
// adapter is needed between them. `n` is present for agentic messages.
export type RagSource = Partial<AgenticSource> & {
  pad_id: string;
  pad_name: string;
  score: number;
};

export function filterThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

const CITATION_RE = /\[\[(\d{1,3})\]\]/g;

/**
 * Check the [[N]] markers of an answer against the sources it was given.
 * `valid` are numbers that exist in `sources`; `invalid` are references the
 * model invented. Messages without numbered sources are not verifiable.
 */
export function analyzeCitations(
  text: string,
  sources: ReadonlyArray<{ n?: number }> | undefined,
): { verifiable: boolean; valid: number[]; invalid: number[] } {
  const known = new Set((sources ?? []).map(s => s.n).filter((n): n is number => typeof n === 'number'));
  if (known.size === 0) return { verifiable: false, valid: [], invalid: [] };
  const valid = new Set<number>();
  const invalid = new Set<number>();
  for (const match of text.matchAll(CITATION_RE)) {
    const n = parseInt(match[1], 10);
    (known.has(n) ? valid : invalid).add(n);
  }
  return { verifiable: true, valid: [...valid].sort((a, b) => a - b), invalid: [...invalid].sort((a, b) => a - b) };
}

/**
 * Render an assistant message that embeds [[N]] citation markers as a mix of
 * plain text spans and small clickable chips. Each chip scrolls the sources
 * drawer to entry #N and briefly highlights it. When `knownSources` is given,
 * a marker that points to no listed source is NOT rendered as a clickable
 * reference: it is shown as an explicit "unverified" mark instead.
 */
export function renderWithCitations(
  text: string,
  onCite: (n: number) => void,
  knownSources?: ReadonlySet<number>,
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = new RegExp(CITATION_RE.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const n = parseInt(m[1], 10);
    if (knownSources && !knownSources.has(n)) {
      parts.push(
        <span
          key={`c${m.index}`}
          className="ai-msg__cite ai-msg__cite--invalid"
          role="img"
          aria-label={`Citation ${n} sans source correspondante`}
          title={`Citation ${n} : aucune source correspondante`}
        >
          ?
        </span>
      );
    } else {
      parts.push(
        <button
          key={`c${m.index}`}
          type="button"
          className="ai-msg__cite"
          onClick={() => onCite(n)}
          title={`Source ${n}`}
          aria-label={`Source ${n}`}
        >
          {n}
        </button>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
