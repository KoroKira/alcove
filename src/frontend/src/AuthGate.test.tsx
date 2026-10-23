import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AuthGate from './AuthGate';

const mocks = vi.hoisted(() => ({
  auth: { isAuthenticated: false as boolean | undefined, isLoading: false },
  clearPrivateApiCaches: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./hooks/useAuthStatus', () => ({ useAuthStatus: () => mocks.auth }));
vi.mock('./hooks/useAppConfig', () => ({ useAppConfig: () => ({ config: null, isLoadingConfig: true, configError: null }) }));
vi.mock('./lib/privateApiCache', () => ({ clearPrivateApiCaches: mocks.clearPrivateApiCaches }));

describe('AuthGate private API cache cleanup', () => {
  beforeEach(() => {
    mocks.clearPrivateApiCaches.mockClear();
    mocks.auth.isAuthenticated = false;
    mocks.auth.isLoading = false;
  });

  it('clears authenticated caches when Alcove confirms the session is unauthenticated', async () => {
    render(<AuthGate />);
    await waitFor(() => expect(mocks.clearPrivateApiCaches).toHaveBeenCalledOnce());
  });

  it('keeps offline caches while authentication is loading or unknown', () => {
    mocks.auth.isAuthenticated = undefined;
    mocks.auth.isLoading = true;
    render(<AuthGate />);
    expect(mocks.clearPrivateApiCaches).not.toHaveBeenCalled();
  });

  it('keeps caches for an authenticated session', () => {
    mocks.auth.isAuthenticated = true;
    render(<AuthGate />);
    expect(mocks.clearPrivateApiCaches).not.toHaveBeenCalled();
  });
});
