/**
 * Review activity log + FSRS due-count helpers for the Review Dashboard
 * (chantier #20, Recall's `/spaced-repetition` UI). The FSRS-5 engine and
 * per-card scheduling already exist (lib/fsrs.ts, FlashcardStudio.tsx) —
 * this module only adds the persistent bits that engine never needed:
 * a day-by-day activity log (for the streak tracker + accuracy stats) and
 * a reader over the existing FSRS card-state map (for due-today/this-week/
 * next-week counts). No backend involved — same localStorage tier as the
 * FSRS state itself.
 */
import { FSRSCard, today } from './fsrs';

// Mirrors FlashcardStudio.tsx's private FSRS_KEY — duplicated as a literal
// (not imported) to avoid coupling a UI component's internals to this lib.
const FSRS_KEY = 'alcove-quiz-fsrs';
const ACTIVITY_KEY = 'alcove-review-activity';

export interface ReviewEvent {
  /** Epoch day index (fsrs.today()) — not a calendar string, so streak/
   * range math never has to worry about timezones or DST. */
  day: number;
  correct: boolean;
}

function loadEvents(): ReviewEvent[] {
  try {
    const raw = localStorage.getItem(ACTIVITY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveEvents(events: ReviewEvent[]): void {
  // Cap history to ~1 year of events so this never grows unbounded — the
  // dashboard only ever looks at the last 7-30 days anyway.
  const trimmed = events.length > 5000 ? events.slice(events.length - 5000) : events;
  localStorage.setItem(ACTIVITY_KEY, JSON.stringify(trimmed));
}

/** Call once per FSRS review answer (FlashcardStudio's answer()). */
export function logReview(correct: boolean): void {
  const events = loadEvents();
  events.push({ day: today(), correct });
  saveEvents(events);
}

function loadFSRSCards(): FSRSCard[] {
  try {
    const raw = localStorage.getItem(FSRS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    return Object.values(map) as FSRSCard[];
  } catch { return []; }
}

export interface DueCounts {
  today: number;
  thisWeek: number;   // due within the next 7 days, excluding today
  nextWeek: number;   // due 8-14 days out
}

export function getDueCounts(): DueCounts {
  const cards = loadFSRSCards();
  const t = today();
  let due = 0, week = 0, next = 0;
  for (const c of cards) {
    if (c.due <= t) due++;
    else if (c.due <= t + 7) week++;
    else if (c.due <= t + 14) next++;
  }
  return { today: due, thisWeek: week, nextWeek: next };
}

export interface DayActivity {
  day: number;
  answered: number;
  correct: number;
}

/** Last N days of activity, oldest first, always N entries (zero-filled for
 * days with no reviews) so the chart/streak grid has a stable width. */
export function getRecentActivity(days = 7): DayActivity[] {
  const events = loadEvents();
  const t = today();
  const byDay = new Map<number, DayActivity>();
  for (let i = days - 1; i >= 0; i--) {
    const d = t - i;
    byDay.set(d, { day: d, answered: 0, correct: 0 });
  }
  for (const e of events) {
    const bucket = byDay.get(e.day);
    if (!bucket) continue; // outside the requested window
    bucket.answered++;
    if (e.correct) bucket.correct++;
  }
  return Array.from(byDay.values());
}

export function getTotals(): { answered: number; correct: number } {
  const events = loadEvents();
  let correct = 0;
  for (const e of events) if (e.correct) correct++;
  return { answered: events.length, correct };
}

/** Consecutive days with at least one review, counting back from today.
 * A day with zero reviews breaks the streak — matches the "did you show up
 * today" framing Recall's own streak grid uses. */
export function getStreak(): number {
  const events = loadEvents();
  const daysWithActivity = new Set(events.map(e => e.day));
  const t = today();
  let streak = 0;
  let d = t;
  // Today not yet reviewed is fine — streak counts backward from the most
  // recent active day, so "yesterday onward" still shows a live streak.
  if (!daysWithActivity.has(d)) d -= 1;
  while (daysWithActivity.has(d)) { streak++; d -= 1; }
  return streak;
}
