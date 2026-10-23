import { describe, expect, it, vi } from 'vitest';
import { importObsidianFiles } from './obsidianImport';

function note(name: string, path: string, content: string): File {
  return {
    name,
    webkitRelativePath: path,
    text: vi.fn().mockResolvedValue(content),
  } as unknown as File;
}

describe('Obsidian import', () => {
  it('creates a populated document in its vault folder in one request', async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'pad-123' }),
    }) as unknown as typeof fetch;
    const progress = vi.fn();
    const files = [
      note('Overview.MD', 'My vault/Projects/Launch/Overview.MD', '# Launch'),
      note('photo.png', 'My vault/Projects/Launch/photo.png', 'binary'),
      note('settings.md', 'My vault/.obsidian/settings.md', 'private config'),
      note('deleted.md', 'My vault/.trash/deleted.md', 'deleted note'),
    ];

    const results = await importObsidianFiles(files, progress, request);

    expect(results).toEqual([{ name: 'Overview', sourceKey: 'My vault/Projects/Launch/Overview.MD', id: 'pad-123' }]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/api/pad/new', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        pad_type: 'document',
        display_name: 'Overview',
        content: '# Launch',
        folder: 'Projects/Launch',
      }),
    }));
    expect(progress).toHaveBeenCalledWith(1);
  });

  it('reports server failures and keeps processing subsequent notes', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ detail: 'Storage temporarily unavailable' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'pad-456' }),
      }) as unknown as typeof fetch;

    const results = await importObsidianFiles([
      note('First.md', 'Vault/First.md', 'one'),
      note('Second.md', 'Vault/Second.md', 'two'),
    ], undefined, request);

    expect(results).toEqual([
      { name: 'First', sourceKey: 'Vault/First.md', error: 'Storage temporarily unavailable' },
      { name: 'Second', sourceKey: 'Vault/Second.md', id: 'pad-456' },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('marks a malformed successful response as an error instead of success', async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const results = await importObsidianFiles([note('Note.md', 'Vault/Note.md', 'text')], undefined, request);

    expect(results).toEqual([{ name: 'Note', sourceKey: 'Vault/Note.md', error: 'Réponse serveur invalide : identifiant du pad absent' }]);
  });
});
