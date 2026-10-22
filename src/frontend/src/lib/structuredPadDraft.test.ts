import { afterEach, describe, expect, it } from 'vitest';
import { clearStructuredPadDraft, readStructuredPadDraft, writeStructuredPadDraft } from './structuredPadDraft';

describe('structured pad drafts', () => {
  afterEach(() => localStorage.clear());

  it('restores the latest saved local draft by pad id', () => {
    const draft = { rows: [{ id: 'r1', value: 'local edit' }] };
    expect(writeStructuredPadDraft('pad-1', draft)).toBe(true);
    expect(readStructuredPadDraft('pad-1', { rows: [] })).toEqual(draft);
    expect(readStructuredPadDraft('pad-2', { rows: [] })).toEqual({ rows: [] });
  });

  it('clears only the draft that was successfully saved', () => {
    const oldDraft = { value: 'first' };
    const newerDraft = { value: 'second' };
    writeStructuredPadDraft('pad-1', oldDraft);
    writeStructuredPadDraft('pad-1', newerDraft);
    clearStructuredPadDraft('pad-1', oldDraft);
    expect(readStructuredPadDraft('pad-1', null)).toEqual(newerDraft);
    clearStructuredPadDraft('pad-1', newerDraft);
    expect(readStructuredPadDraft('pad-1', null)).toBeNull();
  });
});
