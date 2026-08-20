/**
 * Full-page AI Chat view (chantier #16, 2026-08-20) — Recall's `/chat` is its
 * own route with a ChatGPT-style history sidebar, not a tab buried in a
 * narrow side panel. This mirrors that: a dedicated overlay (same mounting
 * pattern as GraphView) with conversation history on the left and the
 * agentic RAG chat (from AIPanel's RAG tab, same `agenticRagChat` engine and
 * `ChatMessage` renderer) on the right.
 *
 * Scope boundary: conversations persist via the existing
 * /api/ai/conversations endpoints, which only store {role, content} per
 * message (see `AIConversation.messages` — no sources/citations column).
 * A LIVE conversation renders full citations/sources/follow-ups; reloading
 * a past conversation from history shows plain content only. That's an
 * honest limitation of the current persistence shape, not a bug — extending
 * it to store rich metadata is a separate, larger change.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Plus, MessageSquare, Trash2, Pencil, Search } from 'lucide-react';
import { useOllamaModels } from '../hooks/useOllama';
import { agenticRagChat } from '../lib/rag';
import { Message } from '../lib/chatTypes';
import ChatMessage from './ChatMessage';
import './AIPanel.scss'; // ai-msg__* / ai-panel__empty rules — shared with ChatMessage
import './ChatView.scss';

interface ConvSummary {
  id: string;
  title: string;
  message_count: number;
  updated_at: string;
}

interface Props {
  onClose: () => void;
}

const SAVED_MODEL_KEY = 'pad-ws-ai-model';

/** Section label: "Aujourd'hui" / "Hier" / weekday+date / full date —
 * mirrors Dashboard.tsx's sectionLabel so the two surfaces read the same. */
function sectionLabel(iso: string, t: (k: string) => string): string {
  const d = new Date(iso);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  if (day.getTime() === today.getTime()) return t('dashboard.today');
  if (day.getTime() === yesterday.getTime()) return t('dashboard.yesterday');
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString('fr-FR', sameYear
    ? { weekday: 'long', day: 'numeric', month: 'long' }
    : { day: 'numeric', month: 'long', year: 'numeric' });
}

function groupByDate(convs: ConvSummary[]): [string, ConvSummary[]][] {
  const groups = new Map<string, ConvSummary[]>();
  for (const c of convs) {
    const key = (c.updated_at || '').slice(0, 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  return Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0]));
}

export default function ChatView({ onClose }: Props) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith('fr') ? 'fr' : 'en';
  const { modelNames: models, defaultModel } = useOllamaModels();
  const [model, setModel] = useState<string>(() => localStorage.getItem(SAVED_MODEL_KEY) ?? defaultModel);
  useEffect(() => {
    if (!localStorage.getItem(SAVED_MODEL_KEY) && defaultModel) setModel(defaultModel);
  }, [defaultModel]);

  const [conversations, setConversations] = useState<ConvSummary[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [activeTitle, setActiveTitle] = useState<string>(t('ai.convNew'));
  const [messages, setMessages] = useState<Message[]>([]);
  const [query, setQuery] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [historyFilter, setHistoryFilter] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadConversations = useCallback(async () => {
    try {
      const r = await fetch('/api/ai/conversations');
      const d = await r.json();
      setConversations(d.conversations || []);
    } catch { /* offline — non-fatal */ }
  }, []);

  useEffect(() => { loadConversations(); }, [loadConversations]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // Persist the current thread once streaming settles (debounced), same
  // pattern as AIPanel's plain chat tab. Only role+content survive — see
  // the file-level scope-boundary note above.
  useEffect(() => {
    if (streaming || messages.length === 0) return;
    const timer = setTimeout(async () => {
      const payload = messages.map(m => ({ role: m.role, content: m.content }));
      try {
        if (activeConvId) {
          await fetch(`/api/ai/conversations/${activeConvId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: payload }),
          });
        } else {
          const r = await fetch('/api/ai/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: payload }),
          });
          const d = await r.json();
          if (d.id) { setActiveConvId(d.id); setActiveTitle(d.title); }
        }
        loadConversations();
      } catch { /* offline — keep local copy */ }
    }, 1200);
    return () => clearTimeout(timer);
  }, [messages, streaming, activeConvId, loadConversations]);

  const newConversation = useCallback(() => {
    setMessages([]);
    setActiveConvId(null);
    setActiveTitle(t('ai.convNew'));
  }, [t]);

  const loadConversation = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/ai/conversations/${id}`);
      const d = await r.json();
      setMessages((d.messages || []) as Message[]);
      setActiveConvId(id);
      setActiveTitle(d.title || t('ai.convNew'));
    } catch { /* ignore */ }
  }, [t]);

  const deleteConversation = useCallback(async (id: string) => {
    try {
      await fetch(`/api/ai/conversations/${id}`, { method: 'DELETE' });
      if (id === activeConvId) newConversation();
      loadConversations();
    } catch { /* ignore */ }
  }, [activeConvId, newConversation, loadConversations]);

  const renameConversation = useCallback(async (id: string, current: string) => {
    const title = window.prompt(t('ai.convRename'), current);
    if (title === null || !title.trim()) return;
    try {
      await fetch(`/api/ai/conversations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() }),
      });
      if (id === activeConvId) setActiveTitle(title.trim());
      loadConversations();
    } catch { /* ignore */ }
  }, [t, activeConvId, loadConversations]);

  const patchLast = (patch: Partial<Message>) => {
    setMessages(prev => {
      const copy = [...prev];
      const last = copy[copy.length - 1];
      copy[copy.length - 1] = { ...last, ...patch };
      return copy;
    });
  };

  const send = useCallback(async (override?: string) => {
    const q = (override ?? query).trim();
    if (!q || streaming) return;
    setQuery('');
    setMessages(prev => [...prev, { role: 'user', content: q }]);
    setStreaming(true);
    setMessages(prev => [...prev, {
      role: 'assistant', content: '', sources: [], subqueries: [], followups: [],
    }]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      await agenticRagChat(model, q, {
        onSubqueries: (items) => patchLast({ subqueries: items }),
        onSources: (items) => patchLast({ sources: items }),
        onChunk: (chunk) => {
          setMessages(prev => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            copy[copy.length - 1] = { ...last, content: last.content + chunk };
            return copy;
          });
        },
        onFollowups: (items) => patchLast({ followups: items }),
      }, { lang, signal: ctrl.signal });
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') {
        patchLast({ content: (e as Error)?.message || t('ai.error') });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [query, streaming, model, lang, t]);

  const handleFollowup = useCallback((q: string) => { send(q); }, [send]);

  const handleAddToNotebook = useCallback(async (msg: Message) => {
    const idx = messages.indexOf(msg);
    const prev = idx > 0 ? messages[idx - 1] : null;
    const question = prev?.role === 'user' ? prev.content : '';
    const now = new Date().toISOString().slice(0, 10);
    const title = question ? question.slice(0, 60) + (question.length > 60 ? '…' : '') : `Chat ${now}`;
    const parts: string[] = [];
    if (question) parts.push(`# ${title}\n\n> ${question}\n`);
    parts.push(msg.content.trim());
    if (msg.sources && msg.sources.length) {
      parts.push('\n\n---\n\n## Sources\n');
      msg.sources.forEach((s, i) => {
        const label = `[[${s.pad_name}]]`;
        const ts = s.timestamp_label ? ` — ▶ ${s.timestamp_label}` : '';
        const excerpt = (s.chunk_text || '').replace(/\n/g, '\n> ');
        parts.push(`${s.n ?? i + 1}. ${label}${ts}\n\n> ${excerpt}\n`);
      });
    }
    try {
      const resp = await fetch('/api/pad/new', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pad_type: 'document', display_name: title, content: parts.join('\n') }),
      });
      const data = await resp.json();
      if (data?.id) window.open(`/pad/${data.id}`, '_blank');
    } catch { /* noise not worth wiring a toast for this button */ }
  }, [messages]);

  const filteredConvs = historyFilter.trim()
    ? conversations.filter(c => c.title.toLowerCase().includes(historyFilter.toLowerCase()))
    : conversations;
  const grouped = groupByDate(filteredConvs);

  return (
    <div className="chatview-overlay">
      <aside className="chatview-sidebar">
        <div className="chatview-sidebar__top">
          <button className="chatview-sidebar__close" onClick={onClose} title={t('pomodoro.close')}>
            <X size={15} />
          </button>
          <button className="chatview-sidebar__new" onClick={newConversation}>
            <Plus size={13} /> {t('ai.convNew')}
          </button>
        </div>
        <div className="chatview-sidebar__search">
          <Search size={12} />
          <input
            placeholder={t('ai.ragInputPlaceholder')}
            value={historyFilter}
            onChange={e => setHistoryFilter(e.target.value)}
          />
        </div>
        <div className="chatview-sidebar__list">
          {grouped.length === 0 && (
            <div className="chatview-sidebar__empty">{t('ai.convEmpty')}</div>
          )}
          {grouped.map(([dateKey, convs]) => (
            <div key={dateKey} className="chatview-sidebar__group">
              <div className="chatview-sidebar__group-label">{sectionLabel(dateKey, t)}</div>
              {convs.map(c => (
                <div
                  key={c.id}
                  className={`chatview-sidebar__item${c.id === activeConvId ? ' active' : ''}`}
                  onClick={() => loadConversation(c.id)}
                >
                  <MessageSquare size={12} className="chatview-sidebar__item-icon" />
                  <span className="chatview-sidebar__item-title">{c.title}</span>
                  <button
                    className="chatview-sidebar__item-action"
                    onClick={e => { e.stopPropagation(); renameConversation(c.id, c.title); }}
                    title={t('ai.convRename')}
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    className="chatview-sidebar__item-action chatview-sidebar__item-action--danger"
                    onClick={e => { e.stopPropagation(); deleteConversation(c.id); }}
                    title={t('ai.convDelete')}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <main className="chatview-main">
        <div className="chatview-main__header">
          <div className="chatview-main__title">{activeTitle}</div>
          <select
            className="chatview-main__model"
            value={model}
            onChange={e => { setModel(e.target.value); localStorage.setItem(SAVED_MODEL_KEY, e.target.value); }}
            disabled={!models.length}
          >
            {models.length === 0
              ? <option value={defaultModel}>{defaultModel}</option>
              : models.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div className="chatview-main__messages">
          {messages.length === 0 && (
            <div className="ai-panel__empty">
              <MessageSquare size={32} />
              <div>{t('ai.ragPlaceholder')}</div>
            </div>
          )}
          {messages.map((msg, i) => (
            <ChatMessage
              key={i}
              msg={msg}
              index={i}
              isLast={i === messages.length - 1}
              streaming={streaming}
              onFollowup={handleFollowup}
              onAddToNotebook={handleAddToNotebook}
            />
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="chatview-main__input-area">
          <textarea
            className="chatview-main__input"
            placeholder={t('ai.ragInputPlaceholder')}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            rows={1}
          />
          <button
            className="chatview-main__send"
            onClick={() => { if (streaming) { abortRef.current?.abort(); setStreaming(false); } else { send(); } }}
            disabled={!streaming && !query.trim()}
          >
            {streaming ? '■' : t('ai.send')}
          </button>
        </div>
      </main>
    </div>
  );
}
