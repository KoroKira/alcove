import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useRelatedPads } from './useRelatedPads';

function mockFetchOnce(response: Response) {
  globalThis.fetch = vi.fn(() => Promise.resolve(response)) as unknown as typeof fetch;
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

describe('useRelatedPads', () => {
  it('returns null while loading, then the list', async () => {
    mockFetchOnce(jsonResponse({
      related: [
        { pad_id: 'a', pad_name: 'A', score: 0.9 },
        { pad_id: 'b', pad_name: 'B', score: 0.7 },
      ],
    }));

    const { result } = renderHook(() => useRelatedPads('some-pad'));

    expect(result.current.related).toBeNull();

    await waitFor(() => expect(result.current.related).not.toBeNull());
    expect(result.current.related).toHaveLength(2);
    expect(result.current.related![0].pad_name).toBe('A');
    expect(result.current.notIndexed).toBe(false);
  });

  it('sets notIndexed=true when backend reports not-indexed', async () => {
    mockFetchOnce(jsonResponse({ related: [], reason: 'not-indexed' }));

    const { result } = renderHook(() => useRelatedPads('unindexed-pad'));
    await waitFor(() => expect(result.current.related).toEqual([]));
    expect(result.current.notIndexed).toBe(true);
  });

  it('does not fetch when padId is undefined', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useRelatedPads(undefined));
    // Give the effect a tick to prove it stays inert.
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.related).toBeNull();
  });

  it('cancels stale request when padId changes', async () => {
    // First call resolves late, second call resolves fast.
    let firstResolve!: (v: Response) => void;
    const firstPromise = new Promise<Response>((r) => { firstResolve = r; });

    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(firstPromise)
      .mockReturnValueOnce(Promise.resolve(jsonResponse({ related: [{ pad_id: 'b', pad_name: 'B', score: 0.5 }] })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result, rerender } = renderHook(({ id }) => useRelatedPads(id), {
      initialProps: { id: 'first' },
    });

    // Swap pad before the first request settles.
    rerender({ id: 'second' });
    await waitFor(() => expect(result.current.related?.[0]?.pad_name).toBe('B'));

    // Now let the stale response arrive — it must be ignored (not overwrite state).
    firstResolve(jsonResponse({ related: [{ pad_id: 'a', pad_name: 'STALE', score: 0.9 }] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.related?.[0]?.pad_name).toBe('B');
  });
});
