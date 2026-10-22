import { useCallback, useEffect, useState } from 'react';

type LoadState<T> =
  | { padId: string; status: 'idle' | 'loading' }
  | { padId: string; status: 'ready'; data: T }
  | { padId: string; status: 'error'; error: string };

/** Load structured pad data without allowing a slow, stale response to replace
 * the currently selected pad. The returned setter lets the editor keep the
 * parent's view in sync after local edits. */
export function useStructuredPadData<T>(padId: string, enabled: boolean) {
  const [state, setState] = useState<LoadState<T>>({ padId, status: 'idle' });
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!enabled || !padId) {
      setState({ padId, status: 'idle' });
      return;
    }

    let active = true;
    const controller = new AbortController();
    setState({ padId, status: 'loading' });

    fetch(`/api/pad/${encodeURIComponent(padId)}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<T>;
      })
      .then(data => {
        if (active) setState({ padId, status: 'ready', data });
      })
      .catch(cause => {
        if (!active || controller.signal.aborted) return;
        const detail = cause instanceof Error ? cause.message : String(cause);
        setState({ padId, status: 'error', error: detail });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [padId, enabled, retryCount]);

  const setData = useCallback((data: T) => {
    setState({ padId, status: 'ready', data });
  }, [padId]);

  const retry = useCallback(() => setRetryCount(count => count + 1), []);

  // A pad switch renders before its effect runs. Hide the previous pad's data
  // immediately so it cannot briefly appear under the new pad's title.
  const current = state.padId === padId ? state : { padId, status: enabled ? 'loading' as const : 'idle' as const };

  return {
    data: current.status === 'ready' ? current.data : null,
    loading: current.status === 'loading',
    error: current.status === 'error' ? current.error : null,
    setData,
    retry,
  };
}
