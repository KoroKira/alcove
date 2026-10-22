import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStructuredPadData } from './useStructuredPadData';

interface PadData { label: string; }

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('useStructuredPadData', () => {
  it('ignores an older pad response when selection changes quickly', async () => {
    const pending: Array<{
      url: string;
      signal: AbortSignal;
      resolve: (value: Response) => void;
    }> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(resolve => {
      pending.push({ url: String(input), signal: init?.signal as AbortSignal, resolve });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(
      ({ padId }) => useStructuredPadData<PadData>(padId, true),
      { initialProps: { padId: 'pad-a' } },
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    rerender({ padId: 'pad-b' });
    await waitFor(() => expect(pending).toHaveLength(2));

    expect(pending[0].url).toBe('/api/pad/pad-a');
    expect(pending[0].signal.aborted).toBe(true);
    expect(pending[1].url).toBe('/api/pad/pad-b');

    await act(async () => pending[1].resolve(response({ label: 'B' })));
    await waitFor(() => expect(result.current.data).toEqual({ label: 'B' }));
    await act(async () => pending[0].resolve(response({ label: 'A' })));
    expect(result.current.data).toEqual({ label: 'B' });
  });

  it('shows load errors and retries on request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ detail: 'Unavailable' }, 503))
      .mockResolvedValueOnce(response({ label: 'Recovered' }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useStructuredPadData<PadData>('pad-a', true));
    await waitFor(() => expect(result.current.error).toBe('HTTP 503'));
    expect(result.current.data).toBeNull();

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.data).toEqual({ label: 'Recovered' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
