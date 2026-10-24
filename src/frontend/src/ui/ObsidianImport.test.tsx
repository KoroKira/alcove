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

  it('provides an accessible dialog and explicit file and folder selection controls', () => {
    render(<ObsidianImport onClose={vi.fn()} onImported={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: 'Importer depuis Obsidian' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Sélectionner des fichiers' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sélectionner un dossier' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fermer l’import' })).toBeInTheDocument();
  });

  it('keeps keyboard focus inside the dialog and restores the opener when closed', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const { unmount } = render(<ObsidianImport onClose={onClose} onImported={vi.fn()} />);
    const close = screen.getByRole('button', { name: 'Fermer l’import' });
    const folder = screen.getByRole('button', { name: 'Sélectionner un dossier' });
    const dialog = screen.getByRole('dialog', { name: 'Importer depuis Obsidian' });

    expect(close).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(folder).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('returns focus to the stable Add control when the opener was unmounted', () => {
    const opener = document.createElement('button');
    const fallback = document.createElement('button');
    fallback.dataset.focusReturn = 'add';
    document.body.append(opener, fallback);
    opener.focus();
    const { unmount } = render(<ObsidianImport onClose={vi.fn()} onImported={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Fermer l’import' })).toHaveFocus();
    opener.remove();
    unmount();

    expect(fallback).toHaveFocus();
    fallback.remove();
  });

  it('uses the stable Add control when the document body was focused after the opener unmounted', () => {
    const fallback = document.createElement('button');
    fallback.dataset.focusReturn = 'add';
    document.body.append(fallback);
    document.body.focus();
    expect(document.activeElement).toBe(document.body);
    const { unmount } = render(<ObsidianImport onClose={vi.fn()} onImported={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Fermer l’import' })).toHaveFocus();
    unmount();

    expect(fallback).toHaveFocus();
    fallback.remove();
  });

  it('prevents accidental dismissal while files are being imported', async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    const { container } = render(<ObsidianImport onClose={onClose} onImported={vi.fn()} />);
    const folderInput = container.querySelector('input[webkitdirectory]')!;
    fireEvent.change(folderInput, {
      target: { files: [note('Vault/Only.md', '# Test')] },
    });

    const dialog = screen.getByRole('dialog', { name: 'Importer depuis Obsidian' });
    const close = await screen.findByRole('button', { name: 'Import en cours, fermeture indisponible' });
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(close).toHaveAttribute('aria-disabled', 'true');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(container.querySelector('.obs-import__backdrop')!);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(close);
    expect(onClose).not.toHaveBeenCalled();

    resolveFetch?.(response('pad-only'));
    expect(await screen.findByText('1 note importée ✓')).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('button', { name: 'Fermer l’import' })).toHaveAttribute('aria-disabled', 'false');
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

  it('announces import progress to assistive technology while the import is running', async () => {
    let resolveSecond: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response('pad-first'))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveSecond = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<ObsidianImport onClose={vi.fn()} onImported={vi.fn()} />);
    const folderInput = container.querySelector('input[webkitdirectory]')!;

    fireEvent.change(folderInput, {
      target: { files: [note('Vault/First.md', 'first'), note('Vault/Second.md', 'second')] },
    });

    const progress = await screen.findByRole('progressbar', { name: 'Progression de l’import Obsidian' });
    await waitFor(() => expect(progress).toHaveAttribute('aria-valuenow', '1'));
    expect(progress).toHaveAttribute('aria-valuemax', '2');
    expect(progress).toHaveAttribute('aria-valuetext', '1 / 2 fichiers traités');
    expect(screen.getByRole('status')).toHaveTextContent('1 / 2 fichiers traités');

    resolveSecond?.(response('pad-second'));
    expect(await screen.findByText('2 notes importées ✓')).toBeInTheDocument();
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
