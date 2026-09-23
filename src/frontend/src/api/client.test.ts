import { describe, expect, it, vi } from 'vitest';
import { apiV1 } from './client';

describe('versioned API client', () => {
  it('uses the v1 route and normalizes structured API errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ detail: { code: 'forbidden', message: 'Not allowed' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(apiV1.getPad('pad/one')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      message: 'Not allowed',
    });
    expect(fetch).toHaveBeenCalledWith('/api/v1/pads/pad%2Fone', expect.objectContaining({
      credentials: 'include',
      headers: expect.objectContaining({ Accept: 'application/json' }),
    }));
  });
});
