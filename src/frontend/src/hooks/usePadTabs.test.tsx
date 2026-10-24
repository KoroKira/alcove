import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharingPolicy, usePadTabs } from './usePadTabs';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function response(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response;
}

const existingPad = {
  id: 'pad-existing',
  display_name: 'Note existante',
  owner_id: 'user-1',
  sharing_policy: SharingPolicy.PRIVATE,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  pad_type: 'document',
};

const createdPad = {
  id: 'pad-created',
  display_name: 'New document',
  owner_id: 'user-1',
  sharing_policy: SharingPolicy.PRIVATE,
  created_at: '2026-10-24T00:00:00Z',
  updated_at: '2026-10-24T00:00:00Z',
  pad_type: 'document',
};

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

afterEach(() => vi.unstubAllGlobals());

describe('usePadTabs pad creation', () => {
  it('keeps folders visible and selects the created document through server confirmation', async () => {
    const create = deferred<Response>();
    const serverPads = [existingPad];
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/users/me') {
        return Promise.resolve(response({
          pads: serverPads,
          folders: ['Projects'],
          last_selected_pad: 'pad-existing',
        }));
      }
      if (url === '/api/pad/new') return create.promise;
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, wrapper } = makeWrapper();
    const { result, unmount } = renderHook(() => usePadTabs(true), { wrapper });

    await waitFor(() => expect(result.current.tabs.map(tab => tab.id)).toEqual(['pad-existing']));
    expect(result.current.folders).toEqual(['Projects']);

    act(() => result.current.createNewDocument());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/pad/new',
      expect.objectContaining({ method: 'POST' }),
    ));

    const tempId = result.current.selectedTabId;
    expect(tempId).toMatch(/^temp-/);
    expect(result.current.folders).toEqual(['Projects']);
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => String(url) === '/api/pad/new')?.[1]?.body)))
      .toEqual({ pad_type: 'document', display_name: 'New document' });

    serverPads.push(createdPad);
    await act(async () => {
      create.resolve(response(createdPad));
      await create.promise;
    });

    await waitFor(() => expect(result.current.tabs.some(tab => tab.id === 'pad-created')).toBe(true));
    expect(result.current.selectedTabId).toBe('pad-created');
    expect(result.current.folders).toEqual(['Projects']);

    unmount();
    queryClient.clear();
  });

  it('removes the optimistic pad and restores selection when creation fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/users/me') {
        return response({ pads: [existingPad], folders: ['Projects'], last_selected_pad: 'pad-existing' });
      }
      if (url === '/api/pad/new') return response({ detail: 'Creation failed' }, 503);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, wrapper } = makeWrapper();
    const { result, unmount } = renderHook(() => usePadTabs(true), { wrapper });

    await waitFor(() => expect(result.current.selectedTabId).toBe('pad-existing'));
    await act(async () => {
      await expect(result.current.createNewDocumentAsync()).rejects.toThrow('Creation failed');
    });

    await waitFor(() => expect(result.current.tabs.map(tab => tab.id)).toEqual(['pad-existing']));
    expect(result.current.selectedTabId).toBe('pad-existing');
    expect(result.current.folders).toEqual(['Projects']);

    unmount();
    queryClient.clear();
  });
});
