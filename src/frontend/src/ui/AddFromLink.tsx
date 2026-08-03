import React, { useState, useRef } from 'react';
import { X, Link2, FileText, Youtube, Globe, Loader2, CheckCircle, AlertCircle, Sparkles, Mic } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tab } from '../hooks/usePadTabs';
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
  source_type: 'web' | 'pdf' | 'youtube';
}

type ActionKey = 'summarize' | 'extractinfo' | 'tags' | 'flashcards' | 'links' | 'rag';

const SOURCE_ICON = {
  web: <Globe size={14} />, pdf: <FileText size={14} />, youtube: <Youtube size={14} />,
};

function detectType(url: string): 'youtube' | 'web' {
  return /youtube\.com|youtu\.be/.test(url) ? 'youtube' : 'web';
}

function fmtDate(d?: string): string {
  if (!d) return '';
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(d);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : d;
}

// Consume the /api/ai/structure-document SSE stream (map-reduce): forwards
// progress messages and returns the final structured Markdown body.
async function structureDocument(
  content: string, title: string, lang: string, length: string, onProgress: (msg: string) => void,
): Promise<string> {
  const resp = await fetch('/api/ai/structure-document', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, title, lang, length }),
  });
  const reader = resp.body!.getReader();
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
      } catch { /* ignore */ }
    }
  }
  return doc.trim();
}

export default function AddFromLink({ onClose, onCreated, tabs }: Props) {
  const { i18n } = useTranslation();
  const lang = i18n.language.startsWith('fr') ? 'fr' : 'en';

  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [ingested, setIngested] = useState<Ingested | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'input' | 'preview' | 'processing' | 'done'>('input');
  const [logs, setLogs] = useState<string[]>([]);
  const [transcribing, setTranscribing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [actions, setActions] = useState<Record<ActionKey, boolean>>({
    summarize: true, extractinfo: false, tags: true, flashcards: false, links: false, rag: true,
  });
  const [target, setTarget] = useState<string>('new'); // 'new' | padId
  const [length, setLength] = useState<'short' | 'long'>('long');

  const toggle = (k: ActionKey) => setActions(a => ({ ...a, [k]: !a[k] }));

  /* ── Step 1: ingest ── */
  const ingest = async () => {
    setError(null);
    setLoading(true);
    try {
      let resp: Response;
      if (file) {
        const fd = new FormData(); fd.append('file', file);
        resp = await fetch('/api/ingest/pdf', { method: 'POST', body: fd });
      } else {
        const clean = url.trim();
        if (!clean) { setLoading(false); return; }
        const type = detectType(clean);
        resp = await fetch(`/api/ingest/${type}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: clean }),
        });
      }
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.detail || `Erreur ${resp.status}`);
      }
      const data: Ingested = await resp.json();
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
        body: JSON.stringify({ url: ingested.metadata.source_url }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.detail || `Erreur ${r.status}`);
      }
      const d = await r.json();
      setIngested({
        ...ingested,
        markdown: `${ingested.markdown}\n\n## Transcription (Whisper)\n\n${d.transcript}`,
        metadata: { ...ingested.metadata, has_transcript: true },
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
  const buildDigest = (ing: Ingested, body: string, sourceTitle: string): string => {
    const parts = [`# ${ing.title}`, buildHeader(ing)];
    if (body) parts.push(body);
    parts.push('## Notes\n\n');
    parts.push(`---\n\n> 📄 Source complète (transcript brut) : [[${sourceTitle}]]`);
    return parts.join('\n\n');
  };

  // The source note: the full raw content, archived and citable.
  const buildSourceNote = (ing: Ingested): string => {
    const label = ing.source_type === 'youtube' ? 'Transcript' : 'Contenu brut';
    return [`# ${ing.title} — source`, buildHeader(ing), `## ${label}\n\n${ing.markdown}`].join('\n\n');
  };

  const log = (s: string) => setLogs(l => [...l, s]);

  /* ── Step 2: create pad + run actions ── */
  const run = async () => {
    if (!ingested) return;
    setStep('processing');
    setLogs([]);
    try {
      // 1. Structured summary via map-reduce (one AI per portion + a mother AI).
      let body = '';
      if (actions.summarize) {
        log('✨ Analyse structurée…');
        body = await structureDocument(ingested.markdown, ingested.title, lang, length, log);
      }

      // 1b. Optional key-info extraction (people / theme / sources).
      if (actions.extractinfo) {
        log('📋 Extraction des infos clés…');
        try {
          const r = await fetch('/api/ai/extract-info', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: ingested.markdown, lang }),
          });
          const d = await r.json();
          if (d.info) body += `\n\n## Infos clés\n\n${d.info}`;
        } catch { log('  ⚠️ Infos clés indisponibles'); }
      }

      // 1c. Archive the raw content as a separate "source" note in a Sources
      // folder, wikilinked from the digest (the user's idea).
      log('🗂️ Note source (transcript)…');
      const sourceTitle = `${ingested.title} — source`.slice(0, 100);
      try {
        const sr = await fetch('/api/pad/new', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pad_type: 'document', display_name: sourceTitle }),
        });
        if (sr.ok) {
          const sourceId = (await sr.json()).id;
          await fetch(`/api/pad/${sourceId}/doc`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: buildSourceNote(ingested), format: 'markdown' }),
          });
          await fetch(`/api/pad/${sourceId}/folder`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: 'Sources' }),
          });
        }
      } catch { log('  ⚠️ Note source non créée'); }

      // Assemble the clean digest (links to the source note).
      let content = buildDigest(ingested, body, sourceTitle);

      // 2. Optional flashcards → appended.
      if (actions.flashcards) {
        log('🧠 Génération de flashcards…');
        try {
          const r = await fetch('/api/ai/generate-flashcards', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: ingested.markdown, lang }),
          });
          const d = await r.json();
          if (d.flashcards) content += `\n\n---\n\n## Flashcards\n\n${d.flashcards}`;
        } catch { log('  ⚠️ Flashcards indisponibles'); }
      }

      // 3. Optional suggested links → appended.
      if (actions.links && tabs.length) {
        log('🔗 Recherche de liens…');
        try {
          const r = await fetch('/api/ai/suggest-links', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: ingested.markdown, pad_titles: tabs.map(t => t.title), lang }),
          });
          const d = await r.json();
          const suggs: string[] = d.suggestions ?? [];
          if (suggs.length) content += `\n\n## Liens\n\n${suggs.map(s => `- [[${s}]]`).join('\n')}`;
        } catch { log('  ⚠️ Liens indisponibles'); }
      }

      // 4. Create a new pad, or append to an existing one.
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

      // 5. Optional auto-tags.
      if (actions.tags) {
        log('🏷️ Tags automatiques…');
        try {
          const r = await fetch('/api/ai/suggest-tags', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: ingested.markdown, title: ingested.title, lang }),
          });
          const d = await r.json();
          const tags: string[] = d.tags ?? [];
          if (tags.length) {
            await fetch(`/api/pad/${padId}/tags`, {
              method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tags }),
            });
          }
        } catch { log('  ⚠️ Tags indisponibles'); }
      }

      // 6. Optional RAG indexing.
      if (actions.rag) {
        log('📇 Indexation RAG…');
        try {
          await fetch('/api/ai/index', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pad_id: padId }),
          });
        } catch { log('  ⚠️ Indexation indisponible'); }
      }

      log('✅ Terminé');
      setStep('done');
      onCreated(padId);
    } catch (e: any) {
      setError(e.message || String(e));
      setStep('preview');
    }
  };

  const m = ingested?.metadata || {};

  return (
    <div className="addlink__backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="addlink__panel" role="dialog">
        <div className="addlink__header">
          <span className="addlink__title"><Link2 size={14} /> Ajouter depuis un lien</span>
          <button className="addlink__close" onClick={onClose}><X size={14} /></button>
        </div>

        {step === 'input' && (
          <div className="addlink__body">
            <label className="addlink__label">Lien (page web ou vidéo YouTube)</label>
            <div className="addlink__url-row">
              <input
                className="addlink__input"
                placeholder="https://…"
                value={url}
                autoFocus
                onChange={e => { setUrl(e.target.value); setFile(null); }}
                onKeyDown={e => { if (e.key === 'Enter' && url.trim()) ingest(); }}
              />
            </div>
            <div className="addlink__or">ou</div>
            <button className="addlink__file-btn" onClick={() => fileRef.current?.click()}>
              <FileText size={14} /> {file ? file.name : 'Choisir un fichier PDF'}
            </button>
            <input
              ref={fileRef} type="file" accept="application/pdf" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) { setFile(f); setUrl(''); } }}
            />
            {error && <div className="addlink__error"><AlertCircle size={12} /> {error}</div>}
            <div className="addlink__footer">
              <button
                className="addlink__primary"
                disabled={loading || (!url.trim() && !file)}
                onClick={ingest}
              >
                {loading ? <><Loader2 size={14} className="addlink__spin" /> Analyse…</> : <>Analyser</>}
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
