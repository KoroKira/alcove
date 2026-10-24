import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRetryOnReconnect } from './useRetryOnReconnect';

describe('useRetryOnReconnect', () => {
  it('retries once when a failed save is pending at reconnection', () => {
    const retry = vi.fn();
    const { rerender } = renderHook(
      ({ shouldRetry }) => useRetryOnReconnect(shouldRetry, retry),
      { initialProps: { shouldRetry: false } },
    );

    act(() => window.dispatchEvent(new Event('offline')));
    rerender({ shouldRetry: true });
    act(() => window.dispatchEvent(new Event('online')));

    expect(retry).toHaveBeenCalledTimes(1);
    rerender({ shouldRetry: false });
    rerender({ shouldRetry: true });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('retries if the request fails just after the online event', () => {
    const retry = vi.fn();
    const { rerender } = renderHook(
      ({ shouldRetry }) => useRetryOnReconnect(shouldRetry, retry),
      { initialProps: { shouldRetry: false } },
    );

    act(() => {
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });
    rerender({ shouldRetry: true });

    expect(retry).toHaveBeenCalledTimes(1);
  });
});
