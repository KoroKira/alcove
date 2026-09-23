import { describe, expect, it } from 'vitest';
import { isAllowedHtmlApiRequest } from './htmlPreviewSecurity';

describe('HTML preview API bridge security', () => {
  const iframeWindow = {} as Window;
  const origin = 'https://alcove.example';

  const request = (overrides: Record<string, unknown> = {}) => ({
    type: 'API_REQUEST',
    endpoint: '/api/auth/status',
    method: 'GET',
    requestId: 'req-1',
    ...overrides,
  });

  it('accepts only requests from the exact preview iframe and same-origin API paths', () => {
    expect(isAllowedHtmlApiRequest(request(), iframeWindow, iframeWindow, origin)).toBe(true);
    expect(isAllowedHtmlApiRequest(request({ endpoint: '/api/pad/secret' }), iframeWindow, iframeWindow, origin)).toBe(false);
    expect(isAllowedHtmlApiRequest(request({ endpoint: 'https://evil.example/api' }), iframeWindow, iframeWindow, origin)).toBe(false);
    expect(isAllowedHtmlApiRequest(request({ endpoint: '//evil.example/api' }), iframeWindow, iframeWindow, origin)).toBe(false);
    expect(isAllowedHtmlApiRequest(request(), {} as Window, iframeWindow, origin)).toBe(false);
  });

  it('rejects state-changing methods', () => {
    expect(isAllowedHtmlApiRequest(request({ method: 'POST' }), iframeWindow, iframeWindow, origin)).toBe(false);
    expect(isAllowedHtmlApiRequest(request({ method: 'DELETE' }), iframeWindow, iframeWindow, origin)).toBe(false);
  });
});
