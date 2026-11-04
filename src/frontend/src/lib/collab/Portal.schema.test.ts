import { describe, expect, it } from 'vitest';
import { WebSocketMessageSchema } from './Portal';

describe('WebSocketMessageSchema (zod 4)', () => {
  it('accepts a server message with a UTC timestamp', () => {
    const parsed = WebSocketMessageSchema.safeParse({
      type: 'scene_update', pad_id: 'p1', timestamp: '2026-01-02T03:04:05Z', data: { elements: [] },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an offset timestamp and a null pad id', () => {
    expect(WebSocketMessageSchema.safeParse({ type: 'connected', pad_id: null, timestamp: '2026-01-02T03:04:05+02:00' }).success).toBe(true);
  });

  it('rejects a malformed timestamp', () => {
    expect(WebSocketMessageSchema.safeParse({ type: 'x', pad_id: null, timestamp: 'yesterday' }).success).toBe(false);
  });
});
