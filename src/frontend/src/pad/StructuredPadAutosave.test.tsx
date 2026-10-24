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
  it('retries an unsaved database edit after network reconnection', async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return { ok: true, status: 200, json: async () => ({ updated_at: 'version-b' }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<DatabasePad padId="offline-database" data={firstPad} onDataChange={vi.fn()} />);

    act(() => window.dispatchEvent(new Event('offline')));
    fireEvent.click(screen.getByRole('button', { name: 'Nouvelle ligne' }));
    await waitFor(() => expect(attempts).toBe(1), { timeout: 2000 });
    act(() => window.dispatchEvent(new Event('online')));

    await waitFor(() => expect(attempts).toBe(2), { timeout: 3000 });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

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
  { name: 'database', Component: DatabasePad, data: firstPad, trigger: 'Nouvelle ligne' },
  { name: 'kanban', Component: KanbanPad, data: { columns: [{ id: 'todo', title: 'Todo', cards: [] }], fieldSchema: [], updated_at: 'version-a' }, trigger: 'Ajouter' },
  { name: 'gantt', Component: GanttPad, data: { tasks: [], fieldSchema: [], updated_at: 'version-a' }, trigger: 'Tâche' },
])('$name metadata changes', ({ Component, data, trigger }) => {
  it('saves the edit after a metadata-only rename', async () => {
    const { updated_at: _version, ...serverData } = data;
    let writes = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/pad/metadata-pad' && !init) {
        return { ok: true, status: 200, json: async () => ({ updated_at: 'version-b', data: serverData }) } as Response;
      }
      if (url === '/api/pad/metadata-pad/data' && init?.method === 'PUT') {
        writes += 1;
        return writes === 1
          ? { ok: false, status: 409 } as Response
          : { ok: true, status: 200, json: async () => ({ updated_at: 'version-c' }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const Pad = Component as React.ComponentType<{ padId: string; data: any; onDataChange: (data: any) => void }>;
    render(<Pad padId="metadata-pad" data={data} onDataChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${trigger}$`) }));
    await waitFor(() => expect(writes).toBe(2), { timeout: 2000 });
    const attempts = fetchMock.mock.calls.filter(([url, init]) => url === '/api/pad/metadata-pad/data' && init?.method === 'PUT');
    expect(attempts.map(([, init]) => JSON.parse(String(init?.body)).expected_updated_at)).toEqual(['version-a', 'version-b']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

  it('snapshots the server version before a user-approved local draft overwrite', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ updated_at: 'server-v2' }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'snapshot-1' }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ updated_at: 'server-v3' }) } as Response);
    vi.stubGlobal('fetch', fetchMock);
    writeStructuredPadDraft('pad-conflict', first, 'old-server-version');
    const Pad = Component as React.ComponentType<{ padId: string; data: any; onDataChange: (data: any) => void }>;
    render(<Pad padId="pad-conflict" data={{ ...first, updated_at: 'server-v2' }} onDataChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Écraser la version serveur avec ce brouillon' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3), { timeout: 2000 });
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
      '/api/pad/pad-conflict',
      '/api/pad/pad-conflict/versions/snapshot',
      url.replace('pad-a', 'pad-conflict'),
    ]);
    expect(JSON.parse(fetchMock.mock.calls[2][1]?.body as string).expected_updated_at).toBe('server-v2');
  });
});
