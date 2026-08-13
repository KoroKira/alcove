// Minimal FSRS-5 (Free Spaced Repetition Scheduler) implementation.
//
// Kept self-contained (~150 LOC, no deps) rather than pulling `ts-fsrs`: the
// core algorithm is well-defined and stable, and the payoff of avoiding a new
// npm dep on a personal-scale app is worth the ~150 lines.
//
// Reference: https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm
//
// Grading scale (matches Anki / FSRS convention):
//   1 = Again  (forgot)
//   2 = Hard   (recalled with difficulty)
//   3 = Good   (recalled correctly)
//   4 = Easy   (recalled effortlessly)
//
// Time unit throughout: **days as integers** (day-index = floor(ts / 86400000)).
// Callers use `today()` to get the current day-index.

export type Rating = 1 | 2 | 3 | 4;
export type State = 'new' | 'learning' | 'review' | 'relearning';

export interface FSRSCard {
  due: number;         // day-index when the card is next due
  stability: number;   // memory strength in days
  difficulty: number;  // 1-10 (higher = harder)
  reps: number;        // total reviews
  lapses: number;      // times rated Again after learning
  state: State;
  lastReview: number;  // day-index of last review (0 = never)
}

// Default FSRS-5 weights (trained on a large public dataset). These can be
// personalized per-user later by fitting on review history, but the defaults
// already beat SM-2 comfortably.
const W = [
  0.4197, 1.1869, 3.0412, 15.2441, 7.1434, 0.6477, 1.0007, 0.0674,
  1.6597, 0.1712, 1.1178, 2.0225, 0.0904, 0.3025, 2.1214, 0.2498,
  2.9466, 0.4891, 0.6468,
];

const REQUEST_RETENTION = 0.9;  // target 90% recall probability
const FACTOR = 19 / 81;
const DECAY = -0.5;
const MIN_STABILITY = 0.1;

export function today(): number {
  return Math.floor(Date.now() / 86_400_000);
}

export function newCard(): FSRSCard {
  return {
    due: today(),
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    state: 'new',
    lastReview: 0,
  };
}

// ── Core formulas ───────────────────────────────────────────────────────────

function initStability(rating: Rating): number {
  return Math.max(W[rating - 1], MIN_STABILITY);
}

function initDifficulty(rating: Rating): number {
  return clamp(W[4] - Math.exp(W[5] * (rating - 1)) + 1, 1, 10);
}

function nextInterval(stability: number): number {
  const days = (stability / FACTOR) * (Math.pow(REQUEST_RETENTION, 1 / DECAY) - 1);
  return Math.max(1, Math.round(days));
}

function nextDifficulty(difficulty: number, rating: Rating): number {
  const linear = difficulty - W[6] * (rating - 3);
  // Mean-reverting toward the "easy" difficulty to prevent runaway values.
  const meanReversionTarget = W[4] - Math.exp(W[5] * (4 - 1)) + 1;
  const mixed = W[7] * meanReversionTarget + (1 - W[7]) * linear;
  return clamp(mixed, 1, 10);
}

function retrievability(elapsedDays: number, stability: number): number {
  if (stability <= 0) return 0;
  return Math.pow(1 + FACTOR * (elapsedDays / stability), DECAY);
}

function nextStabilityOnSuccess(
  difficulty: number, stability: number, retrievability: number, rating: Rating,
): number {
  const hardPenalty = rating === 2 ? W[15] : 1;
  const easyBonus = rating === 4 ? W[16] : 1;
  const growth = Math.exp(W[8])
    * (11 - difficulty)
    * Math.pow(stability, -W[9])
    * (Math.exp((1 - retrievability) * W[10]) - 1)
    * hardPenalty
    * easyBonus;
  return stability * (1 + growth);
}

function nextStabilityOnFailure(
  difficulty: number, stability: number, retrievability: number,
): number {
  const forgotStability =
    W[11]
    * Math.pow(difficulty, -W[12])
    * (Math.pow(stability + 1, W[13]) - 1)
    * Math.exp((1 - retrievability) * W[14]);
  // Never let stability grow on a failure.
  return Math.max(MIN_STABILITY, Math.min(forgotStability, stability));
}

// ── Public review function ──────────────────────────────────────────────────

export function review(card: FSRSCard, rating: Rating, now: number = today()): FSRSCard {
  // First review — no elapsed history, seed from the rating.
  if (card.state === 'new' || card.reps === 0) {
    const stability = initStability(rating);
    const difficulty = initDifficulty(rating);
    return {
      due: now + nextInterval(stability),
      stability,
      difficulty,
      reps: 1,
      lapses: rating === 1 ? 1 : 0,
      state: rating === 1 ? 'learning' : 'review',
      lastReview: now,
    };
  }

  const elapsed = Math.max(0, now - card.lastReview);
  const r = retrievability(elapsed, card.stability);
  const newDifficulty = nextDifficulty(card.difficulty, rating);
  const newStability = rating === 1
    ? nextStabilityOnFailure(newDifficulty, card.stability, r)
    : nextStabilityOnSuccess(newDifficulty, card.stability, r, rating);

  return {
    due: now + nextInterval(newStability),
    stability: newStability,
    difficulty: newDifficulty,
    reps: card.reps + 1,
    lapses: card.lapses + (rating === 1 ? 1 : 0),
    state: rating === 1 ? 'relearning' : 'review',
    lastReview: now,
  };
}

// ── Utilities ───────────────────────────────────────────────────────────────

function clamp(x: number, min: number, max: number): number {
  return Math.min(Math.max(x, min), max);
}

/** Migration helper: turn an old SM-2 record into a plausible FSRS state. */
export function migrateFromSM2(
  sm2: { n: number; ef: number; interval: number; due: number },
): FSRSCard {
  if (sm2.n === 0) return newCard();
  // Approximate stability from the SM-2 interval (interval ≈ stability at
  // 90% retention with the FSRS defaults). Difficulty derived from ease
  // factor: EF 1.3 (very hard) → D≈9, EF 2.5 (default) → D≈5, EF 3.5 → D≈2.
  const stability = Math.max(MIN_STABILITY, sm2.interval);
  const difficulty = clamp(11 - (sm2.ef - 1.3) * 3.6, 1, 10);
  return {
    due: sm2.due,
    stability,
    difficulty,
    reps: sm2.n,
    lapses: 0,
    state: 'review',
    lastReview: sm2.due - sm2.interval,
  };
}
