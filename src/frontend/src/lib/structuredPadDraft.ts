/** Best-effort local recovery for structured pad edits that have not reached the server. */
const keyFor = (padId: string) => `alcove:structured-pad-draft:${padId}`;

export interface StructuredPadDraft<T> {
  data: T;
  expectedUpdatedAt: string | null;
  baselineKnown: boolean;
}

export const UNKNOWN_STRUCTURED_DRAFT_BASELINE = '1970-01-01T00:00:00+00:00';

export function isStructuredPadDraftStale(
  draft: StructuredPadDraft<unknown>,
  serverUpdatedAt: string | null,
): boolean {
  return !draft.baselineKnown || !draft.expectedUpdatedAt || draft.expectedUpdatedAt !== serverUpdatedAt;
}

export function readStructuredPadDraftRecord<T>(padId: string): StructuredPadDraft<T> | null {
  try {
    const raw = localStorage.getItem(keyFor(padId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data?: T; expectedUpdatedAt?: string | null };
    if (!Object.prototype.hasOwnProperty.call(parsed, 'data')) return null;
    const baselineKnown = Object.prototype.hasOwnProperty.call(parsed, 'expectedUpdatedAt');
    return {
      data: parsed.data as T,
      expectedUpdatedAt: baselineKnown ? parsed.expectedUpdatedAt ?? null : null,
      baselineKnown,
    };
  } catch {
    return null;
  }
}

export function readStructuredPadDraft<T>(padId: string, fallback: T): T {
  return readStructuredPadDraftRecord<T>(padId)?.data ?? fallback;
}

export function writeStructuredPadDraft<T>(
  padId: string,
  data: T,
  expectedUpdatedAt: string | null,
  baselineKnown = true,
): boolean {
  try {
    localStorage.setItem(keyFor(padId), JSON.stringify({
      data,
      expectedUpdatedAt: baselineKnown ? expectedUpdatedAt : undefined,
      savedAt: new Date().toISOString(),
    }));
    return true;
  } catch {
    return false;
  }
}

export function hasStructuredPadDraft(padId: string): boolean {
  try {
    return localStorage.getItem(keyFor(padId)) !== null;
  } catch {
    return false;
  }
}

export function removeStructuredPadDraft(padId: string): void {
  try {
    localStorage.removeItem(keyFor(padId));
  } catch {
    // The server copy remains available even when local storage is unavailable.
  }
}

/** Keep a newer local edit based on the server version written by an earlier save. */
export function advanceStructuredPadDraftVersion<T>(
  padId: string,
  savedData: T,
  updatedAt: string,
): void {
  try {
    const raw = localStorage.getItem(keyFor(padId));
    if (!raw) return;
    const draft = JSON.parse(raw) as { data?: T; expectedUpdatedAt?: string | null };
    if (JSON.stringify(draft.data) !== JSON.stringify(savedData)) {
      writeStructuredPadDraft(padId, draft.data, updatedAt, true);
    }
  } catch {
    // A malformed draft remains available for manual recovery.
  }
}

export async function fetchStructuredPadUpdatedAt(padId: string): Promise<string | null> {
  const response = await fetch(`/api/pad/${encodeURIComponent(padId)}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const pad = await response.json() as { updated_at?: unknown };
  return typeof pad.updated_at === 'string' ? pad.updated_at : null;
}

export function clearStructuredPadDraft<T>(padId: string, savedData: T): void {
  try {
    const raw = localStorage.getItem(keyFor(padId));
    if (raw && JSON.stringify((JSON.parse(raw) as { data?: T }).data) === JSON.stringify(savedData)) {
      localStorage.removeItem(keyFor(padId));
    }
  } catch {
    // A malformed or inaccessible draft is left for the user to recover manually.
  }
}
