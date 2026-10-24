import { DEFAULT_SETTINGS } from '../constants';
import type { AppState } from '@atyrode/excalidraw/types';

/** Keep Excalidraw's renderer-required collaborator collection on partial updates. */
export function ensureCanvasCollaborators(appState: Partial<AppState>): Partial<AppState> {
  return { ...appState, collaborators: appState.collaborators ?? new Map() };
}

function lightness(hex: string): number | null {
  const m = hex.replace('#', '').match(/.{2}/g);
  if (!m || m.length < 3) return null;
  const [r, g, b] = m.map(x => parseInt(x, 16) / 255);
  return ((Math.max(r, g, b) + Math.min(r, g, b)) / 2) * 100;
}

/**
 * Adapt a scene to the active app theme.
 * The canvas always renders with Excalidraw theme "light" (WYSIWYG — the dark
 * mode invert() filter would flip our custom backgrounds), so we set the
 * background and default ink directly, and rescue any element stroke that
 * would be invisible against the new background (e.g. black strokes from
 * scenes authored on a white canvas).
 */
export function adaptSceneToTheme(scene: any, bg: string, ink: string, dark: boolean) {
  if (!scene) return scene;
  const bgL = lightness(bg) ?? 15;

  const rescue = (color: string | undefined) => {
    if (!color || color === 'transparent' || !color.startsWith('#')) return color;
    const l = lightness(color);
    if (l === null) return color;
    return Math.abs(l - bgL) < 22 ? ink : color;
  };

  const elements = Array.isArray(scene.elements)
    ? scene.elements.map((el: any) => {
        const sc = rescue(el.strokeColor);
        return sc !== el.strokeColor ? { ...el, strokeColor: sc } : el;
      })
    : scene.elements;

  return {
    ...scene,
    elements,
    appState: {
      ...(scene.appState ?? {}),
      // Keep Excalidraw's own contrast model in sync with the paper. Alcove
      // disables Excalidraw's legacy canvas invert filter in CSS, so dark mode
      // now gives us its pleasantly subtle grid without changing our colours.
      theme: dark ? 'dark' : 'light',
      viewBackgroundColor: bg,
      currentItemStrokeColor: rescue(scene.appState?.currentItemStrokeColor) ?? ink,
    },
  };
}

/**
 *
 * @param data The canvas data to normalize
 * @returns Normalized canvas data
 */
export function normalizeCanvasData(data: any) {
  if (!data) return data;
  
  const appState = { ...data.appState };
  
  // Remove width and height properties
  if ("width" in appState) {
    delete appState.width;
  }
  if ("height" in appState) {
    delete appState.height;
  }

  // Preserve existing pad settings if they exist, otherwise create new ones
  const existingPad = appState.pad || {};
  const existingUserSettings = existingPad.userSettings || {};
  
  // Merge existing pad properties with our updates
  appState.pad = { 
    ...existingPad,  // Preserve all existing properties (uniqueId, displayName, etc.)
    // Merge existing user settings with default settings
    userSettings: {
      ...DEFAULT_SETTINGS,
      ...existingUserSettings
    }
  };
  
  // Reset collaborators (https://github.com/excalidraw/excalidraw/issues/8637)
  appState.collaborators = new Map();
  
  // Excalidraw expects either null or { matches: [...] } here. A scene with
  // an array (or a missing/legacy value) makes its renderer call
  // `searchMatches.matches.forEach` on undefined and crashes the canvas.
  if (!appState.searchMatches || !Array.isArray(appState.searchMatches.matches)) {
    appState.searchMatches = null;
  }

  return { ...data, appState };
}
