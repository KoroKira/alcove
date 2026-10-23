import { describe, expect, it, vi } from 'vitest';
import { createManualSnapshot } from './manualSnapshot';

describe('manual revision snapshots', () => {
  it('confirms a snapshot only after the server accepts it', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;

    await expect(createManualSnapshot('pad-1', request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith('/api/pad/pad-1/versions/snapshot', { method: 'POST' });
  });

  it('rejects an HTTP failure so the UI can report that the snapshot was not confirmed', async () => {
    const request = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;

    await expect(createManualSnapshot('pad-1', request)).rejects.toThrow('Snapshot request failed (503).');
  });
});
