import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChatMessage from './ChatMessage';

const sources = [
  { n: 1, pad_id: 'p1', pad_name: 'Note A', score: 0.9, chunk_text: 'extrait' },
  { n: 2, pad_id: 'p2', pad_name: 'Note B', score: 0.8, chunk_text: 'extrait' },
];
const base = { index: 0, isLast: true, streaming: false, onFollowup: vi.fn(), onAddToNotebook: vi.fn() };
const msg = (content: string, src: any = sources) => ({ role: 'assistant', content, sources: src }) as any;

describe('ChatMessage citation trust', () => {
  it('shows no warning when every reference is backed by a source', () => {
    render(<ChatMessage {...base} msg={msg('Fait [[1]] et fait [[2]].')} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('warns about references that match no source', () => {
    render(<ChatMessage {...base} msg={msg('Fait [[1]] puis inventé [[8]].')} />);
    expect(screen.getByRole('note')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Citation 8/ })).toBeInTheDocument();
  });

  it('warns when sources exist but the answer cites none', () => {
    render(<ChatMessage {...base} msg={msg('Une réponse sans aucune référence.')} />);
    expect(screen.getByRole('note')).toBeInTheDocument();
  });

  it('does not warn while streaming, with no sources, or on an empty answer', () => {
    const { rerender } = render(<ChatMessage {...base} streaming msg={msg('en cours')} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    rerender(<ChatMessage {...base} msg={msg('Aucune note pertinente.', [])} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    rerender(<ChatMessage {...base} msg={msg('   ')} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});
