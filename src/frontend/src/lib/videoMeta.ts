// Video metadata is embedded in the pad markdown as an HTML comment so it
// travels with the content (no new API, no new column) and stays invisible in
// the rendered preview (browsers ignore comment nodes). The comment lives on
// its own line at the top of the doc; a simple regex handles it.
//
// Marker format:
//   <!-- alcove:video {"id":"dQw4w9WgXcQ","url":"…","thumbnail":"…","duration":213,"chapters":[…]} -->

export interface VideoChapter {
  title: string;
  start_time: number | null;
  end_time?: number | null;
}

export interface VideoMeta {
  /** YouTube 11-char id when the source is YT — enables the inline player. */
  id?: string;
  /** Canonical video URL — used as fallback when we have no id. */
  url?: string;
  /** Best-available thumbnail URL. */
  thumbnail?: string;
  /** Total duration in seconds. */
  duration?: number;
  /** Uploader / author. */
  author?: string;
  /** YouTube chapters with start times, if the video declared them. */
  chapters?: VideoChapter[];
}

// Payload is JSON that may embed nested `{...}` (chapters, sub-objects). The
// original non-greedy `\{[\s\S]*?\}` stopped at the FIRST inner `}` and
// truncated the parse, so the whole marker was silently dropped whenever it
// had any nested structure.
const MARKER_RE = /<!--\s*alcove:video\s+(\{[\s\S]*\})\s*-->/;

export function readVideoMeta(markdown: string): VideoMeta | null {
  const m = markdown.match(MARKER_RE);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    return typeof parsed === 'object' && parsed ? (parsed as VideoMeta) : null;
  } catch {
    return null;
  }
}

/** Strip the comment before feeding markdown to the renderer — the widget is
 * drawn out-of-band above the preview, we don't want the raw JSON showing up
 * anywhere. */
export function stripVideoMeta(markdown: string): string {
  return markdown.replace(MARKER_RE, '').replace(/^\n+/, '');
}

export function serializeVideoMeta(meta: VideoMeta): string {
  return `<!-- alcove:video ${JSON.stringify(meta)} -->`;
}

/** Parse `[MM:SS]` or `[H:MM:SS]` into seconds. Returns null on shapes we
 * don't want to treat as timecodes (avoids matching `[1:2:3:4]` etc.). */
export function parseTimestamp(text: string): number | null {
  const m = text.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const mm = parseInt(m[2], 10);
  const ss = parseInt(m[3], 10);
  if (mm > 59 || ss > 59) return null;
  return h * 3600 + mm * 60 + ss;
}

/** Swap the AI-generated report body of a video note in place, keeping:
 *   - the video meta comment
 *   - the `# Title` heading
 *   - the `> [!NOTE] Source` callout (front matter)
 *   - the `## Notes` section and everything after it (user's own edits,
 *     Flashcards, Liens, source-note wikilink)
 *
 * The report body sits between the front matter and the "## Notes" heading.
 * We locate it by finding the first `## ` heading that appears AFTER the
 * `> [!NOTE]` block. If we can't find one of these anchors (user edited the
 * note heavily) we fall back to appending the new report at the top.
 */
export function replaceReportBody(oldContent: string, newReport: string): string {
  const notesRe = /\n##\s+Notes\b/;
  const notesMatch = oldContent.match(notesRe);
  if (!notesMatch || notesMatch.index === undefined) {
    // No "## Notes" boundary — safest is to prepend and let the user reconcile.
    return `${newReport.trim()}\n\n---\n\n${oldContent}`;
  }
  // Find the first "## " heading that opens the report block.
  const reportRe = /\n##\s+/g;
  reportRe.lastIndex = 0;
  let firstReportIdx = -1;
  for (const m of oldContent.matchAll(reportRe)) {
    if (m.index !== undefined && m.index < notesMatch.index) {
      firstReportIdx = m.index;
      break;
    }
  }
  if (firstReportIdx < 0) {
    // No headings before "## Notes" — insert the report right before Notes.
    return oldContent.slice(0, notesMatch.index) + '\n\n' + newReport.trim() + oldContent.slice(notesMatch.index);
  }
  return (
    oldContent.slice(0, firstReportIdx).trimEnd()
    + '\n\n' + newReport.trim() + '\n\n'
    + oldContent.slice(notesMatch.index).trimStart().replace(/^/, '')
  );
}
