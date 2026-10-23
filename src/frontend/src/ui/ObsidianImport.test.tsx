import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ObsidianImport from './ObsidianImport';

type VaultFile = File & { webkitRelativePath: string };

function note(path: string, contents: string): VaultFile {
  const name = path.split('/').at(-1) || 'Note.md';
  const file = {
    name,
    webkitRelativePath: path,
    text: vi.fn().mockResolvedValue(contents),
  } as unknown as VaultFile;
  return file;
}

function response(id: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ id }),
  } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('ObsidianImport', () => {
  it('imports vault Markdown notes with their folders and reports created pads', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response('pad-overview'))
      .mockResolvedValueOnce(response('pad-design'));
    vi.stubGlobal('fetch', fetchMock);
    const onImported = vi.fn();
    const { container } = render(<ObsidianImport onClose={vi.fn()} onImported={onImported} />);
    const folderInput = container.querySelector('input[webkitdirectory]');
    expect(folderInput).not.toBeNull();

    fireEvent.change(folderInput!, {
      target: {
        files: [
          note('My vault/Projects/Launch/Overview.md', '# Launch overview'),
          note('My vault/Projects/Launch/Design.md', '# Design notes'),
          note('My vault/.obsidian/workspace.md', 'private workspace state'),
          note('My vault/.trash/Deleted.md', 'deleted note'),
          { name: 'diagram.png', webkitRelativePath: 'My vault/Projects/Launch/diagram.png' },
        ],
      },
    });

    expect(await screen.findByText('2 notes importées ✓')).toBeInTheDocument();
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Design')).toBeInTheDocument();
    expect(screen.queryByText('workspace')).not.toBeInTheDocument();
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/pad/new', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        pad_type: 'document',
        display_name: 'Overview',
        content: '# Launch overview',
        folder: 'Projects/Launch',
      }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/pad/new', expect.objectContaining({
      body: JSON.stringify({
        pad_type: 'document',
        display_name: 'Design',
        content: '# Design notes',
        folder: 'Projects/Launch',
      }),
    }));
    expect(onImported).toHaveBeenCalledWith(['pad-overview', 'pad-design']);
  });

  it('continues after a failed note and shows the per-note error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ detail: 'Storage temporarily unavailable' }),
      })
      .mockResolvedValueOnce(response('pad-second'));
    vi.stubGlobal('fetch', fetchMock);
    const onImported = vi.fn();
    const { container } = render(<ObsidianImport onClose={vi.fn()} onImported={onImported} />);
    const folderInput = container.querySelector('input[webkitdirectory]')!;

    fireEvent.change(folderInput, {
      target: { files: [note('Vault/First.md', 'first'), note('Vault/Second.md', 'second')] },
    });

    expect(await screen.findByText('1 note importée ✓')).toBeInTheDocument();
    expect(screen.getByText('Storage temporarily unavailable')).toBeInTheDocument();
    expect(onImported).toHaveBeenCalledWith(['pad-second']);
  });

  it('retries only failed notes without recreating notes that already imported', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ detail: 'Storage temporarily unavailable' }),
      })
      .mockResolvedValueOnce(response('pad-second'))
      .mockResolvedValueOnce(response('pad-first-retry'));
    vi.stubGlobal('fetch', fetchMock);
    const onImported = vi.fn();
    const { container } = render(<ObsidianImport onClose={vi.fn()} onImported={onImported} />);
    const folderInput = container.querySelector('input[webkitdirectory]')!;

    fireEvent.change(folderInput, {
      target: { files: [note('Vault/First.md', 'first'), note('Vault/Second.md', 'second')] },
    });

    expect(await screen.findByText('1 note importée ✓')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer les 1 échec' }));

    expect(await screen.findByText('2 notes importées ✓')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/pad/new', expect.objectContaining({
      body: JSON.stringify({ pad_type: 'document', display_name: 'First', content: 'first' }),
    }));
    expect(screen.getAllByText('First')).toHaveLength(1);
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(onImported).toHaveBeenNthCalledWith(1, ['pad-second']);
    expect(onImported).toHaveBeenNthCalledWith(2, ['pad-first-retry']);
  });
});
