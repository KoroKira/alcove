import { describe, expect, it } from 'vitest';
import { findTransclusionTargets, parseWikiLink, resolveWikiLink } from './wikilinks';

const tabs = [
  { id: 'one', title: 'Overview', folder: 'Projects/Launch', padType: 'document' },
  { id: 'two', title: 'Overview', folder: 'Projects/Design', padType: 'document' },
] as any;

describe('Obsidian wikilinks', () => {
  it('resolves folder-qualified links and ignores heading fragments', () => {
    expect(resolveWikiLink('Projects/Design/Overview#Architecture', tabs)?.id).toBe('two');
  });

  it('uses the alias as its display label while resolving the target', () => {
    expect(parseWikiLink('Projects/Launch/Overview|Launch plan')).toEqual({
      target: 'Projects/Launch/Overview',
      label: 'Launch plan',
    });
    expect(resolveWikiLink('Projects/Launch/Overview|Launch plan', tabs)?.id).toBe('one');
  });

  it('keeps title-only links compatible and falls back to the target basename', () => {
    expect(resolveWikiLink('Overview', tabs)?.id).toBe('one');
    expect(parseWikiLink('Projects/Launch/Overview#^block')).toEqual({
      target: 'Projects/Launch/Overview',
      label: 'Overview',
    });
  });

  it('prefers the current folder when a title exists in multiple folders', () => {
    expect(resolveWikiLink('Overview', tabs, 'Projects/Design')?.id).toBe('two');
    expect(resolveWikiLink('Overview', tabs, 'Projects/Research')).toBeUndefined();
    const withRoot = [...tabs, { id: 'root', title: 'Overview', folder: '' }];
    expect(resolveWikiLink('Overview', withRoot, '')?.id).toBe('root');
  });

  it('resolves relative vault paths and rejects traversal above the vault root', () => {
    expect(resolveWikiLink('../Design/Overview', tabs, 'Projects/Launch')?.id).toBe('two');
    expect(resolveWikiLink('./Overview', tabs, 'Projects/Design')?.id).toBe('two');
    expect(resolveWikiLink('../../../Overview', tabs, 'Projects/Launch')).toBeUndefined();
  });

  it('finds folder-qualified transclusions and deduplicates repeated references', () => {
    expect(findTransclusionTargets(
      '![[Projects/Design/Overview#Architecture|Design]] and ![[Projects/Design/Overview]]',
      tabs,
    ).map(tab => tab.id)).toEqual(['two']);
  });

  it('uses the source folder when selecting a same-named transclusion', () => {
    expect(findTransclusionTargets('![[Overview]]', tabs, 'Projects/Design').map(tab => tab.id)).toEqual(['two']);
  });
});
