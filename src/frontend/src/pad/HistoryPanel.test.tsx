import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HistoryPanel from './HistoryPanel';

const version = { id: 'v1', pad_type: 'document', snapshot_reason: 'manual', created_at: '2026-10-22T12:00:00Z' };

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('HistoryPanel', () => {
  it('shows a clear error instead of reporting a failed history request as empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(503, { detail: 'Unavailable' })));

    render(<HistoryPanel padId="pad-1" onClose={vi.fn()} onRestore={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de charger l’historique (503).');
    expect(screen.queryByText('Aucune version sauvegardée')).not.toBeInTheDocument();
  });

  it('reports a failed preview request without displaying an empty preview', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(200, { versions: [version] }))
      .mockResolvedValueOnce(response(404, { detail: 'Missing' })));

    render(<HistoryPanel padId="pad-1" onClose={vi.fn()} onRestore={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /22\/10\/2026/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de charger cette version (404).');
    expect(screen.queryByText('Aperçu')).not.toBeInTheDocument();
  });

  it('does not report restore success when the server rejects it', async () => {
    const onRestore = vi.fn();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(200, { versions: [version] }))
      .mockResolvedValueOnce(response(403, { detail: 'Forbidden' })));

    render(<HistoryPanel padId="pad-1" onClose={vi.fn()} onRestore={onRestore} />);
    fireEvent.click(await screen.findByTitle('Restaurer cette version'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de restaurer cette version (403).');
    await waitFor(() => expect(onRestore).not.toHaveBeenCalled());
  });

  it('refreshes the document after a successful restore', async () => {
    const onRestore = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { versions: [version] }))
      .mockResolvedValueOnce(response(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    render(<HistoryPanel padId="pad-1" onClose={vi.fn()} onRestore={onRestore} />);
    fireEvent.click(await screen.findByTitle('Restaurer cette version'));

    await waitFor(() => expect(onRestore).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenLastCalledWith('/api/pad/pad-1/versions/v1/restore', { method: 'POST' });
  });
});
