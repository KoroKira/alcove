export interface LocalDocumentDraft {
  content: string;
  expectedUpdatedAt: string | null;
  storedAt: string;
}

const keyFor = (padId: string) => `alcove:unsaved-document:${padId}`;

export function readLocalDocumentDraft(padId: string): LocalDocumentDraft | null {
  try {
    const raw = localStorage.getItem(keyFor(padId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<LocalDocumentDraft>;
    if (typeof value.content !== 'string' || typeof value.storedAt !== 'string') return null;
    return {
      content: value.content,
      expectedUpdatedAt: typeof value.expectedUpdatedAt === 'string' ? value.expectedUpdatedAt : null,
      storedAt: value.storedAt,
    };
  } catch {
    return null;
  }
}

export function writeLocalDocumentDraft(
  padId: string,
  content: string,
  expectedUpdatedAt: string | null,
): boolean {
  try {
    localStorage.setItem(keyFor(padId), JSON.stringify({
      content,
      expectedUpdatedAt,
      storedAt: new Date().toISOString(),
    } satisfies LocalDocumentDraft));
    return true;
  } catch {
    return false;
  }
}

/** Advance a newer local edit's concurrency baseline after an earlier save. */
export function advanceLocalDocumentDraftVersion(
  padId: string,
  savedContent: string,
  updatedAt: string,
): void {
  const draft = readLocalDocumentDraft(padId);
  if (draft && draft.content !== savedContent) {
    writeLocalDocumentDraft(padId, draft.content, updatedAt);
  }
}

/** Avoid deleting a newer edit when an older in-flight save completes. */
export function clearLocalDocumentDraft(padId: string, savedContent?: string): void {
  try {
    if (savedContent !== undefined && readLocalDocumentDraft(padId)?.content !== savedContent) return;
    localStorage.removeItem(keyFor(padId));
  } catch {
    // Storage cleanup is best-effort; keeping a draft is safer than losing it.
  }
}
