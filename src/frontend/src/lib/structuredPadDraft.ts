/** Best-effort local recovery for structured pad edits that have not reached the server. */
const keyFor = (padId: string) => `alcove:structured-pad-draft:${padId}`;

export function readStructuredPadDraft<T>(padId: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(keyFor(padId));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { data?: T };
    return parsed.data ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeStructuredPadDraft<T>(padId: string, data: T): boolean {
  try {
    localStorage.setItem(keyFor(padId), JSON.stringify({ data, savedAt: new Date().toISOString() }));
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
