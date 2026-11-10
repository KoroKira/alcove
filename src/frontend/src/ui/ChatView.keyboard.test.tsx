import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatView from './ChatView';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function mockNetwork() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/ai/conversations')) {
      return json({ conversations: [
        { id: 'c1', title: 'Plan du projet', updated_at: '2026-01-02T10:00:00Z', message_count: 2 },
        { id: 'c2', title: 'Idées de tags', updated_at: '2026-01-01T10:00:00Z', message_count: 1 },
      ] });
    }
    if (url.includes('/api/ai/conversations/')) {
      return json({ messages: [{ role: 'user', content: 'Bonjour' }, { role: 'assistant', content: 'Salut' }] });
    }
    if (url.includes('/api/ai/ollama/api/tags')) return json({ models: [{ name: 'llama3.2', size: 0, modified_at: '' }] });
    if (url.includes('/api/ai/chat/preamble')) return json({ system: '', default_model: 'llama3.2' });
    return json({});
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => vi.restoreAllMocks());

describe('ChatView conversation list keyboard access', () => {
  it('lets keyboard users open a conversation and marks the current one', async () => {
    const fetchMock = mockNetwork();
    render(<ChatView onClose={vi.fn()} />);

    const row = await screen.findByRole('button', { name: 'Idées de tags' });
    expect(row).toHaveAttribute('tabindex', '0');
    expect(row).not.toHaveAttribute('aria-current');

    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/ai/conversations/c2'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Idées de tags' })).toHaveAttribute('aria-current', 'true'));
    expect(screen.getByRole('button', { name: 'Plan du projet' })).not.toHaveAttribute('aria-current');

    fireEvent.keyDown(screen.getByRole('button', { name: 'Plan du projet' }), { key: ' ' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/ai/conversations/c1'));
  });
});
