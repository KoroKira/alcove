import React, { useState, useRef } from 'react';
import {
  X, Link2, FileText, Youtube, Globe, Loader2, CheckCircle, AlertCircle, Sparkles, Mic,
  PlayCircle, XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tab } from '../hooks/usePadTabs';
import { serializeVideoMeta, VideoMeta } from '../lib/videoMeta';
import './AddFromLink.scss';

interface Props {
  onClose: () => void;
  /** Called with the created/updated pad id so App can refetch + select it. */
  onCreated: (id: string) => void;
  tabs: Tab[];
}

interface Ingested {
  title: string;
  markdown: string;
  metadata: Record<string, any>;
  source_type: 'web' | 'pdf' | 'youtube' | 'media';
}

type ActionKey = 'summarize' | 'extractinfo' | 'tags' | 'flashcards' | 'links' | 'rag';

type Source = { kind: 'file'; file: File } | { kind: 'url'; url: string };

interface QueueItem {
  id: string;
  source: Source;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  message?: string;
  padId?: string;
}

const SOURCE_ICON = {
  web: <Globe size={14} />, pdf: <FileText size={14} />, youtube: <Youtube size={14} />, media: <Mic size={14} />,
};

function detectType(url: string): 'youtube' | 'web' {
  return /youtube\.com|youtu\.be/.test(url) ? 'youtube' : 'web';
}

function isMediaFile(f: File): boolean {
  return f.type.startsWith('audio/') || f.type.startsWith('video/');
}

function fmtDate(d?: string): string {
  if (!d) return '';
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(d);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : d;
}

/** Generic SSE consumer for the report-generating endpoints — they all speak
 * the same `{kind: 'progress'|'document'|'error', msg?, content?, error?}`
 * dialect, so a single helper covers both /structure-document and
 * /video-report. */
async function consumeReportStream(
  endpoint: string,
  payload: unknown,
  onProgress: (msg: string) => void,
): Promise<string> {
  const resp = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok || !resp.body) throw new Error(`report error ${resp.status}`);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', doc = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const d = line.slice(6);
      if (d === '[DONE]') continue;
      try {
        const o = JSON.parse(d);
        if (o.kind === 'progress' && o.msg) onProgress(o.msg);
        else if (o.kind === 'document') doc = o.content || '';
        else if (o.kind === 'error') throw new Error(o.error || 'report failed');
      } catch { /* ignore malformed events */ }
    }
  }
  return doc.trim();
}

async function structureDocument(
  content: string, title: string, lang: string, length: string, onProgress: (msg: string) => void,
): Promise<string> {
  // Client-side map-reduce against the local Ollama (Phase 3B). Wraps the
  // aiPrompts.structureDocument helper into the same "progress log + final
  // string" shape the surrounding runActions loop already expects.
  const { structureDocument: runStructure } = await import('../lib/aiPrompts');
  const model = localStorage.getItem('pad-ws-ai-model') || 'llama3.2';
  const L: 'fr' | 'en' = lang === 'fr' ? 'fr' : 'en';
  const LEN: 'short' | 'long' = length === 'short' ? 'short' : 'long';
  let doc = '';
  let lastError: string | null = null;
  await runStructure(model, content, title, L, LEN, (e) => {
    if (e.kind === 'progress' && e.msg) onProgress(e.msg);
    else if (e.kind === 'document') doc = e.content || '';
    else if (e.kind === 'error') lastError = e.error || 'structure failed';
  });
  if (lastError && !doc) throw new Error(lastError);
  return doc.trim();
}

/** Video-specific report: feeds the timestamped transcript + chapters to the
 * dedicated endpoint so the model can cite [MM:SS] anchors. */
async function videoReport(
  ing: Ingested, lang: string, onProgress: (msg: string) => void,
): Promise<string> {
  const md = ing.metadata || {};
  const { videoReport: runVideoReport } = await import('../lib/videoReport');
  const model = localStorage.getItem('pad-ws-ai-model') || 'llama3.2';
  const L: 'fr' | 'en' = lang === 'fr' ? 'fr' : 'en';
  let doc = '';
  let lastError: string | null = null;
  await runVideoReport(model, {
    title: ing.title,
    url: md.source_url,
    description: md.description ?? '',
    author: md.author ?? '',
    duration: md.duration,
    chapters: md.chapters || [],
    transcript_segments: md.transcript_segments || [],
    lang: L,
  }, (e) => {
    if (e.kind === 'progress' && e.msg) onProgress(e.msg);
    else if (e.kind === 'document') doc = e.content || '';
    else if (e.kind === 'error') lastError = e.error || 'video report failed';
  });
  if (lastError && !doc) throw new Error(lastError);
  return doc.trim();
}

export default function AddFromLink({ onClose, onCreated, tabs }: Props) {
  const { i18n } = useTranslation();
  const lang = i18n.language.startsWith('fr') ? 'fr' : 'en';

  const [url, setUrl] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [ingested, setIngested] = useState<Ingested | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'input' | 'preview' | 'processing' | 'done' | 'queue'>('input');
  const [logs, setLogs] = useState<string[]>([]);
  const [transcribing, setTranscribing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [actions, setActions] = useState<Record<ActionKey, boolean>>({
    summarize: true, extractinfo: false, tags: true, flashcards: false, links: false, rag: true,
  });
  const [target, setTarget] = useState<string>('new'); // 'new' | padId
  const [length, setLength] = useState<'short' | 'long'>('long');
  // Speaker diarization: only offered when the server tells us it's set up
  // (pyannote installed + HF_TOKEN present). Silently hidden otherwise so
  // we don't tease a feature the user can't actually enable.
  const [diarizeAvailable, setDiarizeAvailable] = useState<null | { on: boolean; reason?: string }>(null);
  const [diarize, setDiarize] = useState(false);
  React.useEffect(() => {
    fetch('/api/ai/diarization-status')
      .then(r => r.json())
      .then(d => setDiarizeAvailable({ on: !!d.available, reason: d.reason }))
      .catch(() => setDiarizeAvailable({ on: false, reason: 'offline' }));
  }, []);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueRunning, setQueueRunning] = useState(false);

  const toggle = (k: ActionKey) => setActions(a => ({ ...a, [k]: !a[k] }));
  const file = files[0] ?? null;

  /* ── Fetch a single source (file or url) → Ingested. No state side-effects,
   *    so it's usable both for the single-item flow and the batch queue. ── */
  const ingestOne = async (source: Source): Promise<Ingested> => {
    if (source.kind === 'file' && isMediaFile(source.file)) {
      const fd = new FormData();
      fd.append('file', source.file);
      if (diarize) fd.append('diarize', 'true');
      const resp = await fetch('/api/ingest/media/transcribe', { method: 'POST', body: fd });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.detail || `Erreur ${resp.status}`);
      }
      const d = await resp.json();
      return {
        title: source.file.name.replace(/\.[^/.]+$/, ''),
        markdown: d.transcript,
        metadata: {
          filename: source.file.name,
          language: d.language,
          transcript_segments: Array.isArray(d.segments) ? d.segments : [],
          diarized: !!d.diarized,
        },
        source_type: 'media',
      };
    }
    let resp: Response;
    if (source.kind === 'file') {
      const fd = new FormData(); fd.append('file', source.file);
      resp = await fetch('/api/ingest/pdf', { method: 'POST', body: fd });
    } else {
      const type = detectType(source.url);
      resp = await fetch(`/api/ingest/${type}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: source.url }),
      });
    }
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(e.detail || `Erreur ${resp.status}`);
    }
    return await resp.json();
  };

  /* ── Step 1 (single item): ingest ── */
  const ingest = async () => {
    setError(null);
    setLoading(true);
    try {
      const urlLines = url.split('\n').map(s => s.trim()).filter(Boolean);
      const source: Source = file ? { kind: 'file', file } : { kind: 'url', url: urlLines[0] };
      const data = await ingestOne(source);
      setIngested(data);
      setStep('preview');
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  /* ── Whisper: transcribe a captionless video locally ── */
  const transcribe = async () => {
    if (!ingested) return;
    setError(null);
    setTranscribing(true);
    try {
      const r = await fetch('/api/ingest/youtube/transcribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: ingested.metadata.source_url, diarize }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.detail || `Erreur ${r.status}`);
      }
      const d = await r.json();
      // Persist the timestamped segments so the video-report endpoint can
      // consume them; keep the plain transcript in the visible markdown for
      // the source note that gets archived.
      setIngested({
        ...ingested,
        markdown: `${ingested.markdown}\n\n## Transcription (Whisper)\n\n${d.transcript}`,
        metadata: {
          ...ingested.metadata,
          has_transcript: true,
          transcript_segments: Array.isArray(d.segments) ? d.segments : (ingested.metadata.transcript_segments || []),
          whisper_language: d.language,
        },
      });
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setTranscribing(false);
    }
  };

  /* ── Markdown builders ── */
  const buildHeader = (ing: Ingested): string => {
    const md = ing.metadata || {};
    const src = md.source_url ? `🔗 [${md.source_url}](${md.source_url})` : '';
    const author = md.author ? ` · 👤 ${md.author}` : '';
    const date = md.upload_date ? ` · 📅 ${fmtDate(md.upload_date)}` : '';
    return `> [!NOTE] Source\n> ${[src].filter(Boolean).join('')}${author}${date}`;
  };

  // The clean digest note. The raw transcript lives in a separate source note
  // (in the "Sources" folder) that we wikilink to — keeping this note readable.
  //
  // For YouTube sources we also emit an `<!-- alcove:video … -->` comment as
  // the very first line so DocumentPad can mount the inline player and turn
  // `[MM:SS]` anchors into jump-to-time buttons. The comment is invisible in
  // the rendered preview (browsers hide comment nodes).
  const buildDigest = (ing: Ingested, body: string, sourceTitle: string): string => {
    const md = ing.metadata || {};
    const parts: string[] = [];
    if (ing.source_type === 'youtube') {
      const meta: VideoMeta = {
        id: md.video_id || undefined,
        url: md.source_url || undefined,
        thumbnail: md.thumbnail || undefined,
        duration: typeof md.duration === 'number' ? md.duration : undefined,
        author: md.author || undefined,
        chapters: Array.isArray(md.chapters) ? md.chapters : undefined,
      };
      if (meta.id || meta.url) parts.push(serializeVideoMeta(meta));
    }
    parts.push(`# ${ing.title}`);
    parts.push(buildHeader(ing));
    if (body) parts.push(body);
    parts.push('## Notes\n\n');
    parts.push(`---\n\n> 📄 Source complète (transcript brut) : [[${sourceTitle}]]`);
    return parts.join('\n\n');
  };

  // The source note: the full raw content, archived and citable.
  const buildSourceNote = (ing: Ingested): string => {
    const label = ing.source_type === 'youtube' || ing.source_type === 'media' ? 'Transcript' : 'Contenu brut';
    return [`# ${ing.title} — source`, buildHeader(ing), `## ${label}\n\n${ing.markdown}`].join('\n\n');
  };

  const log = (s: string) => setLogs(l => [...l, s]);

  /* ── Shared: summarize + extract-info + archive source note + flashcards +
   *    links → final Markdown content, ready to be written into a pad.
   *    Used by both the single-item flow and the batch queue. ── */
  const buildContent = async (
    ing: Ingested, actionsSel: Record<ActionKey, boolean>, len: 'short' | 'long', onStep: (s: string) => void,
  ): Promise<string> => {
    let body = '';
    if (actionsSel.summarize) {
      // Video sources get the dedicated pipeline: chapter-aware chunking,
      // timestamped citations, quotes with anchor points. Falls back to the
      // generic map-reduce if there are no transcript segments (rare).
      const md = ing.metadata || {};
      const hasVideoSegments = ing.source_type === 'youtube'
        && Array.isArray(md.transcript_segments)
        && md.transcript_segments.length > 0;
      if (hasVideoSegments) {
        onStep('🎬 Analyse vidéo (avec timestamps)…');
        try {
          body = await videoReport(ing, lang, onStep);
        } catch (e) {
          onStep('  ⚠️ Rapport vidéo indisponible, retour au mode générique');
          body = await structureDocument(ing.markdown, ing.title, lang, len, onStep);
        }
      } else {
        onStep('✨ Analyse structurée…');
        body = await structureDocument(ing.markdown, ing.title, lang, len, onStep);
      }
    }

    if (actionsSel.extractinfo) {
      onStep('📋 Extraction des infos clés…');
      try {
        const { extractInfo } = await import('../lib/aiPrompts');
        const model = localStorage.getItem('pad-ws-ai-model') || 'llama3.2';
        const { info } = await extractInfo(model, ing.markdown, lang as 'fr' | 'en');
        if (info) body += `\n\n## Infos clés\n\n${info}`;
      } catch { onStep('  ⚠️ Infos clés indisponibles'); }
    }

    // Archive the raw content as a separate "source" note in a Sources folder,
    // wikilinked from the digest.
    onStep('🗂️ Note source (transcript)…');
    const sourceTitle = `${ing.title} — source`.slice(0, 100);
    try {
      const sr = await fetch('/api/pad/new', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pad_type: 'document', display_name: sourceTitle }),
      });
      if (sr.ok) {
        const sourceId = (await sr.json()).id;
        await fetch(`/api/pad/${sourceId}/doc`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: buildSourceNote(ing), format: 'markdown' }),
        });
        await fetch(`/api/pad/${sourceId}/folder`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: 'Sources' }),
        });
      }
    } catch { onStep('  ⚠️ Note source non créée'); }

    let content = buildDigest(ing, body, sourceTitle);

    if (actionsSel.flashcards) {
      onStep('🧠 Génération de flashcards…');
      try {
        const { generateFlashcards } = await import('../lib/aiPrompts');
        const model = localStorage.getItem('pad-ws-ai-model') || 'llama3.2';
        const cards = await generateFlashcards(model, ing.markdown, lang as 'fr' | 'en');
        if (cards) content += `\n\n---\n\n## Flashcards\n\n${cards}`;
      } catch { onStep('  ⚠️ Flashcards indisponibles'); }
    }

    if (actionsSel.links && tabs.length) {
      onStep('🔗 Recherche de liens…');
      try {
        const { suggestLinks } = await import('../lib/aiPrompts');
        const model = localStorage.getItem('pad-ws-ai-model') || 'llama3.2';
        const suggs = await suggestLinks(model, ing.markdown, tabs.map(t => t.title), lang as 'fr' | 'en');
        if (suggs.length) content += `\n\n## Liens\n\n${suggs.map(s => `- [[${s}]]`).join('\n')}`;
      } catch { onStep('  ⚠️ Liens indisponibles'); }
    }

    return content;
  };

  /* ── Shared: tags + RAG indexing, applied after a pad already exists. ── */
  const applyPostActions = async (
    padId: string, ing: Ingested, actionsSel: Record<ActionKey, boolean>, onStep: (s: string) => void,
  ): Promise<void> => {
    if (actionsSel.tags) {
      onStep('🏷️ Tags automatiques…');
      try {
        const { suggestTags } = await import('../lib/aiPrompts');
        const model = localStorage.getItem('pad-ws-ai-model') || 'llama3.2';
        const tags = await suggestTags(model, ing.markdown, ing.title, lang as 'fr' | 'en');
        if (tags.length) {
          await fetch(`/api/pad/${padId}/tags`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags }),
          });
        }
      } catch { onStep('  ⚠️ Tags indisponibles'); }
    }

    if (actionsSel.rag) {
      onStep('📇 Indexation RAG…');
      try {
        const { indexPad } = await import('../lib/rag');
        await indexPad(padId);
      } catch { onStep('  ⚠️ Indexation indisponible'); }
    }
  };

  /* ── Step 2 (single item): create pad + run actions ── */
  const run = async () => {
    if (!ingested) return;
    setStep('processing');
    setLogs([]);
    try {
      const content = await buildContent(ingested, actions, length, log);

      let padId: string;
      if (target === 'new') {
        log('📄 Création du pad…');
        const cr = await fetch('/api/pad/new', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pad_type: 'document', display_name: ingested.title.slice(0, 100) }),
        });
        if (!cr.ok) throw new Error('Création du pad échouée');
        padId = (await cr.json()).id;
        await fetch(`/api/pad/${padId}/doc`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, format: 'markdown' }),
        });
      } else {
        log('📄 Ajout au pad existant…');
        padId = target;
        const cur = await fetch(`/api/pad/${padId}`).then(r => r.json()).catch(() => ({}));
        const prev = (cur?.data?.content ?? cur?.content ?? '') as string;
        await fetch(`/api/pad/${padId}/doc`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `${prev}\n\n${content}`, format: 'markdown' }),
        });
      }

      await applyPostActions(padId, ingested, actions, log);
      await persistVideoMeta(padId, ingested);

      log('✅ Terminé');
      setStep('done');
      onCreated(padId);
    } catch (e: any) {
      setError(e.message || String(e));
      setStep('preview');
    }
  };

  /** Attach the video block (chapters + segments + ids) to a pad so the
   * DocumentPad Regenerate button can re-run /video-report without needing
   * to re-hit YouTube. No-op for non-video ingests. */
  const persistVideoMeta = async (padId: string, ing: Ingested): Promise<void> => {
    const md = ing.metadata || {};
    const hasSegments = Array.isArray(md.transcript_segments) && md.transcript_segments.length > 0;
    if (ing.source_type !== 'youtube' && ing.source_type !== 'media') return;
    if (!hasSegments && !md.video_id) return;
    try {
      await fetch(`/api/pad/${padId}/video-meta`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_id: md.video_id ?? null,
          url: md.source_url ?? null,
          thumbnail: md.thumbnail ?? null,
          duration: typeof md.duration === 'number' ? md.duration : null,
          author: md.author ?? null,
          chapters: md.chapters ?? null,
          transcript_segments: md.transcript_segments ?? null,
          language: md.language ?? md.whisper_language ?? null,
          diarized: md.diarized ?? null,
        }),
      });
    } catch { /* non-fatal — regenerate button will fall back to a plain re-fetch */ }
  };

  /* ── Batch: ingest + process one queue item into its own new pad. ── */
  const processOne = async (
    ing: Ingested, onStep: (s: string) => void,
  ): Promise<string> => {
    const content = await buildContent(ing, actions, length, onStep);
    onStep('📄 Création du pad…');
    const cr = await fetch('/api/pad/new', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad_type: 'document', display_name: ing.title.slice(0, 100) }),
    });
    if (!cr.ok) throw new Error('Création du pad échouée');
    const padId = (await cr.json()).id;
    await fetch(`/api/pad/${padId}/doc`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, format: 'markdown' }),
    });
    await applyPostActions(padId, ing, actions, onStep);
    return padId;
  };

  const updateQueueItem = (id: string, patch: Partial<QueueItem>) => {
    setQueue(q => q.map(it => (it.id === id ? { ...it, ...patch } : it)));
  };

  /* ── Build the queue from selected files + pasted URL lines, and show it. ── */
  const startQueue = () => {
    const urlLines = url.split('\n').map(s => s.trim()).filter(Boolean);
    const items: QueueItem[] = [
      ...files.map((f, i) => ({
        id: `f${i}`, source: { kind: 'file', file: f } as Source, label: f.name, status: 'pending' as const,
      })),
      ...urlLines.map((u, i) => ({
        id: `u${i}`, source: { kind: 'url', url: u } as Source, label: u, status: 'pending' as const,
      })),
    ];
    setQueue(items);
    setStep('queue');
  };

  /* ── Process the queue sequentially — one item at a time, matching the
   *    backend's whisper lock (concurrent transcriptions don't parallelize on
   *    CPU, they just contend). Each item gets its own pad. ── */
  const runQueue = async () => {
    setQueueRunning(true);
    for (const item of queue) {
      updateQueueItem(item.id, { status: 'running', message: 'Ingestion…' });
      try {
        const ing = await ingestOne(item.source);
        const padId = await processOne(ing, msg => updateQueueItem(item.id, { message: msg }));
        updateQueueItem(item.id, { status: 'done', message: undefined, padId });
      } catch (e: any) {
        updateQueueItem(item.id, { status: 'error', message: e.message || String(e) });
      }
    }
    setQueueRunning(false);
  };

  const m = ingested?.metadata || {};
  const urlLineCount = url.split('\n').map(s => s.trim()).filter(Boolean).length;
  const totalSelected = files.length + urlLineCount;
  const queueDone = queue.length > 0 && queue.every(it => it.status === 'done' || it.status === 'error');

  return (
    <div className="addlink__backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="addlink__panel" role="dialog">
        <div className="addlink__header">
          <span className="addlink__title"><Link2 size={14} /> Ajouter depuis un lien</span>
          <button className="addlink__close" onClick={onClose}><X size={14} /></button>
        </div>

        {step === 'input' && (
          <div className="addlink__body">
            <label className="addlink__label">Liens (page web ou vidéo YouTube — un par ligne)</label>
            <div className="addlink__url-row">
              <textarea
                className="addlink__input"
                placeholder={'https://…\nun lien par ligne pour traiter plusieurs contenus'}
                value={url}
                autoFocus
                onChange={e => setUrl(e.target.value)}
              />
            </div>
            <div className="addlink__or">et/ou</div>
            <button className="addlink__file-btn" onClick={() => fileRef.current?.click()}>
              {file && isMediaFile(file) ? <Mic size={14} /> : <FileText size={14} />}
              {files.length === 0 && 'Choisir un ou plusieurs fichiers (PDF, audio, vidéo)'}
              {files.length === 1 && files[0].name}
              {files.length > 1 && `${files.length} fichiers sélectionnés`}
            </button>
            <input
              ref={fileRef} type="file" multiple accept="application/pdf,audio/*,video/*" style={{ display: 'none' }}
              onChange={e => { setFiles(Array.from(e.target.files || [])); }}
            />
            {files.some(isMediaFile) && (
              <div className="addlink__hint-row">🎙️ Transcription locale (Whisper) — peut prendre un moment selon la durée.</div>
            )}
            {totalSelected > 1 && (
              <div className="addlink__hint-row">📋 {totalSelected} éléments seront traités en file, un par un.</div>
            )}
            {error && <div className="addlink__error"><AlertCircle size={12} /> {error}</div>}
            <div className="addlink__footer">
              <button
                className="addlink__primary"
                disabled={loading || totalSelected === 0}
                onClick={() => (totalSelected > 1 ? startQueue() : ingest())}
              >
                {loading
                  ? <><Loader2 size={14} className="addlink__spin" /> {file && isMediaFile(file) ? 'Transcription…' : 'Analyse…'}</>
                  : <>Analyser{totalSelected > 1 ? ` (${totalSelected})` : ''}</>}
              </button>
            </div>
          </div>
        )}

        {step === 'preview' && ingested && (
          <div className="addlink__body">
            <div className="addlink__preview">
              <div className="addlink__preview-type">{SOURCE_ICON[ingested.source_type]} {ingested.source_type}</div>
              <div className="addlink__preview-title">{ingested.title}</div>
              <div className="addlink__preview-meta">
                {m.author && <span>👤 {m.author}</span>}
                {m.upload_date && <span>📅 {fmtDate(m.upload_date)}</span>}
                {ingested.source_type === 'youtube' && <span>{m.has_transcript ? '📝 transcription OK' : '⚠️ pas de sous-titres'}</span>}
                {ingested.source_type === 'media' && m.language && <span>🌐 {m.language}</span>}
                <span>{Math.round(ingested.markdown.length / 1000)}k caractères</span>
              </div>
              <div className="addlink__preview-snippet">{ingested.markdown.slice(0, 240)}…</div>
              {ingested.source_type === 'youtube' && (
                <button className="addlink__whisper" disabled={transcribing} onClick={transcribe}>
                  {transcribing
                    ? <><Loader2 size={13} className="addlink__spin" /> Transcription locale…</>
                    : <><Mic size={13} /> {m.has_transcript
                        ? 'Forcer une transcription Whisper (plus fiable)'
                        : 'Transcrire la vidéo (Whisper, local)'}</>}
                </button>
              )}
            </div>

            <label className="addlink__label">Longueur du résumé</label>
            <div className="addlink__seg">
              <button className={`addlink__seg-btn${length === 'short' ? ' addlink__seg-btn--on' : ''}`} onClick={() => setLength('short')}>Court</button>
              <button className={`addlink__seg-btn${length === 'long' ? ' addlink__seg-btn--on' : ''}`} onClick={() => setLength('long')}>Détaillé</button>
            </div>

            {/* Speaker diarization: only shown when pyannote + HF_TOKEN are
                set up server-side. Hidden entirely otherwise — no point
                offering a checkbox the user can't tick meaningfully. */}
            {diarizeAvailable?.on && (
              <>
                <label className="addlink__label">Intervenants</label>
                <label className={`addlink__action${diarize ? ' addlink__action--on' : ''}`}>
                  <input type="checkbox" checked={diarize} onChange={e => setDiarize(e.target.checked)} />
                  🎙️ Détecter les intervenants (Whisper + pyannote — ajoute ~30s / minute audio)
                </label>
              </>
            )}

            <label className="addlink__label">Que veux-tu en faire ?</label>
            <div className="addlink__actions">
              {([
                ['summarize', '✨ Résumé IA'],
                ['extractinfo', '📋 Infos clés'],
                ['tags', '🏷️ Tags auto'],
                ['flashcards', '🧠 Flashcards'],
                ['links', '🔗 Liens suggérés'],
                ['rag', '📇 Ajouter au RAG'],
              ] as [ActionKey, string][]).map(([k, label]) => (
                <label key={k} className={`addlink__action${actions[k] ? ' addlink__action--on' : ''}`}>
                  <input type="checkbox" checked={actions[k]} onChange={() => toggle(k)} />
                  {label}
                </label>
              ))}
            </div>

            <label className="addlink__label">Destination</label>
            <select className="addlink__select" value={target} onChange={e => setTarget(e.target.value)}>
              <option value="new">➕ Nouveau pad</option>
              {tabs.filter(t => t.padType === 'document').map(t => (
                <option key={t.id} value={t.id}>↳ Ajouter à : {t.title}</option>
              ))}
            </select>

            {error && <div className="addlink__error"><AlertCircle size={12} /> {error}</div>}
            <div className="addlink__footer">
              <button className="addlink__ghost" onClick={() => { setStep('input'); setIngested(null); }}>Retour</button>
              <button className="addlink__primary" onClick={run}>
                <Sparkles size={14} /> Créer
              </button>
            </div>
          </div>
        )}

        {step === 'queue' && (
          <div className="addlink__body">
            <label className="addlink__label">File d'attente ({queue.length} éléments)</label>
            <div className="addlink__queue">
              {queue.map(item => (
                <div key={item.id} className={`addlink__queue-item addlink__queue-item--${item.status}`}>
                  <span className="addlink__queue-icon">
                    {item.status === 'done' && <CheckCircle size={13} className="addlink__log-ok" />}
                    {item.status === 'error' && <XCircle size={13} className="addlink__queue-err" />}
                    {item.status === 'running' && <Loader2 size={13} className="addlink__spin" />}
                    {item.status === 'pending' && (item.source.kind === 'file' ? <FileText size={13} /> : <Link2 size={13} />)}
                  </span>
                  <span className="addlink__queue-label" title={item.label}>{item.label}</span>
                  {item.status === 'done' && item.padId && (
                    <button className="addlink__queue-open" onClick={() => onCreated(item.padId!)}>Ouvrir</button>
                  )}
                  {item.message && <span className="addlink__queue-msg">{item.message}</span>}
                </div>
              ))}
            </div>

            <label className="addlink__label">Longueur du résumé</label>
            <div className="addlink__seg">
              <button className={`addlink__seg-btn${length === 'short' ? ' addlink__seg-btn--on' : ''}`} onClick={() => setLength('short')} disabled={queueRunning}>Court</button>
              <button className={`addlink__seg-btn${length === 'long' ? ' addlink__seg-btn--on' : ''}`} onClick={() => setLength('long')} disabled={queueRunning}>Détaillé</button>
            </div>

            <label className="addlink__label">Que veux-tu en faire ? (appliqué à chaque élément)</label>
            <div className="addlink__actions">
              {([
                ['summarize', '✨ Résumé IA'],
                ['extractinfo', '📋 Infos clés'],
                ['tags', '🏷️ Tags auto'],
                ['flashcards', '🧠 Flashcards'],
                ['links', '🔗 Liens suggérés'],
                ['rag', '📇 Ajouter au RAG'],
              ] as [ActionKey, string][]).map(([k, label]) => (
                <label key={k} className={`addlink__action${actions[k] ? ' addlink__action--on' : ''}`}>
                  <input type="checkbox" checked={actions[k]} disabled={queueRunning} onChange={() => toggle(k)} />
                  {label}
                </label>
              ))}
            </div>

            {error && <div className="addlink__error"><AlertCircle size={12} /> {error}</div>}
            <div className="addlink__footer">
              <button className="addlink__ghost" disabled={queueRunning} onClick={() => { setStep('input'); setQueue([]); }}>Retour</button>
              {queueDone ? (
                <button className="addlink__primary" onClick={onClose}>Fermer</button>
              ) : (
                <button className="addlink__primary" disabled={queueRunning} onClick={runQueue}>
                  <PlayCircle size={14} /> {queueRunning ? 'File en cours…' : 'Lancer la file'}
                </button>
              )}
            </div>
          </div>
        )}

        {(step === 'processing' || step === 'done') && (
          <div className="addlink__body">
            <div className="addlink__logs">
              {logs.map((l, i) => (
                <div key={i} className="addlink__log">
                  {i === logs.length - 1 && step === 'processing'
                    ? <Loader2 size={12} className="addlink__spin" />
                    : <CheckCircle size={12} className="addlink__log-ok" />}
                  {l}
                </div>
              ))}
            </div>
            {step === 'done' && (
              <div className="addlink__footer">
                <span className="addlink__done-msg">Pad créé ✓</span>
                <button className="addlink__primary" onClick={onClose}>Ouvrir</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
