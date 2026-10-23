import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TrashDialog from './TrashDialog';

const i18nMock = vi.hoisted(() => ({
  t: (key: string, values?: Record<string, string>) => key === 'sidebar.trashDeletedAt'
    ? `${key}:${values?.date ?? ''}`
    : key,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: i18nMock.t, i18n: { language: 'fr' } }),
}));

const trashedPad = {
  id: 'test-pad-1',
  display_name: 'Pad de test isolé',
  pad_type: 'document',
  deleted_at: '2026-10-23T09:00:00Z',
};

function renderDialog(onClose = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onClose,
    ...render(
      <QueryClientProvider client={queryClient}>
        <TrashDialog onClose={onClose} />
      </QueryClientProvider>,
    ),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('TrashDialog', () => {
  it('lists an isolated trashed pad and removes it after successful restore', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pads: [trashedPad] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);
    renderDialog();

    expect(await screen.findByText('Pad de test isolé')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.trashRestore Pad de test isolé' }));

    await waitFor(() => expect(screen.queryByText('Pad de test isolé')).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/api/pad/test-pad-1/restore', { method: 'POST' });
    expect(screen.getByText('sidebar.trashEmpty')).toBeInTheDocument();
  });

  it('shows a retry action when loading the trash fails', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pads: [trashedPad] }) });
    vi.stubGlobal('fetch', fetchMock);
    renderDialog();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('sidebar.trashLoadError');
    fireEvent.click(alert.querySelector('button')!);
    expect(await screen.findByText('Pad de test isolé')).toBeInTheDocument();
  });

  it('keeps a pad visible and reports an error when restore fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pads: [trashedPad] }) })
      .mockResolvedValueOnce({ ok: false });
    vi.stubGlobal('fetch', fetchMock);
    renderDialog();

    fireEvent.click(await screen.findByRole('button', { name: 'sidebar.trashRestore Pad de test isolé' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('sidebar.trashRestoreError');
    expect(screen.getByText('Pad de test isolé')).toBeInTheDocument();
  });
});
