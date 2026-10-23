import { afterEach, describe, expect, it } from 'vitest';
import { advanceStructuredPadDraftVersion, clearStructuredPadDraft, isStructuredPadDraftStale, readStructuredPadDraft, readStructuredPadDraftRecord, removeStructuredPadDraft, writeStructuredPadDraft } from './structuredPadDraft';

describe('structured pad drafts', () => {
  afterEach(() => localStorage.clear());

  it('restores the latest saved local draft by pad id', () => {
    const draft = { rows: [{ id: 'r1', value: 'local edit' }] };
    expect(writeStructuredPadDraft('pad-1', draft, '2026-10-22T10:00:00Z')).toBe(true);
    expect(readStructuredPadDraft('pad-1', { rows: [] })).toEqual(draft);
    expect(readStructuredPadDraftRecord<typeof draft>('pad-1')).toMatchObject({
      data: draft,
      expectedUpdatedAt: '2026-10-22T10:00:00Z',
      baselineKnown: true,
    });
    expect(readStructuredPadDraft('pad-2', { rows: [] })).toEqual({ rows: [] });
  });

  it('clears only the draft that was successfully saved', () => {
    const oldDraft = { value: 'first' };
    const newerDraft = { value: 'second' };
    writeStructuredPadDraft('pad-1', oldDraft, 'version-1');
    writeStructuredPadDraft('pad-1', newerDraft, 'version-2');
    clearStructuredPadDraft('pad-1', oldDraft);
    expect(readStructuredPadDraft('pad-1', null)).toEqual(newerDraft);
    clearStructuredPadDraft('pad-1', newerDraft);
    expect(readStructuredPadDraft('pad-1', null)).toBeNull();
  });

  it('advances a newer local edit after an earlier save succeeds', () => {
    const saved = { value: 'first' };
    const newer = { value: 'second' };
    writeStructuredPadDraft('pad-1', newer, 'old-version');

    advanceStructuredPadDraftVersion('pad-1', saved, 'new-version');

    expect(readStructuredPadDraftRecord('pad-1')).toMatchObject({
      data: newer,
      expectedUpdatedAt: 'new-version',
      baselineKnown: true,
    });
  });

  it('removes a conflicting draft when the user chooses the server copy', () => {
    writeStructuredPadDraft('pad-1', { value: 'local edit' }, 'version-1');
    removeStructuredPadDraft('pad-1');
    expect(readStructuredPadDraft('pad-1', { value: 'server' })).toEqual({ value: 'server' });
  });

  it('marks drafts from the earlier format as missing their concurrency baseline', () => {
    localStorage.setItem('alcove:structured-pad-draft:pad-legacy', JSON.stringify({ data: { value: 'local edit' }, savedAt: '2026-10-22T10:00:00Z' }));
    expect(readStructuredPadDraftRecord('pad-legacy')).toMatchObject({
      data: { value: 'local edit' },
      expectedUpdatedAt: null,
      baselineKnown: false,
    });
  });

  it('detects when the server has advanced since the local draft was made', () => {
    const draft = { data: { value: 'local' }, expectedUpdatedAt: 'v1', baselineKnown: true };
    expect(isStructuredPadDraftStale(draft, 'v1')).toBe(false);
    expect(isStructuredPadDraftStale(draft, 'v2')).toBe(true);
  });
});
