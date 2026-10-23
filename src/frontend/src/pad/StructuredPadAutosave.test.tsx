import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeStructuredPadDraft } from '../lib/structuredPadDraft';
import DatabasePad from './DatabasePad';
import KanbanPad from './KanbanPad';
import GanttPad from './GanttPad';

const firstPad = {
  columns: [{ id: 'name', name: 'Name' }],
  rows: [],
  updated_at: 'version-a',
};

const secondPad = {
  columns: [{ id: 'name', name: 'Name' }],
  rows: [{ id: 'row-b', cells: { name: 'Second pad row' } }],
  updated_at: 'version-b',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('DatabasePad autosave', () => {
  it('does not show an old pad save conflict after switching to another database pad', async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal('fetch', fetchMock);
    const onDataChange = vi.fn();

    const { rerender } = render(
      <DatabasePad padId="pad-a" data={firstPad} onDataChange={onDataChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Nouvelle ligne' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/pad/pad-a/data',
      expect.objectContaining({ method: 'PUT' }),
    ), { timeout: 1500 });

    rerender(<DatabasePad padId="pad-b" data={secondPad} onDataChange={onDataChange} />);
    expect(await screen.findByDisplayValue('Second pad row')).toBeInTheDocument();

    await act(async () => {
      pending.resolve({ ok: false, status: 409 } as Response);
      await pending.promise;
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Second pad row')).toBeInTheDocument();
  });

  it('keeps the new pad recovery draft visible when an old save succeeds late', async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal('fetch', fetchMock);
    const onDataChange = vi.fn();
    const recoveredData = {
      columns: [{ id: 'name', name: 'Name' }],
      rows: [{ id: 'recovered', cells: { name: 'Unsaved second-pad row' } }],
    };

    const { rerender } = render(
      <DatabasePad padId="pad-a" data={firstPad} onDataChange={onDataChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Nouvelle ligne' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 1500 });

    writeStructuredPadDraft('pad-b', recoveredData, 'version-b');
    rerender(<DatabasePad padId="pad-b" data={secondPad} onDataChange={onDataChange} />);
    expect(await screen.findByText(/Brouillon local récupéré/)).toBeInTheDocument();

    await act(async () => {
      pending.resolve({ ok: true, status: 200, json: async () => ({ updated_at: 'version-a2' }) } as Response);
      await pending.promise;
    });

    expect(screen.getByText(/Brouillon local récupéré/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Unsaved second-pad row')).toBeInTheDocument();
  });

  it('does not show an old pad network failure on the newly selected pad', async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal('fetch', fetchMock);
    const onDataChange = vi.fn();

    const { rerender } = render(
      <DatabasePad padId="pad-a" data={firstPad} onDataChange={onDataChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Nouvelle ligne' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 1500 });
    rerender(<DatabasePad padId="pad-b" data={secondPad} onDataChange={onDataChange} />);

    await act(async () => {
      pending.reject(new Error('offline'));
      await pending.promise.catch(() => undefined);
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('KanbanPad mobile card movement', () => {
  it('moves a card from its details without drag and saves the destination column', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true, status: 200, json: async () => ({ updated_at: 'version-b' }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    render(
      <KanbanPad
        padId="kanban-mobile"
        data={{
          columns: [
            { id: 'todo', title: 'À faire', cards: [{ id: 'card-1', title: 'Préparer la démo' }] },
            { id: 'done', title: 'Terminé', cards: [] },
          ],
          updated_at: 'version-a',
        }}
        onDataChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Préparer la démo'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Colonne' }), { target: { value: 'done' } });

    expect(screen.queryByRole('combobox', { name: 'Colonne' })).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/pad/kanban-mobile/data',
      expect.objectContaining({ method: 'PUT' }),
    ), { timeout: 2000 });
    const saved = JSON.parse(fetchMock.mock.calls[0][0] && (fetchMock.mock.calls[0][1]?.body as string)).data;
    expect(saved.columns[0].cards).toHaveLength(0);
    expect(saved.columns[1].cards).toEqual([{ id: 'card-1', title: 'Préparer la démo' }]);
  });
});

describe.each([
  {
    name: 'KanbanPad',
    url: '/api/pad/pad-a/data',
    first: { columns: [{ id: 'todo', title: 'Todo', cards: [] }], fieldSchema: [] },
    second: { columns: [{ id: 'doing', title: 'Second pad', cards: [] }], fieldSchema: [] },
    Component: KanbanPad,
    trigger: 'Ajouter',
  },
  {
    name: 'GanttPad',
    url: '/api/pad/pad-a/data',
    first: { tasks: [], fieldSchema: [] },
    second: { tasks: [], fieldSchema: [] },
    Component: GanttPad,
    trigger: 'Tâche',
  },
])('$name autosave', ({ url, first, second, Component, trigger }) => {
  it('ignores a stale save conflict after switching to another pad', async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal('fetch', fetchMock);
    const onDataChange = vi.fn();
    const Pad = Component as React.ComponentType<{ padId: string; data: any; onDataChange: (data: any) => void }>;

    const { rerender } = render(<Pad padId="pad-a" data={first} onDataChange={onDataChange} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${trigger}$`) }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'PUT' })), { timeout: 2000 });

    rerender(<Pad padId="pad-b" data={second} onDataChange={onDataChange} />);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    await act(async () => {
      pending.resolve({ ok: false, status: 409 } as Response);
      await pending.promise;
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
