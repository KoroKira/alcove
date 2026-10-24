import { describe, expect, it } from 'vitest';
import { normalizeCanvasData } from './canvas';
import { INITIAL_APP_DATA } from '../constants';

describe('initial canvas data', () => {
  it('provides Excalidraw a collaborator map before a pad scene loads', () => {
    expect(INITIAL_APP_DATA.appState.collaborators).toBeInstanceOf(Map);
  });
});

describe('normalizeCanvasData', () => {
  it.each([
    ['missing', undefined],
    ['null', null],
    ['invalid object', {}],
  ])('normalizes %s searchMatches to an array', (_label, searchMatches) => {
    const appState = searchMatches === undefined ? {} : { searchMatches };
    const normalized = normalizeCanvasData({ elements: [], appState });

    expect(normalized.appState.searchMatches).toEqual([]);
  });

  it('preserves existing search matches', () => {
    const matches = [{ id: 'shape-1', focus: 0 }];
    const normalized = normalizeCanvasData({ elements: [], appState: { searchMatches: matches } });

    expect(normalized.appState.searchMatches).toBe(matches);
  });
});
