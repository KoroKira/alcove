import { describe, expect, it, vi } from 'vitest';
import { clearPrivateApiCaches } from './privateApiCache';

describe('clearPrivateApiCaches', () => {
  it('removes only the named authenticated API caches', async () => {
    const deleteCache = vi.fn().mockResolvedValue(true);
    await clearPrivateApiCaches({ delete: deleteCache });

    expect(deleteCache.mock.calls.map(([name]) => name).sort()).toEqual(['api-pads', 'api-user']);
  });

  it('is safe when Cache Storage is unavailable', async () => {
    await expect(clearPrivateApiCaches()).resolves.toBeUndefined();
  });
});
