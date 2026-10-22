import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiV1, type ApiSearchResult } from '../api/client';
import SearchDialog from './SearchDialog';

vi.mock('../api/client', () => ({ apiV1: { search: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const result = (padId: string, padName: string): ApiSearchResult => ({
  pad_id: padId,
  pad_name: padName,
  name_match: true,
  matches: [],
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('SearchDialog', () => {
  it('shows a useful error instead of a false no-results state', async () => {
    vi.mocked(apiV1.search).mockRejectedValueOnce(new Error('offline'));
    render(<SearchDialog onClose={vi.fn()} onSelectPad={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'notes' } });

    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Recherche indisponible');
    expect(screen.queryByText('search.noResults')).not.toBeInTheDocument();
  });

  it('ignores an older response when a newer query has completed', async () => {
    const first = deferred<ApiSearchResult[]>();
    const second = deferred<ApiSearchResult[]>();
    vi.mocked(apiV1.search)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<SearchDialog onClose={vi.fn()} onSelectPad={vi.fn()} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first query' } });
    await act(async () => { vi.advanceTimersByTime(250); });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'second query' } });
    await act(async () => { vi.advanceTimersByTime(250); });

    await act(async () => { second.resolve([result('new', 'New result')]); await second.promise; });
    expect(screen.getByRole('button', { name: /New result/ })).toBeInTheDocument();

    await act(async () => { first.resolve([result('old', 'Stale result')]); await first.promise; });
    expect(screen.queryByRole('button', { name: /Stale result/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New result/ })).toBeInTheDocument();
  });
});
