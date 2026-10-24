import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LatexPad from './LatexPad';
import { writeStructuredPadDraft } from '../lib/structuredPadDraft';

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange, options }: {
    value: string;
    onChange: (value: string) => void;
    options: { ariaLabel: string; readOnly?: boolean };
  }) => (
    <textarea
      aria-label={options.ariaLabel}
      readOnly={options.readOnly}
      value={value}
      onChange={event => onChange(event.target.value)}
    />
  ),
}));

const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response;

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.useRealTimers();
});

describe('LatexPad persistence', () => {
  it('loads the source and saves edits to the versioned data endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ source: 'server source', updated_at: 'version-1' }))
      .mockResolvedValueOnce(response({ updated_at: 'version-2' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LatexPad padId="latex-1" />);

    const editor = await screen.findByRole('textbox', { name: 'Code source LaTeX' });
    await waitFor(() => expect(editor).toHaveValue('server source'));
    fireEvent.change(editor, { target: { value: 'updated source' } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/pad/latex-1/data',
      expect.objectContaining({ method: 'PUT' }),
    ), { timeout: 2000 });
    const saveCall = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/pad/latex-1/data' && init?.method === 'PUT');
    expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({
      data: { source: 'updated source' },
      expected_updated_at: 'version-1',
    });
    expect(await screen.findByText('Enregistré')).toBeInTheDocument();
    expect(localStorage.getItem('alcove:structured-pad-draft:latex-1')).toBeNull();
  });

  it('loads legacy LaTeX stored in the content field without replacing it with the template', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ content: 'legacy source', updated_at: 'version-1' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LatexPad padId="latex-legacy" />);

    expect(await screen.findByRole('textbox', { name: 'Code source LaTeX' })).toHaveValue('legacy source');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a local draft after failure and retries it on request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ source: 'server source', updated_at: 'version-1' }))
      .mockResolvedValueOnce(response({ detail: 'unavailable' }, 503))
      .mockResolvedValueOnce(response({ updated_at: 'version-2' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LatexPad padId="latex-1" />);

    const editor = await screen.findByRole('textbox', { name: 'Code source LaTeX' });
    await waitFor(() => expect(editor).toHaveValue('server source'));
    fireEvent.change(editor, { target: { value: 'keep this source' } });

    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 503');
    expect(JSON.parse(localStorage.getItem('alcove:structured-pad-draft:latex-1') || '{}').data)
      .toEqual({ source: 'keep this source' });

    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3), { timeout: 2000 });
    expect(await screen.findByText('Enregistré')).toBeInTheDocument();
    expect(localStorage.getItem('alcove:structured-pad-draft:latex-1')).toBeNull();
  });

  it('restores a local draft after reload when its server baseline still matches', async () => {
    writeStructuredPadDraft('latex-recovered', { source: 'recovered local source' }, 'version-1');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ source: 'server source', updated_at: 'version-1' }))
      .mockResolvedValueOnce(response({ updated_at: 'version-2' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LatexPad padId="latex-recovered" />);

    expect(await screen.findByText('Brouillon local récupéré.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Code source LaTeX' })).toHaveValue('recovered local source');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer maintenant' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/pad/latex-recovered/data',
      expect.objectContaining({ method: 'PUT' }),
    ), { timeout: 2000 });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      data: { source: 'recovered local source' },
      expected_updated_at: 'version-1',
    });
  });

  it('retries a save after a metadata-only version change', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ source: 'server source', updated_at: 'version-1' }))
      .mockResolvedValueOnce(response({}, 409))
      .mockResolvedValueOnce(response({ source: 'server source', updated_at: 'version-2' }))
      .mockResolvedValueOnce(response({ updated_at: 'version-3' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LatexPad padId="latex-renamed" />);

    const editor = await screen.findByRole('textbox', { name: 'Code source LaTeX' });
    await waitFor(() => expect(editor).toHaveValue('server source'));
    fireEvent.change(editor, { target: { value: 'new content' } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4), { timeout: 2000 });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/pad/latex-renamed',
      '/api/pad/latex-renamed/data',
      '/api/pad/latex-renamed',
      '/api/pad/latex-renamed/data',
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({
      data: { source: 'new content' },
      expected_updated_at: 'version-2',
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('protects the server revision before restoring a stale local draft', async () => {
    writeStructuredPadDraft('latex-stale', { source: 'local draft' }, 'version-1');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/versions/snapshot')) return response({ id: 'snapshot-1' });
      if (url.endsWith('/data') && init?.method === 'PUT') return response({ updated_at: 'version-3' });
      return response({ source: 'new server source', updated_at: 'version-2' });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<LatexPad padId="latex-stale" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('a changé depuis la création du brouillon');
    expect(screen.getByRole('textbox', { name: 'Code source LaTeX' })).toHaveValue('new server source');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Garder le brouillon local' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/pad/latex-stale/versions/snapshot',
      { method: 'POST' },
    ));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/pad/latex-stale/data',
      expect.objectContaining({ method: 'PUT' }),
    ), { timeout: 2000 });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/pad/latex-stale',
      '/api/pad/latex-stale',
      '/api/pad/latex-stale/versions/snapshot',
      '/api/pad/latex-stale/data',
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({
      data: { source: 'local draft' },
      expected_updated_at: 'version-2',
    });
  });
});
