import { describe, it, expect } from 'vitest';
import {
  newCard,
  review,
  today,
  migrateFromSM2,
  Rating,
  FSRSCard,
} from './fsrs';

// Deterministic day-index for tests — avoid depending on wall-clock.
const NOW = 20_000;

function firstReview(rating: Rating): FSRSCard {
  return review(newCard(), rating, NOW);
}

describe('fsrs — invariants', () => {
  it('newCard is due today with zero history', () => {
    const c = newCard();
    expect(c.state).toBe('new');
    expect(c.reps).toBe(0);
    expect(c.lapses).toBe(0);
    expect(c.stability).toBe(0);
    expect(c.difficulty).toBe(0);
    expect(c.due).toBe(today());
  });

  it.each<[Rating]>([[1], [2], [3], [4]])(
    'first review with rating %i produces valid state',
    (rating) => {
      const c = firstReview(rating);
      expect(c.reps).toBe(1);
      expect(c.difficulty).toBeGreaterThanOrEqual(1);
      expect(c.difficulty).toBeLessThanOrEqual(10);
      expect(c.stability).toBeGreaterThan(0);
      expect(c.due).toBeGreaterThanOrEqual(NOW + 1);
      expect(c.lastReview).toBe(NOW);
    },
  );

  it('lapse counter only increments on Again', () => {
    expect(firstReview(1).lapses).toBe(1);
    expect(firstReview(2).lapses).toBe(0);
    expect(firstReview(3).lapses).toBe(0);
    expect(firstReview(4).lapses).toBe(0);
  });
});

describe('fsrs — first-review ordering', () => {
  // Sanity: harder ratings shouldn't produce longer intervals than easier ones.
  it('interval is monotone increasing with rating on first review', () => {
    const dueAgain = firstReview(1).due;
    const dueHard = firstReview(2).due;
    const dueGood = firstReview(3).due;
    const dueEasy = firstReview(4).due;
    expect(dueHard).toBeGreaterThanOrEqual(dueAgain);
    expect(dueGood).toBeGreaterThanOrEqual(dueHard);
    expect(dueEasy).toBeGreaterThanOrEqual(dueGood);
  });

  it('Easy is easier than Hard on the difficulty axis', () => {
    expect(firstReview(4).difficulty).toBeLessThan(firstReview(2).difficulty);
  });
});

describe('fsrs — subsequent reviews', () => {
  it('successful review after some elapsed time grows stability', () => {
    const first = firstReview(3);
    const second = review(first, 3, first.lastReview + first.stability);
    expect(second.stability).toBeGreaterThan(first.stability);
    expect(second.state).toBe('review');
    expect(second.reps).toBe(2);
  });

  it('Again after a run of Goods marks the card as relearning and bumps lapses', () => {
    let c = firstReview(3);
    c = review(c, 3, c.lastReview + 5);
    c = review(c, 3, c.lastReview + 10);
    const beforeLapses = c.lapses;
    const beforeStability = c.stability;

    const failed = review(c, 1, c.lastReview + 10);
    expect(failed.state).toBe('relearning');
    expect(failed.lapses).toBe(beforeLapses + 1);
    // Stability must not grow on failure.
    expect(failed.stability).toBeLessThanOrEqual(beforeStability);
    expect(failed.stability).toBeGreaterThan(0);
  });

  it('difficulty stays clamped to [1, 10] across many reviews', () => {
    let c = firstReview(1);
    for (let i = 0; i < 50; i++) {
      c = review(c, 1, c.lastReview + 1);
      expect(c.difficulty).toBeGreaterThanOrEqual(1);
      expect(c.difficulty).toBeLessThanOrEqual(10);
    }
  });
});

describe('fsrs — SM-2 migration', () => {
  it('brand-new SM-2 record → newCard', () => {
    const m = migrateFromSM2({ n: 0, ef: 2.5, interval: 1, due: 100 });
    expect(m.state).toBe('new');
    expect(m.reps).toBe(0);
  });

  it('reviewed SM-2 record preserves review count and due date', () => {
    const m = migrateFromSM2({ n: 4, ef: 2.6, interval: 15, due: 500 });
    expect(m.reps).toBe(4);
    expect(m.due).toBe(500);
    expect(m.state).toBe('review');
    expect(m.stability).toBeGreaterThanOrEqual(15);
    expect(m.difficulty).toBeGreaterThanOrEqual(1);
    expect(m.difficulty).toBeLessThanOrEqual(10);
    // Higher EF (easier card) should map to lower difficulty.
    const harder = migrateFromSM2({ n: 4, ef: 1.5, interval: 15, due: 500 });
    expect(harder.difficulty).toBeGreaterThan(m.difficulty);
  });
});
