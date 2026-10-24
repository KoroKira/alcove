import { useEffect, useRef } from 'react';

/** Retry a failed autosave once after a real offline → online transition. */
export function useRetryOnReconnect(shouldRetry: boolean, retry: () => void): void {
  const retryRef = useRef(retry);
  const shouldRetryRef = useRef(shouldRetry);
  const wasOfflineRef = useRef(typeof navigator !== 'undefined' && !navigator.onLine);
  const reconnectPendingRef = useRef(false);

  retryRef.current = retry;
  shouldRetryRef.current = shouldRetry;

  useEffect(() => {
    const onOffline = () => {
      wasOfflineRef.current = true;
      reconnectPendingRef.current = false;
    };
    const onOnline = () => {
      if (!wasOfflineRef.current) return;
      wasOfflineRef.current = false;
      if (shouldRetryRef.current) retryRef.current();
      else reconnectPendingRef.current = true;
    };

    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  // A failed request can settle just after the online event. Keep that one
  // reconnect pending so the draft still retries, without looping on a server
  // error that persists while the browser is online.
  useEffect(() => {
    if (!shouldRetry || !reconnectPendingRef.current) return;
    reconnectPendingRef.current = false;
    retryRef.current();
  }, [shouldRetry]);
}
