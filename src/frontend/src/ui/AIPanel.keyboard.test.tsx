import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AIPanel from './AIPanel';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function mockNetwork() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/ai/conversations')) {
      return json({ conversations: [
        { id: 'c1', title: 'Résumé de la réunion', updated_at: '2026-01-02T10:00:00Z', message_count: 4 },
        { id: 'c2', title: 'Questions sur le RAG', updated_at: '2026-01-01T10:00:00Z', message_count: 2 },
      ] });
    }
    if (url.includes('/api/ai/conversations/')) return json({ title: 'x', messages: [{ role: 'user', content: 'Bonjour' }] });
    if (url.includes('/api/ai/ollama/api/tags')) return json({ models: [{ name: 'llama3.2', size: 0, modified_at: '' }] });
    if (url.includes('/api/ai/chat/preamble')) return json({ system: '', default_model: 'llama3.2' });
    if (url.includes('/api/ai/memory')) return json({ slots: [] });
    return json({});
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => vi.restoreAllMocks());

describe('AI panel conversation history keyboard access', () => {
  it('lets keyboard users open a past conversation', async () => {
    const fetchMock = mockNetwork();
    render(<AIPanel onClose={vi.fn()} />);

    // Open the history drawer (the bar button carries the conversation count).
    const historyButton = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.ai-panel__conv-btn');
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() => expect(document.querySelector('.ai-panel__conv-count')).not.toBeNull());
    fireEvent.click(historyButton);

    const row = await screen.findByRole('button', { name: 'Questions sur le RAG' });
    expect(row).toHaveAttribute('tabindex', '0');
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/ai/conversations/c2'));
  });
});
