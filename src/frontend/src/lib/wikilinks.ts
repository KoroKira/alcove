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

function normalizeVaultPath(path: string): string | undefined {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/** Resolve a vault path against Alcove's preserved pad folder and title.
 * Folderless links prefer the current note's folder to avoid opening a
 * same-named note from another part of the vault. `./` and `../` paths are
 * interpreted relative to that folder, never outside the vault. */
export function resolveWikiLink(
  value: string,
  tabs: Tab[],
  sourceFolder?: string,
): { id: string; title: string } | undefined {
  const { target } = parseWikiLink(value);
  if (!target) return undefined;
  const parts = target.split('/').filter(Boolean);
  const title = parts.pop() || '';
  const normalized = (text: string) => text.toLocaleLowerCase();
  const candidates = tabs.filter(tab => normalized(tab.title) === normalized(title));
  if (parts.length) {
    const relative = parts[0] === '.' || parts[0] === '..';
    const folderPath = normalizeVaultPath([
      ...(relative && sourceFolder ? [sourceFolder] : []),
      ...parts,
    ].join('/'));
    if (folderPath === undefined) return undefined;
    const folder = normalized(folderPath);
    return candidates.find(tab => normalized(tab.folder || '') === normalized(folder));
  }
  if (sourceFolder !== undefined) {
    const currentFolderMatch = candidates.find(tab => normalized(tab.folder || '') === normalized(sourceFolder));
    if (currentFolderMatch) return currentFolderMatch;
    if (candidates.length > 1) return undefined;
  }
  return candidates[0];
}

/** Resolve the document pads needed to render all transclusions in content. */
export function findTransclusionTargets(content: string, tabs: Tab[], sourceFolder?: string): Tab[] {
  const targets = new Map<string, Tab>();
  for (const match of content.matchAll(/!\[\[([^\]]+)\]\]/g)) {
    const target = resolveWikiLink(match[1], tabs, sourceFolder);
    if (target) {
      const tab = tabs.find(candidate => candidate.id === target.id);
      if (tab?.padType === 'document') targets.set(tab.id, tab);
    }
  }
  return [...targets.values()];
}
