import { describe, expect, it } from 'vitest';
import { ensureCanvasCollaborators, normalizeCanvasData } from './canvas';
import { INITIAL_APP_DATA } from '../constants';

describe('initial canvas data', () => {
  it('provides Excalidraw a collaborator map before a pad scene loads', () => {
    expect(INITIAL_APP_DATA.appState.collaborators).toBeInstanceOf(Map);
  });
});

describe('ensureCanvasCollaborators', () => {
  it('supplies the iterable required by Excalidraw after partial app-state updates', () => {
    expect(ensureCanvasCollaborators({ theme: 'dark' }).collaborators).toBeInstanceOf(Map);
  });

  it('preserves the current collaborator map', () => {
    const collaborators = new Map();
    expect(ensureCanvasCollaborators({ collaborators }).collaborators).toBe(collaborators);
  });
});

describe('normalizeCanvasData', () => {
  it.each([
    ['missing', undefined],
    ['null', null],
    ['array', []],
    ['invalid object', {}],
  ])('normalizes %s searchMatches to null', (_label, searchMatches) => {
    const appState = searchMatches === undefined ? {} : { searchMatches };
    const normalized = normalizeCanvasData({ elements: [], appState });

    expect(normalized.appState.searchMatches).toBeNull();
  });

  it('preserves existing search matches', () => {
    const searchMatches = { focusedId: null, matches: [{ id: 'shape-1', focus: false, matchedLines: [] }] };
    const normalized = normalizeCanvasData({ elements: [], appState: { searchMatches } });

    expect(normalized.appState.searchMatches).toBe(searchMatches);
  });
});
