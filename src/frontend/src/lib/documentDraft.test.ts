import { afterEach, describe, expect, it } from 'vitest';
import {
  advanceLocalDocumentDraftVersion,
  clearLocalDocumentDraft,
  readLocalDocumentDraft,
  writeLocalDocumentDraft,
} from './documentDraft';

afterEach(() => localStorage.clear());

describe('local document recovery drafts', () => {
  it('stores recoverable content with the optimistic-concurrency baseline', () => {
    expect(writeLocalDocumentDraft('pad-a', 'unsaved text', '2026-10-22T10:00:00Z')).toBe(true);
    expect(readLocalDocumentDraft('pad-a')).toMatchObject({
      content: 'unsaved text',
      expectedUpdatedAt: '2026-10-22T10:00:00Z',
    });
    expect(readLocalDocumentDraft('pad-b')).toBeNull();
  });

  it('advances a newer edit after an earlier save without losing its content', () => {
    writeLocalDocumentDraft('pad-a', 'second edit', 'old-version');

    advanceLocalDocumentDraftVersion('pad-a', 'first edit', 'new-version');

    expect(readLocalDocumentDraft('pad-a')).toMatchObject({
      content: 'second edit',
      expectedUpdatedAt: 'new-version',
    });
  });

  it('clears only the draft acknowledged by the completed request', () => {
    writeLocalDocumentDraft('pad-a', 'new edit', 'version');

    clearLocalDocumentDraft('pad-a', 'older edit');
    expect(readLocalDocumentDraft('pad-a')?.content).toBe('new edit');

    clearLocalDocumentDraft('pad-a', 'new edit');
    expect(readLocalDocumentDraft('pad-a')).toBeNull();
  });

  it('ignores malformed local data safely', () => {
    localStorage.setItem('alcove:unsaved-document:pad-a', '{bad json');
    expect(readLocalDocumentDraft('pad-a')).toBeNull();
  });
});
