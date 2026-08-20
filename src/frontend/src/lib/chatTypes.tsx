/**
 * Shared types + the [[N]] citation renderer for agentic RAG chat messages.
 * Used by both AIPanel's RAG tab and the full-page ChatView (chantier #16) —
 * extracted here so the two surfaces render identically without copy-pasting
 * the same ~150 lines of JSX in two places.
 */
import React from 'react';
import type { AgenticSource } from './rag';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: RagSource[];
  // Fanout sub-queries the agentic flow generated for this turn.
  subqueries?: string[];
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

/**
 * Render an assistant message that embeds [[N]] citation markers as a mix of
 * plain text spans and small clickable chips. Each chip scrolls the sources
 * drawer to entry #N and briefly highlights it.
 */
export function renderWithCitations(
  text: string,
  onCite: (n: number) => void,
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /\[\[(\d{1,3})\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const n = parseInt(m[1], 10);
    parts.push(
      <button
        key={`c${m.index}`}
        type="button"
        className="ai-msg__cite"
        onClick={() => onCite(n)}
        title={`Source ${n}`}
      >
        {n}
      </button>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
