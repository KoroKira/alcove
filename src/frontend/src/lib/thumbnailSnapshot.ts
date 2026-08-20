/**
 * Native card snapshots for canvas/kanban/gantt/database/latex pads.
 *
 * Today these pad types fall back to an "iconic" thumbnail on the Dashboard
 * (a gradient + type icon) — see `Dashboard.tsx`'s `dashboard__card-thumb`.
 * This module captures a real preview image of the pad's content and
 * persists it via the same `PUT /api/pad/:id/card-meta` endpoint the
 * PDF/YouTube/OG-image thumbnails already use, so the Dashboard just works
 * once a data URI lands in `thumbnail_url` — no server or Dashboard change
 * needed.
 *
 * Two capture strategies:
 *   - Canvas (Excalidraw) pads use `exportToBlob`, the same API the
 *     existing "Export PNG" button uses (see App.tsx `exportCanvasPng`).
 *   - Everything else (kanban/gantt/database/latex) is plain DOM, captured
 *     via html2canvas against the pad's root container element.
 *
 * Both paths downscale to a small JPEG before turning it into a data URI —
 * full-resolution PNGs would bloat `GET /users/me` the same way the PDF
 * cover thumbnails already do at scale (see HANDOVER doc note on that).
 */
import type { ExcalidrawImperativeAPI } from '@atyrode/excalidraw/types';

// Matches the Dashboard card's rendered thumb width closely enough that we
// aren't storing pixels nobody will ever see, while staying sharp on 2x
// displays. Height isn't capped — html2canvas/exportToBlob preserve aspect
// ratio and the Dashboard's CSS crops via `object-fit: cover`.
const THUMB_MAX_WIDTH = 480;
const JPEG_QUALITY = 0.72;

// Throttle: never snapshot the same pad more than once per this window,
// even if callers fire on every save. Module-level so it survives
// component remounts (e.g. switching tabs and back) within a session.
const THROTTLE_MS = 30_000;
const _lastSnapshotAt = new Map<string, number>();

function shouldSnapshot(padId: string): boolean {
  const last = _lastSnapshotAt.get(padId) ?? 0;
  return Date.now() - last >= THROTTLE_MS;
}

function markSnapshotted(padId: string): void {
  _lastSnapshotAt.set(padId, Date.now());
}

/** Downscale an in-memory canvas to THUMB_MAX_WIDTH and return a JPEG data
 * URI. Runs entirely off-network — canvas.toDataURL is synchronous. */
function canvasToThumbnailDataUri(source: HTMLCanvasElement): string {
  if (source.width <= THUMB_MAX_WIDTH) {
    return source.toDataURL('image/jpeg', JPEG_QUALITY);
  }
  const scale = THUMB_MAX_WIDTH / source.width;
  const out = document.createElement('canvas');
  out.width = THUMB_MAX_WIDTH;
  out.height = Math.round(source.height * scale);
  const ctx = out.getContext('2d');
  if (!ctx) return source.toDataURL('image/jpeg', JPEG_QUALITY);
  ctx.drawImage(source, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', JPEG_QUALITY);
}

async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

/** PUT the data URI to the pad's card metadata. Silent no-op on failure —
 * a missed thumbnail refresh is never worth surfacing to the user. */
async function persistThumbnail(padId: string, dataUri: string): Promise<void> {
  try {
    await fetch(`/api/pad/${padId}/card-meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thumbnail_url: dataUri }),
    });
  } catch {
    /* best-effort */
  }
}

/** Snapshot an Excalidraw canvas pad. Call after a save settles (or on an
 * interval while the pad is open — canvas saves go through the Yjs collab
 * layer rather than a single debounced PUT, so there's no one call site to
 * hook like the other pad types have). No-op if throttled or the scene is
 * empty (nothing worth a thumbnail for a blank canvas). */
export async function snapshotCanvasPad(
  padId: string,
  api: ExcalidrawImperativeAPI,
): Promise<void> {
  if (!shouldSnapshot(padId)) return;
  const elements = api.getSceneElements();
  if (!elements.length) return;
  try {
    const { exportToBlob } = await import('@atyrode/excalidraw');
    const blob = await exportToBlob({
      elements,
      appState: api.getAppState(),
      files: api.getFiles(),
      mimeType: 'image/png',
      // Excalidraw scales the export by this factor before we downscale
      // again to THUMB_MAX_WIDTH — 1x keeps the exportToBlob call itself
      // cheap since we're about to shrink it regardless.
    });
    const canvas = await blobToCanvas(blob);
    const dataUri = canvasToThumbnailDataUri(canvas);
    markSnapshotted(padId);
    await persistThumbnail(padId, dataUri);
  } catch (e) {
    console.error('[alcove] Canvas thumbnail snapshot failed:', e);
  }
}

/** Snapshot a plain-DOM pad (kanban/gantt/database/latex) by rendering its
 * root container element. Call this right after a successful save. */
export async function snapshotDomPad(
  padId: string,
  container: HTMLElement,
): Promise<void> {
  if (!shouldSnapshot(padId)) return;
  try {
    const html2canvas = (await import('html2canvas')).default;
    const canvas = await html2canvas(container, {
      backgroundColor: null,
      scale: 1,
      logging: false,
      // Cap the source capture width too — html2canvas walks the live DOM,
      // and a huge kanban board with many columns can otherwise take a
      // noticeable beat to rasterize on every save.
      windowWidth: Math.min(container.scrollWidth, 1600),
    });
    const dataUri = canvasToThumbnailDataUri(canvas);
    markSnapshotted(padId);
    await persistThumbnail(padId, dataUri);
  } catch (e) {
    console.error('[alcove] DOM thumbnail snapshot failed:', e);
  }
}
