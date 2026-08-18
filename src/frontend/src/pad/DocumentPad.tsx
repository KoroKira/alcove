import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Editor, { loader } from '@monaco-editor/react';
// Bundle only Monaco's core editor API (+ markdown highlighting) instead of the
// full package (all 60+ languages OOMs the build). This local instance is shared
// with monaco-vim and works offline (PWA), and stays in the lazy DocumentPad chunk.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution'; // syntax highlighting (incl. markdown)
import { initVimMode } from 'monaco-vim';

// Markdown/LaTeX need no language worker; stub it to silence the worker error.
(self as any).MonacoEnvironment = { getWorker: () => ({ postMessage() {}, terminate() {}, addEventListener() {}, removeEventListener() {} }) };
loader.config({ monaco });
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import mermaid from 'mermaid';
import { Link, History, Bookmark, Download, FileText, List, Maximize2, Minimize2, BookOpen, Save, Play, Globe, Terminal, Sparkles } from 'lucide-react';
import { useRelatedPads } from '../hooks/useRelatedPads';
import { readVideoMeta, stripVideoMeta, parseTimestamp, replaceReportBody } from '../lib/videoMeta';
import VideoEmbed, { VideoEmbedHandle } from '../ui/VideoEmbed';

/** Server-persisted video block: transcript segments + chapters + language.
 * Distinct from `readVideoMeta` (which parses the inline HTML comment): this
 * one carries the heavy `transcript_segments` array needed to re-run
 * /api/ai/video-report from a Regenerate click. Loaded from
 * pad.data.video (see pad_router `/{id}/video-meta`). */
interface StoredVideoBundle {
  video_id?: string | null;
  url?: string | null;
  thumbnail?: string | null;
  duration?: number | null;
  author?: string | null;
  chapters?: Array<{ title: string; start_time?: number | null; end_time?: number | null }> | null;
  transcript_segments?: Array<{ start: number; end: number; text: string; speaker?: string | null }> | null;
  language?: string | null;
  diarized?: boolean | null;
}
import { saveUserTemplate } from '../constants/userTemplates';
import { registerSlashCommands } from '../lib/slashCommands';
import HistoryPanel from './HistoryPanel';
import 'katex/dist/katex.min.css';
import './DocumentPad.scss';
import { Tab } from '../hooks/usePadTabs';

interface Backlink { id: string; display_name: string; pad_type: string; }
interface Transcluded { [padId: string]: string; }
interface TocItem { level: number; text: string; slug: string; }

interface Props {
  padId: string;
  theme?: 'light' | 'dark';
  globalThemeDark?: boolean;
  /** 'markdown' (default) or 'latex' for LaTeX/Overleaf mode */
  format?: 'markdown' | 'latex';
  tabs?: Tab[];
  onSelectPad?: (padId: string) => void;
  focusMode?: boolean;
  onToggleFocus?: () => void;
  pendingContent?: string | null;
  onContentLoaded?: () => void;
  onContentChange?: (content: string) => void;
  /** When set, appends this string to the editor content (then resets to null) */
  contentToAppend?: string | null;
  onContentAppended?: () => void;
}

type ViewMode = 'edit' | 'split' | 'preview';

const SAVE_DEBOUNCE_MS = 800;

const CALLOUT_DEFS: Record<string, { icon: string; label: string }> = {
  NOTE:      { icon: 'ℹ️',  label: 'Note' },
  TIP:       { icon: '💡', label: 'Astuce' },
  WARNING:   { icon: '⚠️', label: 'Attention' },
  IMPORTANT: { icon: '❗', label: 'Important' },
  CAUTION:   { icon: '🛑', label: 'Danger' },
};

const CALLOUT_PATTERN = /^((?:>[ \t]?[^\n]*(?:\n|$))+)/gm;

function extractCallouts(text: string, store: string[]): string {
  return text.replace(CALLOUT_PATTERN, (block) => {
    const match = block.match(/^>[ \t]*\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]/im);
    if (!match) return block;
    const type = match[1].toUpperCase();
    const id = store.length;
    const lines = block.trimEnd().split('\n');
    const bodyLines = lines.map((l, i) =>
      i === 0
        ? l.replace(/^>[ \t]*\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\][ \t]*/i, '')
        : l.replace(/^>[ \t]?/, '')
    );
    const body = bodyLines.join('\n').trim();
    const def = CALLOUT_DEFS[type];
    const bodyHtml = DOMPurify.sanitize(marked.parse(body, { async: false }) as string);
    store.push(
      `<div class="callout callout--${type.toLowerCase()}">`
      + `<div class="callout__title"><span class="callout__icon">${def.icon}</span> ${def.label}</div>`
      + `<div class="callout__body">${bodyHtml}</div></div>`
    );
    return `CALLOUT_BLOCK_${id}_END\n`;
  });
}

function restoreCallouts(html: string, store: string[]): string {
  store.forEach((block, id) => {
    html = html.replace(`<p>CALLOUT_BLOCK_${id}_END</p>`, block);
    html = html.replace(`CALLOUT_BLOCK_${id}_END`, block);
  });
  return html;
}

function addHeadingIds(html: string): string {
  return html.replace(/<h([2-4])>([\s\S]*?)<\/h\1>/g, (_, level, content) => {
    const text = content.replace(/<[^>]+>/g, '');
    const slug = text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    return `<h${level} id="toc-${slug}">${content}</h${level}>`;
  });
}

function extractToc(md: string): TocItem[] {
  const re = /^(#{2,4})\s+(.+)$/gm;
  const items: TocItem[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const text = m[2].trim().replace(/\*\*|__|\*|_|`/g, '');
    const slug = text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    items.push({ level: m[1].length, text, slug });
  }
  return items;
}

// Render markdown + KaTeX math (no transclusion / callouts — for transcluded content)
const renderInner = (text: string, tabs: Tab[]): string => {
  if (!text) return '';
  const callouts: string[] = [];
  let p = extractCallouts(text, callouts);
  const mathBlocks: string[] = [];
  p = p.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => {
    const id = mathBlocks.length;
    try { mathBlocks.push(`<div class="katex-block">${katex.renderToString(m.trim(), { displayMode: true, throwOnError: false })}</div>`); }
    catch { mathBlocks.push(`<div class="katex-error">$$${m}$$</div>`); }
    return `MB_${id}_`;
  });
  p = p.replace(/\$([^$\n]{1,200}?)\$/g, (_, m) => {
    const id = mathBlocks.length;
    try { mathBlocks.push(`<span class="katex-inline">${katex.renderToString(m.trim(), { throwOnError: false })}</span>`); }
    catch { mathBlocks.push(`<span class="katex-error">$${m}$</span>`); }
    return `MI_${id}_`;
  });
  p = p.replace(/\[\[([^\]]+)\]\]/g, (_, name) => {
    const target = tabs.find(t => t.title.toLowerCase() === name.toLowerCase());
    return target
      ? `<a class="wikilink wikilink--found" data-pad-id="${target.id}">${name}</a>`
      : `<span class="wikilink wikilink--missing">${name}</span>`;
  });
  let html = DOMPurify.sanitize(marked.parse(p, { async: false }) as string, { ADD_ATTR: ['data-pad-id', 'class', 'id'] });
  mathBlocks.forEach((mh, id) => { html = html.replace(`MB_${id}_`, mh).replace(`MI_${id}_`, mh); });
  html = restoreCallouts(html, callouts);
  return html;
};

const renderContent = (text: string, tabs: Tab[], transcluded: Transcluded = {}): string => {
  if (!text) return '';

  // === Flashcards Q:/A: blocks (extract before markdown) ===
  const flashDecks: { q: string; a: string }[][] = [];
  let processed = text.replace(
    /((?:^Q:[ \t]*[^\n]+\n^A:[ \t]*[^\n]+\n?)+)/gm,
    (block) => {
      const deckId = flashDecks.length;
      const pairs = [...block.matchAll(/^Q:[ \t]*([^\n]+)\n^A:[ \t]*([^\n]+)/gm)]
        .map(m => ({ q: m[1].trim(), a: m[2].trim() }));
      if (pairs.length > 0) {
        flashDecks.push(pairs);
        return `FLASHDECK_${deckId}_END\n`;
      }
      return block;
    }
  );

  // === Habit tracker items (extract before markdown) ===
  const habitItems: { name: string; done: boolean }[] = [];
  processed = processed.replace(
    /^- \[([ x])\] (.+?) :: habit\s*$/gm,
    (_, checked, name) => {
      const id = habitItems.length;
      habitItems.push({ name: name.trim(), done: checked === 'x' });
      return `HABIT_ITEM_${id}_END`;
    }
  );

  // === Mermaid diagrams (extract before markdown processing) ===
  const mermaidDiagrams: string[] = [];
  processed = processed.replace(/```mermaid\n([\s\S]*?)```/g, (_, diagram) => {
    const id = mermaidDiagrams.length;
    mermaidDiagrams.push(diagram.trim());
    return `MERMAID_PLACEHOLDER_${id}`;
  });

  // === Callouts ===
  const callouts: string[] = [];
  processed = extractCallouts(processed, callouts);

  // === Block math $$...$$ ===
  const mathBlocks: string[] = [];
  processed = processed.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    const id = mathBlocks.length;
    try { mathBlocks.push(`<div class="katex-block">${katex.renderToString(math.trim(), { displayMode: true, throwOnError: false })}</div>`); }
    catch { mathBlocks.push(`<div class="katex-error">$$${math}$$</div>`); }
    return `MATH_BLOCK_${id}_END`;
  });

  // === Inline math $...$ ===
  processed = processed.replace(/\$([^$\n]{1,200}?)\$/g, (_, math) => {
    const id = mathBlocks.length;
    try { mathBlocks.push(`<span class="katex-inline">${katex.renderToString(math.trim(), { throwOnError: false })}</span>`); }
    catch { mathBlocks.push(`<span class="katex-error">$${math}$</span>`); }
    return `MATH_INLINE_${id}_END`;
  });

  // === Transclusion ![[name]] ===
  processed = processed.replace(/!\[\[([^\]]+)\]\]/g, (_, name) => {
    const target = tabs.find(t => t.title.toLowerCase() === name.toLowerCase());
    if (target && transcluded[target.id]) {
      const inner = renderInner(transcluded[target.id], tabs);
      return `<TRANSCLUSION_${target.id}_START>${inner}</TRANSCLUSION_${target.id}_END>`;
    }
    if (target) return `<span class="transclusion transclusion--loading">↗ ${name}…</span>`;
    return `<span class="transclusion transclusion--missing">![[${name}]]</span>`;
  });

  // === Wikilinks [[name]] ===
  processed = processed.replace(/\[\[([^\]]+)\]\]/g, (_, name) => {
    const target = tabs.find(t => t.title.toLowerCase() === name.toLowerCase());
    return target
      ? `<a class="wikilink wikilink--found" data-pad-id="${target.id}">${name}</a>`
      : `<span class="wikilink wikilink--missing">${name}</span>`;
  });

  // Render markdown
  let html = marked.parse(processed, { async: false }) as string;

  // Add heading IDs for TOC
  html = addHeadingIds(html);

  // Sanitize
  html = DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-pad-id', 'class', 'id', 'data-diagram', 'data-habit', 'data-done', 'data-deck'],
    FORCE_BODY: false,
  });

  // Restore math
  mathBlocks.forEach((mh, id) => {
    html = html.replace(`MATH_BLOCK_${id}_END`, mh).replace(`MATH_INLINE_${id}_END`, mh);
  });

  // Restore transclusions
  Object.entries(transcluded).forEach(([padId]) => {
    const target = tabs.find(t => t.id === padId);
    if (!target) return;
    const inner = renderInner(transcluded[padId], tabs);
    const block = `<div class="transclusion"><div class="transclusion__header"><span class="transclusion__arrow">↗</span><span class="transclusion__title" data-pad-id="${padId}">${target.title}</span></div><div class="transclusion__body">${inner}</div></div>`;
    html = html.replace(new RegExp(`<p>\\s*<TRANSCLUSION_${padId}_START>[\\s\\S]*?</TRANSCLUSION_${padId}_END>\\s*</p>`, 'g'), block);
    html = html.replace(new RegExp(`<TRANSCLUSION_${padId}_START>[\\s\\S]*?</TRANSCLUSION_${padId}_END>`, 'g'), block);
  });

  // Restore callouts
  html = restoreCallouts(html, callouts);

  // Restore mermaid placeholders as render targets
  mermaidDiagrams.forEach((diagram, id) => {
    const encoded = btoa(unescape(encodeURIComponent(diagram)));
    html = html.replace(
      new RegExp(`<p>\\s*MERMAID_PLACEHOLDER_${id}\\s*</p>`),
      `<div class="mermaid-placeholder" data-diagram="${encoded}"></div>`,
    );
  });

  // Restore flashcard decks
  flashDecks.forEach((pairs, id) => {
    const encoded = encodeURIComponent(JSON.stringify(pairs));
    html = html.replace(
      new RegExp(`<p>\\s*FLASHDECK_${id}_END\\s*</p>`),
      `<div class="flashdeck" data-deck="${encoded}"></div>`,
    );
  });

  // Restore habit tracker items
  habitItems.forEach(({ name, done }, id) => {
    const encoded = encodeURIComponent(name);
    html = html.replace(
      new RegExp(`<p>\\s*HABIT_ITEM_${id}_END\\s*</p>`),
      `<div class="habit-item" data-habit="${encoded}" data-done="${done ? '1' : '0'}"></div>`,
    );
  });

  return html;
};

const LATEX_DEFAULT = `\\documentclass[12pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{geometry}
\\geometry{margin=2.5cm}

\\title{Mon document}
\\author{Auteur}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
Bienvenue dans l'éditeur \\LaTeX{} intégré.

\\end{document}
`;

const DocumentPad: React.FC<Props> = ({ padId, theme = 'dark', globalThemeDark = true, format = 'markdown', tabs = [], onSelectPad, focusMode = false, onToggleFocus, pendingContent, onContentLoaded, onContentChange, contentToAppend, onContentAppended }) => {
  const isLatex = format === 'latex';
  const { t } = useTranslation();
  const [content, setContent] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('split');
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved' | 'conflict'>('saved');
  // Optimistic-concurrency baseline: the pad's updated_at when we last read
  // (or successfully wrote) it. Sent on every save; server rejects with 409
  // if a peer (e.g. the same account on another device) has moved on since.
  const lastUpdatedAt = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const { related, notIndexed } = useRelatedPads(padId, 5);
  // Video pads: embedded player + timestamp navigation. `videoMeta` is
  // extracted from a leading HTML comment (see `lib/videoMeta.ts`) so it
  // travels with the markdown and requires no schema change.
  const videoMeta = useMemo(() => readVideoMeta(content), [content]);
  const videoRef = useRef<VideoEmbedHandle | null>(null);
  // Server-persisted video bundle (heavy: transcript segments) — the
  // Regenerate button needs it. Loaded alongside the pad content.
  const [videoBundle, setVideoBundle] = useState<StoredVideoBundle | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenProgress, setRegenProgress] = useState<string | null>(null);
  const [transcluded, setTranscluded] = useState<Transcluded>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [habitTick, setHabitTick] = useState(0);
  // LaTeX compile state
  const [latexPdfUrl, setLatexPdfUrl] = useState<string | null>(null);
  const [latexLog, setLatexLog] = useState<string | null>(null);
  const [latexStatus, setLatexStatus] = useState<'idle' | 'compiling' | 'ok' | 'err'>('idle');
  const latexBlobUrl = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const monacoRef = useRef<any>(null);
  const vimStatusRef = useRef<HTMLDivElement>(null);
  const [vimMode, setVimMode] = useState(() => localStorage.getItem('alcove_vim_mode') === '1');
  const [editorNonce, setEditorNonce] = useState(0);

  // Attach / detach monaco-vim whenever the toggle flips or the editor remounts.
  useEffect(() => {
    const editor = monacoRef.current;
    if (!editor || isLatex || !vimMode || !vimStatusRef.current) return;
    let vim: any = null;
    try { vim = initVimMode(editor, vimStatusRef.current); } catch { /* noop */ }
    return () => { try { vim?.dispose(); } catch { /* noop */ } };
  }, [vimMode, editorNonce, isLatex]);

  const toggleVim = () => setVimMode(v => {
    const next = !v;
    localStorage.setItem('alcove_vim_mode', next ? '1' : '0');
    return next;
  });

  const tocItems = useMemo(() => extractToc(content), [content]);
  const wordCount = useMemo(() => content.trim().split(/\s+/).filter(Boolean).length, [content]);
  const readingTime = Math.ceil(wordCount / 200);
  const flashcardCount = useMemo(() => {
    const m = content.match(/((?:^Q:[ \t]*[^\n]+\n^A:[ \t]*[^\n]+\n?)+)/gm);
    if (!m) return 0;
    return m.reduce((sum, block) => sum + [...block.matchAll(/^Q:/gm)].length, 0);
  }, [content]);

  // Fetch transcluded pads referenced via ![[name]]
  useEffect(() => {
    const matches = Array.from(content.matchAll(/!\[\[([^\]]+)\]\]/g));
    const names = Array.from(new Set(matches.map(m => m[1].toLowerCase())));
    if (names.length === 0) return;
    names.forEach(name => {
      const target = tabs.find(t => t.title.toLowerCase() === name);
      if (!target || target.padType !== 'document' || transcluded[target.id] !== undefined) return;
      setTranscluded(prev => ({ ...prev, [target.id]: '' }));
      fetch(`/api/pad/${target.id}`)
        .then(r => r.json())
        .then(d => setTranscluded(prev => ({ ...prev, [target.id]: d.content || '' })))
        .catch(() => setTranscluded(prev => ({ ...prev, [target.id]: '' })));
    });
  }, [content, tabs]);

  // Load pad content + backlinks
  useEffect(() => {
    setLoading(true);
    setBacklinks([]);
    setTranscluded({});
    Promise.all([
      fetch(`/api/pad/${padId}`).then(r => r.json()),
      isLatex ? Promise.resolve({ backlinks: [] }) : fetch(`/api/pad/${padId}/backlinks`).then(r => r.json()).catch(() => ({ backlinks: [] })),
    ])
      .then(([padData, blData]) => {
        const loaded = isLatex ? (padData?.data?.source || padData?.content || '') : (padData?.content || '');
        const initial = !loaded && pendingContent ? pendingContent : (loaded || (isLatex ? LATEX_DEFAULT : ''));
        setContent(initial);
        lastUpdatedAt.current = padData?.updated_at ?? null;
        if (!loaded && pendingContent) scheduleSave(pendingContent);
        if (!loaded && isLatex && !pendingContent) scheduleSave(LATEX_DEFAULT);
        setSaveStatus('saved');
        setBacklinks(blData?.backlinks || []);
        setVideoBundle((padData?.video as StoredVideoBundle | undefined) ?? null);
        // onContentChange only otherwise fires on edits (handleChange) — without this,
        // opening a pad and immediately using an AI action (tags, summary) would send
        // the PREVIOUS pad's stale content, since the parent's copy was never refreshed.
        onContentChange?.(initial);
        onContentLoaded?.();
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [padId]);

  // Daily note: fill in the "## Hier" AI summary left pending by the backend.
  // The marker embeds yesterday's pad id; we stream a summary from Ollama and
  // swap it in, then persist. Silently removes the marker if Ollama is down.
  const aiSummaryRunning = useRef(false);
  useEffect(() => { aiSummaryRunning.current = false; }, [padId]);
  useEffect(() => {
    const m = content.match(/<!-- ai-summary-pending:([0-9a-f-]{36}) -->/);
    if (!m || aiSummaryRunning.current || loading) return;
    aiSummaryRunning.current = true;
    const marker = m[0];
    const yesterdayId = m[1];
    (async () => {
      try {
        const resp = await fetch(`/api/pad/${yesterdayId}`);
        const yContent: string = (await resp.json())?.content || '';
        if (!yContent.trim()) throw new Error('empty');
        const model = localStorage.getItem('pad-ws-ai-model') ?? undefined;
        let summary = '';
        const { streamOllamaChat } = await import('../hooks/useOllama');
        await streamOllamaChat(model ?? '', [], (chunk) => { summary += chunk; }, '/api/ai/summarize', { content: yContent, lang: 'fr' });
        summary = summary.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        setContent(prev => {
          const next = prev.replace(marker, summary || '');
          scheduleSave(next);
          return next;
        });
      } catch {
        setContent(prev => {
          const next = prev.replace(marker + '\n', '').replace(marker, '');
          scheduleSave(next);
          return next;
        });
      }
    })();
  }, [content, loading]);

  // LaTeX compile function
  const compileLatex = useCallback(async (src: string) => {
    setLatexStatus('compiling');
    try {
      const res = await fetch('/api/latex/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: src }),
      });
      const data = await res.json();
      if (data.success && data.pdf) {
        const bytes = Uint8Array.from(atob(data.pdf), c => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'application/pdf' });
        if (latexBlobUrl.current) URL.revokeObjectURL(latexBlobUrl.current);
        const url = URL.createObjectURL(blob);
        latexBlobUrl.current = url;
        setLatexPdfUrl(url);
        setLatexLog(null);
        setLatexStatus('ok');
      } else {
        setLatexLog(data.log ?? 'Erreur inconnue');
        setLatexStatus('err');
      }
    } catch {
      setLatexLog('Impossible de contacter le serveur de compilation.');
      setLatexStatus('err');
    }
  }, []);

  // Debounced auto-save
  const scheduleSave = useCallback((text: string) => {
    setSaveStatus('unsaved');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveStatus('saving');
      try {
        const url = isLatex ? `/api/pad/${padId}/data` : `/api/pad/${padId}/doc`;
        const body = isLatex
          ? { data: { source: text }, expected_updated_at: lastUpdatedAt.current }
          : { content: text, format: 'markdown', expected_updated_at: lastUpdatedAt.current };
        const res = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.status === 409) {
          // Another session (same account on another device) wrote after we
          // loaded. We keep the local text so nothing is silently dropped;
          // the status badge switches to 'conflict' so the user knows.
          setSaveStatus('conflict');
          return;
        }
        if (res.ok) {
          const j = await res.json().catch(() => null);
          if (j?.updated_at) lastUpdatedAt.current = j.updated_at;
          setSaveStatus('saved');
        } else {
          setSaveStatus('unsaved');
        }
      } catch {
        setSaveStatus('unsaved');
      }
    }, SAVE_DEBOUNCE_MS);
  }, [padId, isLatex]);

  const handleChange = (value: string | undefined) => {
    const text = value ?? '';
    setContent(text);
    scheduleSave(text);
    onContentChange?.(text);
  };

  /** Re-run /api/ai/video-report using the persisted bundle, then splice the
   * new report body into the current markdown (preserves the user's own
   * `## Notes`, Flashcards, and source-note wikilink). */
  const regenerateReport = useCallback(async () => {
    if (!videoBundle || !videoBundle.transcript_segments?.length || regenBusy) return;
    setRegenBusy(true);
    setRegenProgress('Démarrage…');
    try {
      const resp = await fetch('/api/ai/video-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: videoBundle.author ? `${videoBundle.author}` : '',
          url: videoBundle.url ?? undefined,
          author: videoBundle.author ?? '',
          duration: videoBundle.duration ?? undefined,
          chapters: videoBundle.chapters ?? [],
          transcript_segments: videoBundle.transcript_segments,
          lang: 'fr',
        }),
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '', report = '';
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
            if (o.kind === 'progress' && o.msg) setRegenProgress(o.msg);
            else if (o.kind === 'document') report = o.content || '';
            else if (o.kind === 'error') throw new Error(o.error || 'regen failed');
          } catch { /* ignore malformed events */ }
        }
      }
      if (!report) throw new Error('Rapport vide');
      // Splice: keep the video-meta comment + header + user's ## Notes block.
      setContent(prev => {
        const next = replaceReportBody(prev, report);
        scheduleSave(next);
        onContentChange?.(next);
        return next;
      });
    } catch (e) {
      setRegenProgress('Erreur — voir la console');
      console.error('[alcove] regenerate report failed:', e);
    } finally {
      setRegenBusy(false);
      // Clear the progress line after a beat so the button label reverts.
      setTimeout(() => setRegenProgress(null), 1500);
    }
  }, [videoBundle, regenBusy, scheduleSave, onContentChange]);

  // Web clipper: fetch a URL server-side and append its content as Markdown
  const [clipping, setClipping] = useState(false);
  const clipUrl = useCallback(async () => {
    const url = window.prompt(t('editor.clipPrompt'));
    if (!url?.trim()) return;
    setClipping(true);
    try {
      const resp = await fetch('/api/ai/clip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.detail || 'clip failed');
      const block = `\n\n## 🔗 ${data.title}\n\n> Source : ${data.url}\n\n${data.markdown}\n`;
      setContent(prev => {
        const next = prev + block;
        scheduleSave(next);
        return next;
      });
    } catch (e) {
      window.alert(t('editor.clipFailed') + (e instanceof Error ? `\n${e.message}` : ''));
    } finally {
      setClipping(false);
    }
  }, [t, scheduleSave]);

  // Append AI-generated content to the editor
  useEffect(() => {
    if (!contentToAppend || !monacoRef.current) return;
    const editor = monacoRef.current;
    const model = editor.getModel();
    if (!model) return;
    const lineCount = model.getLineCount();
    const lastCol = model.getLineLength(lineCount) + 1;
    const separator = content.trim() ? '\n\n' : '';
    const insertion = `${separator}${contentToAppend}`;
    editor.executeEdits('ai-insert', [{
      range: { startLineNumber: lineCount, startColumn: lastCol, endLineNumber: lineCount, endColumn: lastCol },
      text: insertion,
    }]);
    onContentAppended?.();
  }, [contentToAppend]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle wikilink clicks in preview
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('[data-pad-id]');
      if (target) {
        e.preventDefault();
        const id = target.getAttribute('data-pad-id');
        if (id && onSelectPad) onSelectPad(id);
      }
    };
    el.addEventListener('click', handler);
    return () => el.removeEventListener('click', handler);
  }, [onSelectPad, viewMode]);

  // Image paste — intercept before Monaco, with optional OCR
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handler = async (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items || []);
      const imageItem = items.find(i => i.type.startsWith('image/'));
      if (!imageItem || !monacoRef.current || viewMode === 'preview') return;
      e.preventDefault();
      e.stopPropagation();
      const file = imageItem.getAsFile();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (evt) => {
        const dataUrl = evt.target?.result as string;
        const editor = monacoRef.current;
        const pos = editor.getPosition();
        if (!pos) return;

        // Insert image placeholder immediately
        const insertText = (text: string) => {
          const currentPos = editor.getPosition() || pos;
          editor.executeEdits('paste-image', [{
            range: { startLineNumber: currentPos.lineNumber, startColumn: currentPos.column, endLineNumber: currentPos.lineNumber, endColumn: currentPos.column },
            text,
          }]);
        };
        insertText(`![image](${dataUrl})\n`);

        // OCR in background
        try {
          const { createWorker } = await import('tesseract.js');
          const worker = await createWorker('fra+eng');
          const { data: { text } } = await worker.recognize(dataUrl);
          await worker.terminate();
          const trimmed = text.trim();
          if (trimmed.length > 10) {
            const ocrBlock = `\n> **OCR :** ${trimmed.replace(/\n+/g, ' ')}\n`;
            insertText(ocrBlock);
          }
        } catch {
          // OCR failed silently
        }
      };
      reader.readAsDataURL(file);
    };
    container.addEventListener('paste', handler as EventListener, true);
    return () => container.removeEventListener('paste', handler as EventListener, true);
  }, [viewMode]);

  const scrollToHeading = (slug: string) => {
    const el = previewRef.current?.querySelector(`#toc-${slug}`) as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTocOpen(false);
  };

  // Strip the video meta comment before render so its JSON payload never
  // shows up in the preview (browsers hide HTML comments, but marked can
  // occasionally break them across paragraphs during transclusion).
  const renderedHtml = renderContent(
    videoMeta ? stripVideoMeta(content) : content,
    tabs, transcluded,
  );
  const monacoTheme = (theme === 'light' || !globalThemeDark) ? 'light' : 'vs-dark';

  // Wire `[MM:SS]` / `[H:MM:SS]` timestamps in the rendered preview to seek
  // the embedded video. We walk the DOM text nodes (not innerHTML.replace)
  // so we don't destroy any surrounding link/code/emphasis markup. Only
  // active when the pad actually has a video attached.
  useEffect(() => {
    const el = previewRef.current;
    if (!el || !videoMeta) return;
    const TS_RE = /\[((?:\d{1,2}:)?\d{1,2}:\d{2})\]/g;

    // Collect text nodes upfront — mutating during traversal would skip nodes.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        // Skip inside code blocks + existing timestamp buttons.
        let p: Node | null = node.parentNode;
        while (p && p !== el) {
          const tag = (p as HTMLElement).tagName;
          if (tag === 'CODE' || tag === 'PRE' || (p as HTMLElement).classList?.contains?.('video-timestamp')) {
            return NodeFilter.FILTER_REJECT;
          }
          p = p.parentNode;
        }
        return TS_RE.test(node.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });

    const targets: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) targets.push(n as Text);

    for (const textNode of targets) {
      const text = textNode.nodeValue || '';
      TS_RE.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of text.matchAll(TS_RE)) {
        const idx = m.index ?? 0;
        if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
        const seconds = parseTimestamp(m[1]);
        if (seconds == null) {
          frag.appendChild(document.createTextNode(m[0]));
        } else {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'video-timestamp';
          btn.dataset.seek = String(seconds);
          btn.textContent = m[1];
          btn.title = `Jump to ${m[1]}`;
          frag.appendChild(btn);
        }
        last = idx + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode?.replaceChild(frag, textNode);
    }

    // Delegated click handler — one listener per preview render.
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement | null)?.closest?.('button.video-timestamp') as HTMLButtonElement | null;
      if (!btn) return;
      e.preventDefault();
      const s = parseInt(btn.dataset.seek || '0', 10);
      if (Number.isFinite(s)) videoRef.current?.seekTo(s);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [renderedHtml, videoMeta]);

  // Render mermaid diagrams after preview updates
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const placeholders = el.querySelectorAll<HTMLElement>('.mermaid-placeholder:not(.mermaid-rendered)');
    if (placeholders.length === 0) return;
    mermaid.initialize({ startOnLoad: false, theme: theme === 'light' ? 'default' : 'dark', securityLevel: 'loose' });
    placeholders.forEach(async (node, idx) => {
      const encoded = node.getAttribute('data-diagram') || '';
      if (!encoded) return;
      try {
        const diagram = decodeURIComponent(escape(atob(encoded)));
        const id = `mermaid-${Date.now()}-${idx}`;
        const { svg } = await mermaid.render(id, diagram);
        node.innerHTML = svg;
        node.classList.add('mermaid-rendered');
      } catch (e: any) {
        node.innerHTML = `<pre class="mermaid-error">${e?.message ?? e}</pre>`;
      }
    });
  }, [renderedHtml, theme]);

  // Render habit tracker widgets after preview HTML changes
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const items = el.querySelectorAll<HTMLElement>('.habit-item[data-habit]');
    if (items.length === 0) return;

    const todayStr = new Date().toISOString().slice(0, 10);
    const last7 = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));
      return d.toISOString().slice(0, 10);
    });

    items.forEach(node => {
      const name = decodeURIComponent(node.getAttribute('data-habit') || '');
      const lsKey = (date: string) => `habit-${padId}-${name}-${date}`;
      const todayDone = localStorage.getItem(lsKey(todayStr)) === '1';

      const dots = last7.map(d => {
        const done = localStorage.getItem(lsKey(d)) === '1';
        const isToday = d === todayStr;
        return `<div class="habit-tracker__dot${done ? ' habit-tracker__dot--done' : ''}${isToday ? ' habit-tracker__dot--today' : ''}" title="${d}"></div>`;
      }).join('');

      node.innerHTML = `
        <label class="habit-tracker__label">
          <input class="habit-tracker__check" type="checkbox" ${todayDone ? 'checked' : ''} data-habit-name="${encodeURIComponent(name)}" data-habit-date="${todayStr}" />
          <span class="habit-tracker__name">${name}</span>
        </label>
        <div class="habit-tracker__grid">${dots}</div>
      `;

      node.querySelector<HTMLInputElement>('.habit-tracker__check')?.addEventListener('change', (e) => {
        const input = e.target as HTMLInputElement;
        const hName = decodeURIComponent(input.getAttribute('data-habit-name') || '');
        const hDate = input.getAttribute('data-habit-date') || '';
        localStorage.setItem(`habit-${padId}-${hName}-${hDate}`, input.checked ? '1' : '0');
        setHabitTick(t => t + 1);
      });
    });
  }, [renderedHtml, padId, habitTick]);

  // Render flashcard decks after preview HTML changes
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const decks = el.querySelectorAll<HTMLElement>('.flashdeck[data-deck]:not(.flashdeck--rendered)');
    decks.forEach(node => {
      node.classList.add('flashdeck--rendered');
      let pairs: { q: string; a: string }[] = [];
      try { pairs = JSON.parse(decodeURIComponent(node.getAttribute('data-deck') || '[]')); } catch { return; }
      if (!pairs.length) return;

      // SM-2 helpers
      const SM2_KEY = `sm2-${padId}-${node.getAttribute('data-deck')?.slice(0, 16)}`;
      interface SM2Card { n: number; ef: number; interval: number; due: number }
      const loadSM2 = (): SM2Card[] => {
        try { return JSON.parse(localStorage.getItem(SM2_KEY) || '[]'); } catch { return []; }
      };
      const saveSM2 = (cards: SM2Card[]) => localStorage.setItem(SM2_KEY, JSON.stringify(cards));
      const today = () => Math.floor(Date.now() / 86400000);

      let sm2 = loadSM2();
      if (sm2.length !== pairs.length) {
        sm2 = pairs.map(() => ({ n: 0, ef: 2.5, interval: 1, due: today() }));
        saveSM2(sm2);
      }

      const updateSM2 = (idx: number, quality: number /* 0-5 */) => {
        const c = sm2[idx];
        const ef = Math.max(1.3, c.ef + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
        let interval = c.n === 0 ? 1 : c.n === 1 ? 6 : Math.round(c.interval * ef);
        sm2[idx] = { n: c.n + 1, ef, interval, due: today() + interval };
        saveSM2(sm2);
      };

      const dueToday = () => sm2.filter(c => c.due <= today()).length;

      let current = 0;
      let flipped = false;
      let score = { ok: 0, ko: 0 };

      const render = () => {
        const { q, a } = pairs[current];
        const total = pairs.length;
        const card = sm2[current];
        const isDue = card.due <= today();
        const dueCount = dueToday();
        node.innerHTML = `
          <div class="flashdeck__widget">
            <div class="flashdeck__header">
              <span class="flashdeck__counter">${current + 1} / ${total}</span>
              <span class="flashdeck__score">✅ ${score.ok} ❌ ${score.ko}</span>
              ${dueCount > 0 ? `<span class="flashdeck__due">${dueCount} à réviser</span>` : ''}
            </div>
            ${!isDue && card.n > 0 ? `<div class="flashdeck__next-due">Prochaine révision dans ${card.due - today()} jour(s)</div>` : ''}
            <div class="flashdeck__card${flipped ? ' flashdeck__card--flipped' : ''}">
              <div class="flashdeck__front"><span class="flashdeck__label">Q</span><div class="flashdeck__text">${q}</div></div>
              <div class="flashdeck__back"><span class="flashdeck__label">A</span><div class="flashdeck__text">${a}</div></div>
            </div>
            ${flipped ? `
              <div class="flashdeck__actions">
                <button class="flashdeck__btn flashdeck__btn--ko" data-r="ko">❌ Difficile</button>
                <button class="flashdeck__btn flashdeck__btn--ok" data-r="ok">✅ Facile</button>
              </div>` : `
              <button class="flashdeck__flip">Révéler la réponse</button>
            `}
          </div>`;

        node.querySelector('.flashdeck__card')?.addEventListener('click', () => { flipped = !flipped; render(); });
        node.querySelector('.flashdeck__flip')?.addEventListener('click', () => { flipped = true; render(); });
        node.querySelectorAll<HTMLElement>('[data-r]').forEach(btn => {
          btn.addEventListener('click', () => {
            const isOk = btn.dataset.r === 'ok';
            if (isOk) score.ok++; else score.ko++;
            updateSM2(current, isOk ? 5 : 2);
            current = (current + 1) % total;
            flipped = false;
            render();
          });
        });
      };

      render();
    });
  }, [renderedHtml, padId]);

  const exportMarkdown = () => {
    const tab = tabs.find(t => t.id === padId);
    const name = (tab?.title || 'document').replace(/[^\w\-]/g, '_');
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${name}.md`; a.click();
    URL.revokeObjectURL(url);
  };

  const exportPdf = () => {
    const tab = tabs.find(t => t.id === padId);
    const title = tab?.title || 'Document';
    const dateStr = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html lang="fr"><head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  @page { margin: 2cm 2.5cm; }
  body {
    font-family: 'Georgia', 'Times New Roman', serif;
    font-size: 11pt;
    line-height: 1.8;
    color: #1a1a1a;
    max-width: 800px;
    margin: 0 auto;
    padding: 40px 0;
  }
  h1 { font-size: 22pt; margin: 0 0 8px; color: #111; border-bottom: 2px solid #333; padding-bottom: 8px; }
  h2 { font-size: 16pt; margin-top: 2em; color: #222; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  h3 { font-size: 13pt; margin-top: 1.6em; color: #333; }
  h4 { font-size: 11pt; margin-top: 1.4em; font-style: italic; }
  p { margin: 0.8em 0; orphans: 3; widows: 3; }
  code { font-family: 'Courier New', monospace; background: #f4f4f4; padding: 2px 5px; border-radius: 3px; font-size: 9.5pt; }
  pre { background: #f8f8f8; border: 1px solid #e0e0e0; padding: 14px 16px; border-radius: 5px; overflow: auto; page-break-inside: avoid; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #aaa; margin: 1em 0; padding: 4px 16px; color: #555; font-style: italic; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; page-break-inside: avoid; }
  th, td { border: 1px solid #ccc; padding: 7px 12px; text-align: left; }
  th { background: #f0f0f0; font-weight: bold; }
  tr:nth-child(even) { background: #fafafa; }
  ul, ol { margin: 0.6em 0; padding-left: 2em; }
  li { margin: 0.3em 0; }
  a { color: #1a73e8; text-decoration: underline; }
  img { max-width: 100%; height: auto; page-break-inside: avoid; }
  hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
  .callout { border-radius: 6px; padding: 12px 16px; margin: 1em 0; page-break-inside: avoid; }
  .callout--note { background: #e8f0fe; border-left: 4px solid #4285f4; }
  .callout--tip { background: #e6f4ea; border-left: 4px solid #34a853; }
  .callout--warning { background: #fef7e0; border-left: 4px solid #fbbc04; }
  .callout--important { background: #fce8e6; border-left: 4px solid #ea4335; }
  .callout--caution { background: #fce8e6; border-left: 4px solid #d62d20; }
  .pdf-header { border-bottom: 1px solid #ddd; margin-bottom: 32px; padding-bottom: 12px; }
  .pdf-header__title { font-size: 24pt; font-weight: bold; margin: 0; }
  .pdf-header__meta { font-size: 9pt; color: #888; margin-top: 4px; }
  @media print {
    body { padding: 0; }
    h2, h3 { page-break-after: avoid; }
    pre, table, figure { page-break-inside: avoid; }
  }
</style>
</head><body>
<div class="pdf-header">
  <div class="pdf-header__title">${title}</div>
  <div class="pdf-header__meta">${dateStr}</div>
</div>
${renderedHtml}
<script>window.onload = function() { window.print(); }<\/script>
</body></html>`);
    win.document.close();
  };

  const manualSnapshot = async () => {
    await fetch(`/api/pad/${padId}/versions/snapshot`, { method: 'POST' });
  };

  const statusLabel =
    saveStatus === 'saving' ? t('editor.saving')
    : saveStatus === 'unsaved' ? t('editor.unsaved')
    : saveStatus === 'conflict' ? '⚠️ Modifié ailleurs — recharge la page'
    : t('editor.saved');

  if (loading) {
    return <div className="document-pad document-pad--loading">{t('editor.loading')}</div>;
  }

  return (
    <div ref={containerRef} className={`document-pad document-pad--${theme}${focusMode ? ' document-pad--focus' : ''}`}>
      {!focusMode && (
      <div className="document-pad__toolbar">
        <div className="document-pad__view-btns">
          {(['edit', 'split', 'preview'] as ViewMode[]).map(mode => (
            <button
              key={mode}
              className={`document-pad__view-btn ${viewMode === mode ? 'active' : ''}`}
              onClick={() => setViewMode(mode)}
            >
              {mode === 'edit' ? t('editor.edit') : mode === 'split' ? t('editor.split') : t('editor.preview')}
            </button>
          ))}
        </div>
        <div className="document-pad__toolbar-right">
          {isLatex ? (
            <>
              <button
                className="document-pad__toolbar-btn document-pad__toolbar-btn--compile"
                onClick={() => compileLatex(content)}
                disabled={latexStatus === 'compiling'}
                title="Compiler le LaTeX (PDF)"
              >
                <Play size={13} /> Compiler
              </button>
              {latexStatus !== 'idle' && (
                <span className={`document-pad__status document-pad__status--${latexStatus === 'ok' ? 'saved' : latexStatus === 'err' ? 'unsaved' : 'saving'}`}>
                  {latexStatus === 'compiling' ? 'Compilation…' : latexStatus === 'ok' ? '✓ PDF prêt' : '✗ Erreur'}
                </span>
              )}
              <span className={`document-pad__status document-pad__status--${saveStatus}`}>{statusLabel}</span>
              <button className="document-pad__toolbar-btn" onClick={onToggleFocus} title={t('editor.focus')}>
                <Maximize2 size={14} />
              </button>
            </>
          ) : (
            <>
              {wordCount > 0 && (
                <span className="document-pad__stats" title={`${wordCount} mots · ${readingTime} min`}>
                  {t('editor.words', { count: wordCount })} · {t('editor.readingTime', { min: readingTime })}
                </span>
              )}
              {flashcardCount > 0 && (
                <button
                  className={`document-pad__toolbar-btn document-pad__toolbar-btn--flash${viewMode !== 'edit' ? ' active' : ''}`}
                  onClick={() => setViewMode(viewMode === 'edit' ? 'split' : viewMode)}
                  title={`${flashcardCount} carte${flashcardCount > 1 ? 's' : ''} — passe en Preview pour réviser`}
                >
                  <BookOpen size={14} />
                  <span style={{ fontSize: 11, fontWeight: 700 }}>{flashcardCount}</span>
                </button>
              )}
              {tocItems.length > 0 && viewMode !== 'edit' && (
                <button
                  className={`document-pad__toolbar-btn ${tocOpen ? 'active' : ''}`}
                  onClick={() => setTocOpen(v => !v)}
                  title={t('editor.toc')}
                >
                  <List size={14} />
                </button>
              )}
              <button
                className={`document-pad__toolbar-btn${vimMode ? ' active' : ''}`}
                onClick={toggleVim}
                title={vimMode ? 'Mode Vim activé' : 'Activer le mode Vim'}
              >
                <Terminal size={14} />
              </button>
              <button className="document-pad__toolbar-btn" onClick={() => setHistoryOpen(v => !v)} title={t('editor.history')}>
                <History size={14} />
              </button>
              <button className="document-pad__toolbar-btn" onClick={manualSnapshot} title={t('editor.snapshot')}>
                <Bookmark size={14} />
              </button>
              <button className="document-pad__toolbar-btn" onClick={clipUrl} disabled={clipping} title={t('editor.clipTitle')}>
                <Globe size={14} />{clipping ? '…' : ''}
              </button>
              <button className="document-pad__toolbar-btn" onClick={exportMarkdown} title={t('editor.exportMd')}>
                <Download size={14} /> .md
              </button>
              <button className="document-pad__toolbar-btn" onClick={exportPdf} title={t('editor.exportPdf')}>
                <FileText size={14} /> PDF
              </button>
              <button
                className="document-pad__toolbar-btn"
                title="Enregistrer comme template"
                onClick={() => {
                  const name = prompt('Nom du template ?', '');
                  if (!name?.trim()) return;
                  saveUserTemplate({ icon: '📝', title: name.trim(), content });
                }}
              >
                <Save size={14} />
              </button>
              <span className={`document-pad__status document-pad__status--${saveStatus}`}>
                {statusLabel}
              </span>
              <button className="document-pad__toolbar-btn" onClick={onToggleFocus} title={t('editor.focus')}>
                <Maximize2 size={14} />
              </button>
            </>
          )}
        </div>
      </div>
      )}

      {focusMode && (
        <button className="document-pad__focus-exit" onClick={onToggleFocus} title={t('editor.exitFocus')}>
          <Minimize2 size={15} />
        </button>
      )}

      {historyOpen && (
        <HistoryPanel padId={padId} onClose={() => setHistoryOpen(false)} onRestore={() => {
          setHistoryOpen(false);
          fetch(`/api/pad/${padId}`).then(r => r.json()).then(d => setContent(d.content || ''));
        }} />
      )}

      <div className="document-pad__body">
        {(viewMode === 'edit' || viewMode === 'split') && (
          <div className="document-pad__editor">
            <Editor
              value={content}
              onChange={handleChange}
              onMount={(editor, monacoInstance) => {
                monacoRef.current = editor;
                if (!isLatex) registerSlashCommands(monacoInstance);
                setEditorNonce(n => n + 1);
              }}
              language={isLatex ? 'latex' : 'markdown'}
              theme={monacoTheme}
              options={{
                wordWrap: 'on',
                minimap: { enabled: false },
                fontSize: 14,
                lineHeight: 22,
                padding: { top: 20, bottom: 20 },
                scrollBeyondLastLine: false,
                renderLineHighlight: 'none',
                overviewRulerBorder: false,
                hideCursorInOverviewRuler: true,
                lineNumbers: isLatex ? 'on' : 'off',
                glyphMargin: false,
                folding: false,
                lineDecorationsWidth: 16,
                lineNumbersMinChars: 0,
                fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
              }}
            />
            <div
              ref={vimStatusRef}
              className="document-pad__vim-status"
              style={{ display: vimMode && !isLatex ? 'block' : 'none' }}
            />
          </div>
        )}

        {(viewMode === 'preview' || viewMode === 'split') && (
          <div className="document-pad__preview-wrap">
            {isLatex ? (
              latexPdfUrl ? (
                <>
                  <iframe
                    className="document-pad__latex-pdf"
                    src={latexPdfUrl}
                    title="Aperçu PDF"
                  />
                  {latexLog && latexStatus === 'err' && (
                    <div className="document-pad__latex-log">
                      <pre>{latexLog}</pre>
                    </div>
                  )}
                </>
              ) : (
                <div className="document-pad__latex-placeholder">
                  <Play size={32} />
                  <span>Clique sur <strong>Compiler</strong> pour générer le PDF</span>
                  {latexStatus === 'err' && latexLog && (
                    <pre className="document-pad__latex-log-inline">{latexLog}</pre>
                  )}
                </div>
              )
            ) : (
              <>
                {tocOpen && tocItems.length > 0 && (
                  <div className="document-pad__toc">
                    <div className="document-pad__toc-header">
                      <span>Sommaire</span>
                      <button onClick={() => setTocOpen(false)}>×</button>
                    </div>
                    <nav className="document-pad__toc-list">
                      {tocItems.map((item, i) => (
                        <button
                          key={i}
                          className={`document-pad__toc-item document-pad__toc-item--h${item.level}`}
                          onClick={() => scrollToHeading(item.slug)}
                        >
                          {item.text}
                        </button>
                      ))}
                    </nav>
                  </div>
                )}
                {videoMeta && (
                  <div className="document-pad__video-wrap">
                    <VideoEmbed
                      ref={videoRef}
                      meta={videoMeta}
                      onRegenerate={videoBundle?.transcript_segments?.length ? regenerateReport : undefined}
                      regenerateBusy={regenBusy}
                      regenerateProgress={regenProgress}
                    />
                  </div>
                )}
                <div
                  ref={previewRef}
                  className="document-pad__preview"
                  dangerouslySetInnerHTML={{ __html: renderedHtml }}
                />
                {backlinks.length > 0 && (
                  <div className="document-pad__backlinks">
                    <div className="document-pad__backlinks-title">
                      <Link size={13} />
                      Liens entrants ({backlinks.length})
                    </div>
                    <div className="document-pad__backlinks-list">
                      {backlinks.map(bl => (
                        <button
                          key={bl.id}
                          className="document-pad__backlink-item"
                          onClick={() => onSelectPad?.(bl.id)}
                        >
                          {bl.display_name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {related && related.length > 0 && (
                  <div className="document-pad__backlinks document-pad__related">
                    <div className="document-pad__backlinks-title">
                      <Sparkles size={13} />
                      Notes reliées ({related.length})
                    </div>
                    <div className="document-pad__backlinks-list">
                      {related.map(r => (
                        <button
                          key={r.pad_id}
                          className="document-pad__backlink-item document-pad__related-item"
                          onClick={() => onSelectPad?.(r.pad_id)}
                          title={`Similarité ${Math.round(r.score * 100)}%`}
                        >
                          <span>{r.pad_name}</span>
                          <span className="document-pad__related-score">
                            {Math.round(r.score * 100)}%
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {related && related.length === 0 && notIndexed && (
                  <div className="document-pad__backlinks document-pad__related document-pad__related--hint">
                    <Sparkles size={13} />
                    <span>Notes reliées : indexe ce pad depuis le panneau IA (mode RAG → Indexer tout) pour voir les correspondances sémantiques.</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default DocumentPad;
