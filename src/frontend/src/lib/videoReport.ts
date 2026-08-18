/**
 * Video → structured Markdown report (Phase 3D).
 *
 * Direct port of the retired backend/routers/ai/video_report.py. The pipeline
 * is unchanged — one MAP call per YouTube chapter (or a ~4-minute time slice
 * when the video has no chapters), then a single REDUCE editor pass — but the
 * Ollama calls now happen from the browser against localhost.
 *
 * Timestamps [MM:SS] survive both phases so the reader can jump back to any
 * claim in the embedded player.
 */

import { oneShotLocalOllama } from '../hooks/useOllama';

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
}

export interface VideoChapter {
  title: string;
  start_time?: number | null;
  end_time?: number | null;
}

export interface VideoReportMeta {
  title: string;
  url?: string;
  description?: string;
  author?: string;
  duration?: number;
  chapters?: VideoChapter[];
  transcript_segments: TranscriptSegment[];
  lang?: 'fr' | 'en';
}

export interface VideoReportEvent {
  kind: 'progress' | 'document' | 'error';
  msg?: string;
  content?: string;
  error?: string;
}


// ── Helpers (mirrors of the Python versions) ───────────────────────────────

function fmtHms(seconds: number): string {
  const s = Math.round(Math.max(0, seconds));
  const h = Math.floor(s / 3600);
  const rem = s % 3600;
  const m = Math.floor(rem / 60);
  const sec = rem % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function stampSegments(segments: TranscriptSegment[]): string {
  const lines: string[] = [];
  segments.forEach((s, i) => {
    if (i && i % 8 === 0) lines.push('');
    const prefix = `[${fmtHms(s.start)}]`;
    const t = (s.text || '').trim();
    if (s.speaker) lines.push(`${prefix} ${s.speaker} : ${t}`);
    else lines.push(`${prefix} ${t}`);
  });
  return lines.join('\n');
}

interface Chunk {
  title: string;
  start: number;
  end: number;
  segments: TranscriptSegment[];
}

function chunksFromChapters(
  chapters: VideoChapter[], segments: TranscriptSegment[], totalDuration?: number,
): Chunk[] {
  if (!chapters.length) return [];
  const out: Chunk[] = [];
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const start = ch.start_time ?? 0;
    let end: number;
    if (ch.end_time != null) end = ch.end_time;
    else if (i + 1 < chapters.length && chapters[i + 1].start_time != null) end = chapters[i + 1].start_time as number;
    else end = totalDuration ?? Number.POSITIVE_INFINITY;
    const chapterSegments = segments.filter(s => s.start >= start && s.start < end);
    out.push({
      title: ch.title,
      start,
      end: isFinite(end) ? end : start,
      segments: chapterSegments,
    });
  }
  return out;
}

function chunksByTime(
  segments: TranscriptSegment[], windowSeconds = 240, maxChunks = 12,
): Chunk[] {
  if (!segments.length) return [];
  const total = segments[segments.length - 1].end - segments[0].start;
  let w = windowSeconds;
  if (total / w > maxChunks) w = Math.ceil(total / maxChunks / 30) * 30;
  const out: Chunk[] = [];
  let curStart = segments[0].start;
  let cur: TranscriptSegment[] = [];
  for (const s of segments) {
    if (s.start - curStart >= w && cur.length) {
      out.push({
        title: `${fmtHms(curStart)} — ${fmtHms(cur[cur.length - 1].end)}`,
        start: curStart,
        end: cur[cur.length - 1].end,
        segments: cur,
      });
      cur = [];
      curStart = s.start;
    }
    cur.push(s);
  }
  if (cur.length) {
    out.push({
      title: `${fmtHms(curStart)} — ${fmtHms(cur[cur.length - 1].end)}`,
      start: curStart,
      end: cur[cur.length - 1].end,
      segments: cur,
    });
  }
  return out;
}


// ── Prompts (verbatim from the Python file) ────────────────────────────────

const MAP_INSTRUCTIONS_FR =
  "Tu analyses un extrait de vidéo. Le texte ci-dessous est la transcription "
  + "chronologique de cet extrait, chaque ligne préfixée par son timecode "
  + "[MM:SS] ou [H:MM:SS]. IMPORTANT : conserve toujours les timecodes tels "
  + "quels dans ta réponse — ce sont eux qui permettent au lecteur de vérifier "
  + "chaque affirmation.\n\n"
  + "Réponds STRICTEMENT en JSON, rien d'autre :\n"
  + '{"summary": "2-3 phrases sur ce qui est dit dans cet extrait", '
  + '"moments": [{"time": "MM:SS", "speaker": "Intervenant 1"|null, "point": "ce qui est dit/décidé/expliqué à ce moment"}], '
  + '"quotes": [{"time": "MM:SS", "speaker": "Intervenant 1"|null, "text": "citation courte verbatim"}], '
  + '"entities": ["personnes, œuvres, outils, concepts cités"]}\n\n'
  + "- `moments` : 2 à 5 moments clés, dans l'ordre chronologique. Chaque "
  + "  entrée doit correspondre à un vrai instant que l'on peut retrouver.\n"
  + "- `quotes` : 0 à 2 citations verbatim COURTES (< 25 mots). N'INVENTE PAS.\n"
  + "- `speaker` : reprends EXACTEMENT le libellé (ex. « Intervenant 1 ») "
  + "  quand une ligne le mentionne ; sinon `null`.\n"
  + "- `entities` : noms propres, produits, concepts. Vide si aucun.\n"
  + "- Ne parle JAMAIS d'\"extrait\", de \"portion\" ou de \"partie\" dans tes phrases : "
  + "  écris comme si tu résumais du contenu, pas comme si tu commentais une tâche.";

const MAP_INSTRUCTIONS_EN =
  "You are analyzing a segment of a video. The text below is the chronological "
  + "transcript of this segment, each line prefixed with its `[MM:SS]` (or "
  + "`[H:MM:SS]`) timestamp. IMPORTANT: always keep the timestamps verbatim in "
  + "your reply — they let the reader verify every claim.\n\n"
  + "Reply STRICTLY in JSON, nothing else:\n"
  + '{"summary": "2-3 sentences on what is said in this segment", '
  + '"moments": [{"time": "MM:SS", "speaker": "Speaker 1"|null, "point": "what is said/decided/explained at that moment"}], '
  + '"quotes": [{"time": "MM:SS", "speaker": "Speaker 1"|null, "text": "short verbatim quote"}], '
  + '"entities": ["people, works, tools, concepts mentioned"]}\n\n'
  + "- `moments`: 2 to 5 key moments, chronological. Each must map to a real instant.\n"
  + "- `quotes`: 0 to 2 SHORT verbatim quotes (< 25 words). NEVER invent.\n"
  + "- `speaker`: reprint the exact label (e.g. \"Speaker 1\") when a line "
  + "  carries one; otherwise `null`.\n"
  + "- `entities`: proper nouns, products, concepts. Empty if none.\n"
  + "- Never say \"segment\", \"portion\" or \"part\" in your sentences — write as "
  + "  if summarizing content, not commenting on a task.";

const REDUCE_PROMPT_FR =
  "Tu es un éditeur. Tu reçois l'analyse chapitre par chapitre d'une vidéo, "
  + "au format JSON. Rédige UN rapport de lecture Markdown, en français, dense "
  + "et lisible.\n\n"
  + "Contraintes STRICTES :\n"
  + "- Conserve tous les timecodes tels quels (format `[MM:SS]` ou `[H:MM:SS]`).\n"
  + "- Le rapport DOIT commencer par « ## Résumé » puis « ## Points clés » ; "
  + "  saute directement dedans, sans phrase d'intro.\n"
  + "- Écris comme si tu synthétisais un livre : à la 3e personne, sans dire "
  + "  « la vidéo », « l'intervenant explique que », etc. Cite plutôt l'auteur "
  + "  par son nom quand tu le connais.\n"
  + "- Ne fabrique rien : si l'analyse ne contient pas quelque chose, ne l'invente pas.\n\n"
  + "Structure attendue :\n"
  + "## Résumé\n(3-5 phrases synthétisant l'apport global.)\n\n"
  + "## Points clés\n(6-10 puces courtes, chacune préfixée de son `[MM:SS]`.)\n\n"
  + "## Plan détaillé\n(Une sous-section `### [MM:SS] Titre du chapitre` par "
  + "chapitre, avec 2-4 phrases de synthèse dedans, et des puces `[MM:SS] …` "
  + "pour les moments notables.)\n\n"
  + "## Citations notables\n(> `[MM:SS]` : citation. Une par ligne. Omet la "
  + "section si vide.)\n\n"
  + "## Entités / références\n(Puces plates : personnes, outils, œuvres cités.)\n\n"
  + "## À creuser\n(3-5 questions ouvertes que le lecteur pourrait explorer, "
  + "sans timecodes.)";

const REDUCE_PROMPT_EN =
  "You are an editor. You receive the chapter-by-chapter analysis of a video "
  + "as JSON. Write ONE Markdown reading report, in English, dense and readable.\n\n"
  + "STRICT constraints:\n"
  + "- Preserve every timestamp verbatim (`[MM:SS]` or `[H:MM:SS]`).\n"
  + "- The report MUST start with `## Summary` then `## Key points`; jump right "
  + "  in, no introductory sentence.\n"
  + "- Write as if summarizing a book: third person, no \"the video\", \"the "
  + "  speaker explains\". Prefer citing the author by name when known.\n"
  + "- Do not invent. If the analysis doesn't say it, don't add it.\n\n"
  + "Expected structure:\n"
  + "## Summary\n(3-5 sentences.)\n\n"
  + "## Key points\n(6-10 short bullets, each prefixed with `[MM:SS]`.)\n\n"
  + "## Detailed outline\n(One `### [MM:SS] Chapter title` sub-section per "
  + "chapter, with 2-4 sentences of synthesis and bullets `[MM:SS] …` for "
  + "notable moments.)\n\n"
  + "## Notable quotes\n(> `[MM:SS]`: quote. One per line. Omit if empty.)\n\n"
  + "## Entities / references\n(Flat bullets: people, tools, works.)\n\n"
  + "## Follow-ups\n(3-5 open questions the reader could explore, no timestamps.)";


// ── JSON extraction (dupes generation.py::_parse_json_obj) ─────────────────

function stripThink(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function parseJsonObj(raw: string): Record<string, unknown> {
  const cleaned = stripThink(raw);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}') + 1;
  if (start < 0 || end <= start) return {};
  try { return JSON.parse(cleaned.slice(start, end)); } catch { return {}; }
}


// ── MAP + REDUCE ───────────────────────────────────────────────────────────

interface ChapterAnalysis {
  title: string; start: number; end: number;
  summary: string;
  moments: { time: string; point: string; speaker: string | null }[];
  quotes: { time: string; text: string; speaker: string | null }[];
  entities: string[];
}

function normaliseSpeaker(x: Record<string, unknown>): string | null {
  const v = x.speaker;
  if (v == null || v === 'null') return null;
  const s = String(v).trim();
  return s || null;
}

async function analyseChapter(model: string, chunk: Chunk, lang: 'fr' | 'en'): Promise<ChapterAnalysis> {
  if (!chunk.segments.length) {
    return {
      title: chunk.title, start: chunk.start, end: chunk.end,
      summary: '', moments: [], quotes: [], entities: [],
    };
  }
  const stamped = stampSegments(chunk.segments);
  const header = lang === 'fr'
    ? `Titre du chapitre : « ${chunk.title} » (${fmtHms(chunk.start)} → ${fmtHms(chunk.end)})\n\n`
    : `Chapter title: “${chunk.title}” (${fmtHms(chunk.start)} → ${fmtHms(chunk.end)})\n\n`;
  const instr = lang === 'fr' ? MAP_INSTRUCTIONS_FR : MAP_INSTRUCTIONS_EN;
  const prompt = `${instr}\n\n${header}Transcription :\n${stamped.slice(0, 8000)}`;

  let data: Record<string, unknown> = {};
  try {
    const raw = await oneShotLocalOllama(
      model, [{ role: 'user', content: prompt }],
      { format: 'json', timeoutMs: 240_000 },
    );
    data = parseJsonObj(raw);
  } catch { data = {}; }

  const moments = ((data.moments as unknown[]) || [])
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map(m => {
      const time = String(m.time || '').trim();
      const point = String(m.point || '').trim();
      return time && point ? { time, point, speaker: normaliseSpeaker(m) } : null;
    })
    .filter((x): x is { time: string; point: string; speaker: string | null } => x !== null)
    .slice(0, 5);

  const quotes = ((data.quotes as unknown[]) || [])
    .filter((q): q is Record<string, unknown> => typeof q === 'object' && q !== null)
    .map(q => {
      const time = String(q.time || '').trim();
      const text = String(q.text || '').trim();
      return time && text && text.length < 400 ? { time, text, speaker: normaliseSpeaker(q) } : null;
    })
    .filter((x): x is { time: string; text: string; speaker: string | null } => x !== null)
    .slice(0, 2);

  const entities = ((data.entities as unknown[]) || [])
    .map(x => String(x).trim())
    .filter(Boolean)
    .slice(0, 10);

  return {
    title: chunk.title,
    start: chunk.start,
    end: chunk.end,
    summary: String(data.summary || '').trim(),
    moments,
    quotes,
    entities,
  };
}


async function reduceReport(model: string, analyses: ChapterAnalysis[], meta: VideoReportMeta): Promise<string> {
  const digest = JSON.stringify(
    analyses.map(a => ({
      title: a.title, start: fmtHms(a.start), end: fmtHms(a.end),
      summary: a.summary, moments: a.moments, quotes: a.quotes, entities: a.entities,
    })),
  ).slice(0, 14000);

  const speakers = Array.from(new Set(
    analyses.flatMap(a => [...a.moments, ...a.quotes])
      .map(m => m.speaker)
      .filter((s): s is string => Boolean(s)),
  )).sort();

  const lang = meta.lang || 'fr';
  const speakerHintFr = speakers.length
    ? `\nIntervenants détectés : ${speakers.join(', ')}. Quand un moment / une `
      + `citation cite un intervenant, préfixe la ligne par son nom `
      + `(ex. « [12:34] Intervenant 1 : … »).\n`
    : '';
  const speakerHintEn = speakers.length
    ? `\nSpeakers detected: ${speakers.join(', ')}. When a moment / quote `
      + `belongs to a speaker, prefix the line with their name `
      + `(e.g. "[12:34] Speaker 1: …").\n`
    : '';

  const header = lang === 'fr'
    ? `Titre : ${meta.title}\nAuteur/chaîne : ${meta.author || '—'}\n`
      + `Durée : ${meta.duration ? fmtHms(meta.duration) : '—'}${speakerHintFr}\n`
    : `Title: ${meta.title}\nAuthor/channel: ${meta.author || '—'}\n`
      + `Duration: ${meta.duration ? fmtHms(meta.duration) : '—'}${speakerHintEn}\n`;

  const prompt = lang === 'fr'
    ? `${REDUCE_PROMPT_FR}\n\n${header}\nAnalyses :\n${digest}`
    : `${REDUCE_PROMPT_EN}\n\n${header}\nAnalyses:\n${digest}`;

  const raw = await oneShotLocalOllama(
    model, [{ role: 'user', content: prompt }],
    { timeoutMs: 240_000 },
  );
  const cleaned = stripThink(raw);
  const h = cleaned.indexOf('## ');
  return h > 0 ? cleaned.slice(h).trim() : cleaned;
}


// ── Entry point ────────────────────────────────────────────────────────────

export async function videoReport(
  model: string,
  meta: VideoReportMeta,
  onEvent: (e: VideoReportEvent) => void,
): Promise<void> {
  const lang: 'fr' | 'en' = meta.lang || 'fr';
  if (!meta.transcript_segments?.length) {
    onEvent({ kind: 'error', error: "Transcription vide — impossible d'analyser cette vidéo." });
    return;
  }

  const chunks: Chunk[] = meta.chapters?.length
    ? chunksFromChapters(meta.chapters, meta.transcript_segments, meta.duration)
    : chunksByTime(meta.transcript_segments);

  onEvent({
    kind: 'progress',
    msg: meta.chapters?.length
      ? `📖 ${chunks.length} chapitre(s) YouTube détecté(s)`
      : `⏱️ Découpage temporel : ${chunks.length} bloc(s) de ~4 min`,
  });

  try {
    // MAP — concurrent, stream progress
    const results: (ChapterAnalysis | null)[] = new Array(chunks.length).fill(null);
    let done = 0;
    const tasks = chunks.map((ch, i) => analyseChapter(model, ch, lang).then(res => {
      results[i] = res;
      done += 1;
      onEvent({ kind: 'progress', msg: `Analyse ${done}/${chunks.length}…` });
    }));
    await Promise.all(tasks);

    // REDUCE — one editor pass
    onEvent({ kind: 'progress', msg: '✍️ Rédaction du rapport…' });
    const md = await reduceReport(model, results.filter((x): x is ChapterAnalysis => !!x), meta);
    onEvent({ kind: 'document', content: md });
  } catch (e) {
    onEvent({ kind: 'error', error: e instanceof Error ? e.message : String(e) });
  }
}
