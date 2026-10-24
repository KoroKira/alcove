import { describe, expect, it, vi } from 'vitest';
import { retryStructuredSaveAfterMetadataChange } from './metadataConflict';

const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response;

describe('structured pad metadata conflicts', () => {
  it('retries against the new timestamp when a rename left the body unchanged', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ updated_at: 'version-2', data: { columns: [], rows: [] } }))
      .mockResolvedValueOnce(response({ updated_at: 'version-3' }));
    const result = await retryStructuredSaveAfterMetadataChange(
      'pad-1', { columns: [], rows: [], updated_at: 'version-1' },
      { columns: [{ id: 'col-1', name: 'Task' }], rows: [] }, request,
    );
    expect(result?.ok).toBe(true);
    expect(request).toHaveBeenLastCalledWith('/api/pad/pad-1/data', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ data: { columns: [{ id: 'col-1', name: 'Task' }], rows: [] }, expected_updated_at: 'version-2' }),
    }));
  });

  it('does not overwrite a different body from another device', async () => {
    const request = vi.fn().mockResolvedValue(response({ updated_at: 'version-2', data: { columns: [{ id: 'other' }], rows: [] } }));
    const result = await retryStructuredSaveAfterMetadataChange(
      'pad-1', { columns: [], rows: [] }, { columns: [{ id: 'mine' }], rows: [] }, request,
    );
    expect(result).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('recognizes the legacy top-level LaTeX response shape after a rename', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ source: 'saved source', updated_at: 'version-2' }))
      .mockResolvedValueOnce(response({ updated_at: 'version-3' }));
    const result = await retryStructuredSaveAfterMetadataChange(
      'latex-pad', { source: 'saved source' }, { source: 'new source' }, request,
    );

    expect(result?.ok).toBe(true);
    expect(request).toHaveBeenLastCalledWith('/api/pad/latex-pad/data', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ data: { source: 'new source' }, expected_updated_at: 'version-2' }),
    }));
  });
});
