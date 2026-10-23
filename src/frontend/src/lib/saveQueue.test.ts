import { describe, expect, it } from 'vitest';
import { enqueueSerializedSave } from './saveQueue';

describe('serialized pad saves', () => {
  it('runs saves in order and continues after a failed save', async () => {
    const queue = { current: Promise.resolve() };
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = enqueueSerializedSave(queue, async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
      throw new Error('temporary network failure');
    });
    const second = enqueueSerializedSave(queue, async () => { order.push('second'); });

    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await expect(first).rejects.toThrow('temporary network failure');
    await second;
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });
});
