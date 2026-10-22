import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorkspace, WorkspaceIntegrationDisabledError } from './useWorkspace';

describe('useWorkspace optional Coder response', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stops polling once the optional integration is disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        detail: {
          code: 'workspace_integration_disabled',
          message: 'Workspace management is not configured on this Alcove instance.',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result, unmount } = renderHook(() => useWorkspace(), { wrapper });
    await waitFor(() => {
      expect(result.current.stateError).toBeInstanceOf(WorkspaceIntegrationDisabledError);
    });
    await new Promise(resolve => setTimeout(resolve, 5_500));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
    queryClient.clear();
  }, 8_000);

  it.each([
    ['FastAPI object detail', { code: 'workspace_integration_disabled', message: 'Workspace management is not configured on this Alcove instance.' }],
    ['string detail', 'Workspace management is not configured on this Alcove instance.'],
  ])('recognizes a disabled workspace from %s', async (_label, detail) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ detail }),
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useWorkspace(), { wrapper });
    await waitFor(() => {
      expect(result.current.stateError).toBeInstanceOf(WorkspaceIntegrationDisabledError);
    });
    queryClient.clear();
  });
});
