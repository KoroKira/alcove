import { DEFAULT_SETTINGS } from '../constants';

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
export function adaptSceneToTheme(scene: any, bg: string, ink: string) {
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
      theme: 'light',
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
  
  // Support new appState key default value (https://github.com/excalidraw/excalidraw/commit/a30e1b25c60a9c5c6f049daada0443df874a5266#diff-b7eb4d88c1bc5b4756a01281478e2105db6502e96c2a4b855496c508cef05397L124-R124)
  appState.searchMatches = null;

  return { ...data, appState };
}