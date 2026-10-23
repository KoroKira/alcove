import type { Tab } from '../hooks/usePadTabs';

export interface ParsedWikiLink {
  target: string;
  label: string;
}

/** Parse Obsidian-style links, dropping heading/block fragments for pad lookup. */
export function parseWikiLink(value: string): ParsedWikiLink {
  const [rawTarget, ...labelParts] = value.split('|');
  const target = rawTarget.trim().replace(/#\^?.*$/, '').trim();
  const label = labelParts.join('|').trim() || target.split('/').pop() || target;
  return { target, label };
}

/** Resolve a vault path against Alcove's preserved pad folder and title. */
export function resolveWikiLink(value: string, tabs: Tab[]): { id: string; title: string } | undefined {
  const { target } = parseWikiLink(value);
  if (!target) return undefined;
  const parts = target.split('/').filter(Boolean);
  const title = parts.pop() || '';
  const normalized = (text: string) => text.toLocaleLowerCase();
  const candidates = tabs.filter(tab => normalized(tab.title) === normalized(title));
  if (parts.length) {
    const folder = parts.join('/');
    return candidates.find(tab => normalized(tab.folder || '') === normalized(folder));
  }
  return candidates[0];
}
