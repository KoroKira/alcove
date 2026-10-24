import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DocumentPad from './DocumentPad';

vi.mock('@monaco-editor/react', () => ({
  loader: { config: vi.fn() },
  default: ({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: { readOnly?: boolean; ariaLabel?: string } }) => (
    <textarea aria-label={options.ariaLabel} value={value} readOnly={options.readOnly} onChange={event => onChange(event.target.value)} />
  ),
}));
vi.mock('monaco-editor/esm/vs/editor/editor.api', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/monaco.contribution', () => ({}));
vi.mock('monaco-vim', () => ({ initVimMode: vi.fn() }));
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), run: vi.fn() } }));
vi.mock('../lib/slashCommands', () => ({ registerSlashCommands: vi.fn() }));
vi.mock('../hooks/useRelatedPads', () => ({ useRelatedPads: () => ({ related: [], notIndexed: false }) }));
vi.mock('../ui/ListenButton', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'fr' } }) }));

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('DocumentPad restored revision', () => {
  it('provides a translated accessible name for the Markdown editor', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/backlinks')) return response({ backlinks: [] });
      return response({ content: 'Accessible document', updated_at: 'version-1' });
    }));
    render(<DocumentPad padId="accessible-document" />);

    expect(await screen.findByRole('textbox', { name: 'editor.markdownEditorLabel' })).toBeInTheDocument();
  });

  it('provides a translated accessible name for the LaTeX editor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ data: { source: '\\begin{document}\\end{document}' }, updated_at: 'version-1' })));
    render(<DocumentPad padId="accessible-latex" format="latex" />);

    expect(await screen.findByRole('textbox', { name: 'editor.latexEditorLabel' })).toBeInTheDocument();
  });

  it('retries an unsaved document after network reconnection', async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/backlinks')) return response({ backlinks: [] });
      if (init?.method === 'PUT') {
        attempts += 1;
        if (attempts === 1) throw new Error('offline');
        return response({ updated_at: 'version-2' });
      }
      return response({ content: 'Original document', updated_at: 'version-1' });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<DocumentPad padId="offline-document" />);
    const editor = await screen.findByDisplayValue('Original document');

    window.dispatchEvent(new Event('offline'));
    fireEvent.change(editor, { target: { value: 'Saved after reconnect' } });
    await waitFor(() => expect(attempts).toBe(1), { timeout: 2000 });
    window.dispatchEvent(new Event('online'));

    await waitFor(() => expect(attempts).toBe(2), { timeout: 3000 });
    expect(screen.getByText('editor.saved')).toBeInTheDocument();
  });

  it('retries a save after a rename advances only the server timestamp', async () => {
    let serverVersion = 'version-1';
    let serverContent = 'Original document';
    const saves: Array<{ content: string; expected_updated_at: string }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/backlinks')) return response({ backlinks: [] });
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        saves.push(body);
        if (body.expected_updated_at !== serverVersion) return { ok: false, status: 409 } as Response;
        serverContent = body.content;
        serverVersion = 'version-3';
        return response({ updated_at: serverVersion });
      }
      return response({ content: serverContent, updated_at: serverVersion });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<DocumentPad padId="renamed-pad" />);
    const editor = await screen.findByDisplayValue('Original document');
    serverVersion = 'version-2'; // Metadata-only rename after the initial read.
    fireEvent.change(editor, { target: { value: 'Edited after rename' } });
    await waitFor(() => expect(saves).toHaveLength(2), { timeout: 2000 });
    expect(saves.map(save => save.expected_updated_at)).toEqual(['version-1', 'version-2']);
    await waitFor(() => expect(serverContent).toBe('Edited after rename'));
    expect(screen.queryByText('⚠️ Modifié ailleurs — résolution nécessaire')).not.toBeInTheDocument();
  });

  it('keeps a real concurrent content edit as a conflict', async () => {
    let serverVersion = 'version-1';
    let serverContent = 'Original document';
    const saves: Array<{ content: string; expected_updated_at: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/backlinks')) return response({ backlinks: [] });
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        saves.push(body);
        return { ok: false, status: 409 } as Response;
      }
      return response({ content: serverContent, updated_at: serverVersion });
    }));
    render(<DocumentPad padId="concurrent-pad" />);
    const editor = await screen.findByDisplayValue('Original document');
    serverVersion = 'version-2';
    serverContent = 'Changed on another device';
    fireEvent.change(editor, { target: { value: 'My local draft' } });
    await screen.findByText('⚠️ Modifié ailleurs — résolution nécessaire', {}, { timeout: 2000 });
    expect(saves).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Garder mon brouillon' })).toBeInTheDocument();
  });

  it('saves the next edit against the restored version and updates the assistant context', async () => {
    let restored = false;
    const onContentChange = vi.fn();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/backlinks')) return response({ backlinks: [] });
      if (url.endsWith('/versions')) return response({ versions: [{ id: 'revision-1', pad_type: 'document', snapshot_reason: 'manual', created_at: '2026-10-22T12:00:00Z' }] });
      if (url.endsWith('/restore')) { restored = true; return response({ success: true }); }
      if (init?.method === 'PUT') return response({ updated_at: '2026-10-24T00:03:00Z' });
      return response({ content: restored ? 'Restored document' : 'Current document', updated_at: restored ? '2026-10-24T00:02:00Z' : '2026-10-24T00:01:00Z' });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<DocumentPad padId="isolated-pad" onContentChange={onContentChange} />);
    await screen.findByDisplayValue('Current document');
    fireEvent.click(screen.getByRole('button', { name: 'editor.history' }));
    fireEvent.click(await screen.findByRole('button', { name: /Restaurer la version du/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la restauration' }));
    const editor = await screen.findByDisplayValue('Restored document');
    expect(onContentChange).toHaveBeenLastCalledWith('Restored document');
    fireEvent.change(editor, { target: { value: 'Restored document, edited' } });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/pad/isolated-pad/doc', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ content: 'Restored document, edited', format: 'markdown', expected_updated_at: '2026-10-24T00:02:00Z' }),
      }));
    }, { timeout: 2000 });
  });

  it('makes a blocked PDF popup an actionable, announced error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/backlinks') ? { backlinks: [] } : { content: 'Isolated export', updated_at: '2026-10-24T00:01:00Z' })));
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<DocumentPad padId="isolated-export" />);
    await screen.findByDisplayValue('Isolated export');
    fireEvent.click(screen.getByRole('button', { name: 'editor.exportPdf' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Autorise les fenêtres surgissantes pour Alcove');
  });

  it('locks editor interactions while a restore request is in progress', async () => {
    let finishRestore!: (value: Response) => void;
    const pendingRestore = new Promise<Response>(resolve => { finishRestore = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/backlinks')) return response({ backlinks: [] });
      if (url.endsWith('/versions')) return response({ versions: [{ id: 'revision-1', pad_type: 'document', snapshot_reason: 'manual', created_at: '2026-10-22T12:00:00Z' }] });
      if (url.endsWith('/restore')) return pendingRestore;
      return response({ content: 'Isolated document', updated_at: '2026-10-24T00:01:00Z' });
    }));
    render(<DocumentPad padId="isolated-pad" />);
    const editor = await screen.findByDisplayValue('Isolated document');
    fireEvent.click(screen.getByRole('button', { name: 'editor.history' }));
    fireEvent.click(await screen.findByRole('button', { name: /Restaurer la version du/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la restauration' }));
    expect(editor).toHaveAttribute('readonly');
    expect(editor.closest('.document-pad__body')).toHaveAttribute('inert');
    finishRestore(response({ success: true }));
    await waitFor(() => expect(editor).not.toHaveAttribute('readonly'));
  });

});
