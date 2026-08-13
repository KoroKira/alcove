import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAgentMemory } from './useAgentMemory';

// Minimal fetch mock helper — every test defines the responses it needs.
function mockFetch(responses: Array<Response | Promise<Response>>) {
  const impl = vi.fn(() => Promise.resolve(responses.shift()!));
  globalThis.fetch = impl as unknown as typeof fetch;
  return impl;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('useAgentMemory', () => {
  it('fetches memory slots on mount', async () => {
    const fetchMock = mockFetch([
      jsonResponse({
        slots: [
          { slug: 'profile', display_name: 'Profil', content: '', pad_id: null, updated_at: null },
          { slug: 'preferences', display_name: 'Préférences', content: 'Aime les listes.', pad_id: 'p1', updated_at: '2026-01-01' },
        ],
      }),
    ]);

    const { result } = renderHook(() => useAgentMemory());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchMock).toHaveBeenCalledWith('/api/ai/memory');
    expect(result.current.slots).toHaveLength(2);
    expect(result.current.slots[1].content).toContain('Aime les listes');
  });

  it('write posts the correct payload and refreshes', async () => {
    mockFetch([
      // initial refresh
      jsonResponse({ slots: [] }),
      // write
      jsonResponse({ ok: true, pad_id: 'p1', slug: 'profile', content: 'new' }),
      // refresh after write
      jsonResponse({ slots: [{ slug: 'profile', display_name: 'Profil', content: 'new', pad_id: 'p1', updated_at: null }] }),
    ]);

    const { result } = renderHook(() => useAgentMemory());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = false;
    await act(async () => {
      ok = await result.current.write('profile', 'append', 'A durable fact', 'Section', 'because');
    });
    expect(ok).toBe(true);

    // 3 calls total: initial fetch + write + refresh
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    const writeCall = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(writeCall[0]).toBe('/api/ai/memory/write');
    const body = JSON.parse((writeCall[1] as RequestInit).body as string);
    expect(body).toEqual({
      slug: 'profile',
      op: 'append',
      content: 'A durable fact',
      section: 'Section',
      reason: 'because',
    });
  });

  it('extract returns a proposal when should_save is true', async () => {
    mockFetch([
      jsonResponse({ slots: [] }),
      jsonResponse({
        should_save: true,
        target: 'preferences',
        section: null,
        content: 'user aime les résumés courts',
        reason: 'preference explicite',
      }),
    ]);

    const { result } = renderHook(() => useAgentMemory());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let proposal: Awaited<ReturnType<typeof result.current.extract>> = null;
    await act(async () => {
      proposal = await result.current.extract([{ role: 'user', content: 'hi' }]);
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.target).toBe('preferences');
    expect(proposal!.content).toContain('résumés courts');
  });

  it('extract returns null when the model declines', async () => {
    mockFetch([
      jsonResponse({ slots: [] }),
      jsonResponse({ should_save: false }),
    ]);

    const { result } = renderHook(() => useAgentMemory());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let proposal: Awaited<ReturnType<typeof result.current.extract>> = null;
    await act(async () => {
      proposal = await result.current.extract([{ role: 'user', content: 'hi' }]);
    });
    expect(proposal).toBeNull();
  });

  it('write returns false on non-ok response', async () => {
    mockFetch([
      jsonResponse({ slots: [] }),
      jsonResponse({ detail: 'nope' }, { status: 400 }),
    ]);

    const { result } = renderHook(() => useAgentMemory());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = true;
    await act(async () => {
      ok = await result.current.write('profile', 'append', 'x');
    });
    expect(ok).toBe(false);
  });
});
