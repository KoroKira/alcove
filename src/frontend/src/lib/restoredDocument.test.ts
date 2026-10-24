import { afterEach, describe, expect, it, vi } from 'vitest';
import { reloadRestoredDocument } from './restoredDocument';

afterEach(() => vi.unstubAllGlobals());

describe('reloadRestoredDocument', () => {
  it('returns empty restored content together with its new save baseline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: '', updated_at: '2026-10-24T00:01:00Z' }) }));
    await expect(reloadRestoredDocument('isolated-pad')).resolves.toEqual({ content: '', updatedAt: '2026-10-24T00:01:00Z' });
  });

  it('rejects an incomplete reload instead of clearing the current document', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ updated_at: '2026-10-24T00:01:00Z' }) }));
    await expect(reloadRestoredDocument('isolated-pad')).rejects.toThrow('réponse est incomplète');
  });

  it('rejects content without the version needed for the next safe autosave', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: 'Restored' }) }));
    await expect(reloadRestoredDocument('isolated-pad')).rejects.toThrow('réponse est incomplète');
  });

  it('reports a failed reload distinctly from a failed restore', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(reloadRestoredDocument('isolated-pad')).rejects.toThrow('Restauration effectuée, mais rechargement impossible (503).');
  });
});
