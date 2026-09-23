export interface HtmlApiRequest {
  type?: unknown;
  endpoint?: unknown;
  method?: unknown;
  requestId?: unknown;
}

export const DEFAULT_HTML_PREVIEW_API_PATHS = ['/api/auth/status'] as const;

/**
 * The HTML preview is sandboxed and therefore reports an opaque origin
 * (usually "null"). The reliable capability check is the exact iframe window
 * object plus a narrow, read-only same-origin API surface.
 */
export function isAllowedHtmlApiRequest(
  data: HtmlApiRequest,
  source: MessageEventSource | null,
  iframeWindow: Window | null,
  currentOrigin: string,
  allowedPaths: readonly string[] = DEFAULT_HTML_PREVIEW_API_PATHS,
): data is HtmlApiRequest & { endpoint: string; requestId: string; method: 'GET' } {
  if (source !== iframeWindow || data?.type !== 'API_REQUEST') return false;
  if (typeof data.endpoint !== 'string' || typeof data.requestId !== 'string') return false;
  if (data.requestId.length < 1 || data.requestId.length > 128) return false;
  if (data.method !== undefined && data.method !== 'GET') return false;

  try {
    const url = new URL(data.endpoint, currentOrigin);
    return (
      url.origin === currentOrigin &&
      allowedPaths.includes(url.pathname) &&
      !url.username &&
      !url.password &&
      data.endpoint.startsWith('/') &&
      !data.endpoint.startsWith('//')
    );
  } catch {
    return false;
  }
}
