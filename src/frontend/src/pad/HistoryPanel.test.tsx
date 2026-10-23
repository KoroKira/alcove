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

  it('blocks restore while the current document has an unsaved local state', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, { versions: [version] }));
    vi.stubGlobal('fetch', fetchMock);

    render(<HistoryPanel
      padId="pad-1"
      onClose={vi.fn()}
      onRestore={vi.fn()}
      canRestore={false}
      restoreBlockedReason="Attends la fin de la sauvegarde."
    />);

    expect(await screen.findByRole('status')).toHaveTextContent('Attends la fin de la sauvegarde.');
    const restoreButton = await screen.findByTitle('Restaurer cette version');
    expect(restoreButton).toBeDisabled();
    fireEvent.click(restoreButton);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/pad/pad-1/versions');
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

  it('keeps the history open and reports when the restored document cannot be reloaded', async () => {
    const onClose = vi.fn();
    const onRestore = vi.fn().mockRejectedValue(new Error('Restauration effectuée, mais rechargement impossible (503).'));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(200, { versions: [version] }))
      .mockResolvedValueOnce(response(200, { ok: true })));

    render(<HistoryPanel padId="pad-1" onClose={onClose} onRestore={onRestore} />);
    fireEvent.click(await screen.findByTitle('Restaurer cette version'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Restauration effectuée, mais rechargement impossible (503).');
    expect(onClose).not.toHaveBeenCalled();
    expect(onRestore).toHaveBeenCalledOnce();
  });

  it('disables other versions while one restore request is in progress', async () => {
    const versionTwo = { ...version, id: 'v2', created_at: '2026-10-21T12:00:00Z' };
    let finishRestore!: (value: Response) => void;
    const pendingRestore = new Promise<Response>(resolve => { finishRestore = resolve; });
    const onRestore = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { versions: [version, versionTwo] }))
      .mockReturnValueOnce(pendingRestore);
    vi.stubGlobal('fetch', fetchMock);

    render(<HistoryPanel padId="pad-1" onClose={vi.fn()} onRestore={onRestore} />);
    const restoreButtons = await screen.findAllByTitle('Restaurer cette version');
    fireEvent.click(restoreButtons[0]);

    await waitFor(() => {
      expect(restoreButtons[0]).toBeDisabled();
      expect(restoreButtons[1]).toBeDisabled();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    finishRestore(response(200, { ok: true }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledOnce());
  });
});
