import { describe, expect, it } from 'vitest';
import { parseWikiLink, resolveWikiLink } from './wikilinks';

const tabs = [
  { id: 'one', title: 'Overview', folder: 'Projects/Launch' },
  { id: 'two', title: 'Overview', folder: 'Projects/Design' },
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
});
