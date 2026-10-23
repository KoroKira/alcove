import { describe, expect, it, vi } from 'vitest';
import { saveDocumentAfterConflict } from './conflictSave';

const response = (ok: boolean, status: number, body: unknown = {}) => ({
  ok, status, json: async () => body,
} as Response);

describe('saveDocumentAfterConflict', () => {
  it('snapshots the current server version before retrying with its version token', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response(true, 200, { updated_at: 'server-v2' }))
      .mockResolvedValueOnce(response(true, 200))
      .mockResolvedValueOnce(response(true, 200, { updated_at: 'server-v3' }));

    await expect(saveDocumentAfterConflict('pad-1', '/api/pad/pad-1/doc', updatedAt => ({
      content: 'local draft', format: 'markdown', expected_updated_at: updatedAt,
    }), request as unknown as typeof fetch)).resolves.toBe('server-v3');

    expect(request.mock.calls.map(([url]) => url)).toEqual([
      '/api/pad/pad-1',
      '/api/pad/pad-1/versions/snapshot',
      '/api/pad/pad-1/doc',
    ]);
    expect(JSON.parse(request.mock.calls[2][1]?.body as string)).toMatchObject({
      content: 'local draft', expected_updated_at: 'server-v2',
    });
  });

  it('does not overwrite if protecting the current server version fails', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response(true, 200, { updated_at: 'server-v2' }))
      .mockResolvedValueOnce(response(false, 500));

    await expect(saveDocumentAfterConflict('pad-1', '/api/pad/pad-1/doc', () => ({}), request as unknown as typeof fetch))
      .rejects.toThrow('protéger la version serveur');
    expect(request).toHaveBeenCalledTimes(2);
  });
});
