import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X, Sparkles, Send, FileText, Tag, Pencil, Bot, Settings,
  Search, Link, Zap, ArrowDownToLine, Loader, ChevronDown, ChevronUp, Workflow,
  MessageSquare, Plus, Trash2, Brain, Check,
} from 'lucide-react';
import { useOllamaModels, streamLocalOllamaChat, fetchChatPreamble } from '../hooks/useOllama';
import { suggestTags, suggestLinks, generateFlashcards, generateDiagram } from '../lib/aiPrompts';
import { useAgentMemory, MemoryProposal } from '../hooks/useAgentMemory';
import OllamaSetup from './OllamaSetup';
import ModelManager from './ModelManager';
import './AIPanel.scss';

/* ─── Types ─── */

interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: RagSource[];
}

interface RagSource {
  pad_id: string;
  pad_name: string;
  score: number;
}

interface LinkSuggestion {
  name: string;
  accepted: boolean | null;
}

interface ConvSummary {
  id: string;
  title: string;
  message_count: number;
  updated_at: string;
}

interface Props {
  onClose: () => void;
  padId?: string;
  docContext?: string;
  padTitle?: string;
  padTitles?: string[];
  onSuggestTags?: (tags: string[]) => void;
  onInsertContent?: (content: string) => void;
}

type PanelMode = 'chat' | 'rag' | 'memory';

const SAVED_MODEL_KEY = 'pad-ws-ai-model';
const CUSTOM_PROMPT_KEY = 'alcove-ai-custom-prompt';

function filterThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/* ─── Component ─── */

export default function AIPanel({
  onClose, padId, docContext, padTitle, padTitles = [], onSuggestTags, onInsertContent,
}: Props) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith('fr') ? 'fr' : 'en';
  const ollamaStatus = useOllamaModels();
  const { modelNames: models, defaultModel } = ollamaStatus;
  const [available, setAvailable] = useState(ollamaStatus.available);
  const [starting, setStarting] = useState(ollamaStatus.starting);
  useEffect(() => { setAvailable(ollamaStatus.available); setStarting(ollamaStatus.starting); }, [ollamaStatus.available, ollamaStatus.starting]);

  const [setupDone, setSetupDone] = useState(false);
  const [showModelMgr, setShowModelMgr] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>('chat');

  /* ── Custom prompt (layered on top of the built-in system prompt) ── */
  const [customPrompt, setCustomPrompt] = useState<string>(() => localStorage.getItem(CUSTOM_PROMPT_KEY) ?? '');
  const [showPromptSettings, setShowPromptSettings] = useState(false);
  const saveCustomPrompt = useCallback((p: string) => {
    setCustomPrompt(p);
    localStorage.setItem(CUSTOM_PROMPT_KEY, p);
  }, []);

  /* ── Chat state ── */
  const [model, setModel] = useState<string>(() => localStorage.getItem(SAVED_MODEL_KEY) ?? defaultModel);
  const saveModel = useCallback(
    (m: string) => { setModel(m); localStorage.setItem(SAVED_MODEL_KEY, m); },
    [],
  );

  // Auto-select first available model if the saved/default model is not installed
  useEffect(() => {
    if (models.length > 0 && !models.includes(model)) saveModel(models[0]);
  }, [models, model, saveModel]);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* ── RAG state ── */
  const [ragQuery, setRagQuery] = useState('');
  const [ragStreaming, setRagStreaming] = useState(false);
  const [ragMessages, setRagMessages] = useState<Message[]>([]);
  const [indexing, setIndexing] = useState(false);
  const [indexLogs, setIndexLogs] = useState<string[]>([]);
  const [showIndexLogs, setShowIndexLogs] = useState(false);
  const ragBottomRef = useRef<HTMLDivElement>(null);

  /* ── Suggest links state ── */
  const [linkSuggestions, setLinkSuggestions] = useState<LinkSuggestion[] | null>(null);
  const [suggestingLinks, setSuggestingLinks] = useState(false);

  /* ── Flashcard gen state ── */
  const [generatingFlashcards, setGeneratingFlashcards] = useState(false);

  /* ── Diagram gen state ── */
  const [generatingDiagram, setGeneratingDiagram] = useState(false);

  /* ── Agent memory (wiki-LLM) ── */
  const memory = useAgentMemory();
  const [proposal, setProposal] = useState<MemoryProposal | null>(null);
  const [proposalSaving, setProposalSaving] = useState(false);
  const proposalCheckRef = useRef(0);

  /* ── Conversation memory (persisted per pad) ── */
  const [conversations, setConversations] = useState<ConvSummary[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const loadConversations = useCallback(async () => {
    try {
      const url = padId ? `/api/ai/conversations?pad_id=${padId}` : '/api/ai/conversations';
      const r = await fetch(url);
      const d = await r.json();
      setConversations(d.conversations || []);
    } catch { /* offline — non-fatal */ }
  }, [padId]);

  // Reload the conversation list when the pad changes; reset the active thread.
  useEffect(() => {
    setActiveConvId(null);
    setMessages([]);
    loadConversations();
  }, [padId, loadConversations]);

  // Auto-persist the current thread once streaming settles (debounced).
  useEffect(() => {
    if (streaming || messages.length === 0) return;
    const timer = setTimeout(async () => {
      try {
        if (activeConvId) {
          await fetch(`/api/ai/conversations/${activeConvId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages }),
          });
        } else {
          const r = await fetch('/api/ai/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, pad_id: padId ?? null }),
          });
          const d = await r.json();
          if (d.id) setActiveConvId(d.id);
        }
        loadConversations();
      } catch { /* offline — keep local copy */ }
    }, 1200);
    return () => clearTimeout(timer);
  }, [messages, streaming, activeConvId, padId, loadConversations]);

  const newConversation = useCallback(() => {
    setMessages([]);
    setActiveConvId(null);
    setShowHistory(false);
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/ai/conversations/${id}`);
      const d = await r.json();
      setMessages((d.messages || []) as Message[]);
      setActiveConvId(id);
      setShowHistory(false);
    } catch { /* ignore */ }
  }, []);

  const deleteConversation = useCallback(async (id: string) => {
    try {
      await fetch(`/api/ai/conversations/${id}`, { method: 'DELETE' });
      if (id === activeConvId) { setMessages([]); setActiveConvId(null); }
      loadConversations();
    } catch { /* ignore */ }
  }, [activeConvId, loadConversations]);

  const renameConversation = useCallback(async (id: string, current: string) => {
    const title = window.prompt(t('ai.convRename'), current);
    if (title === null || !title.trim()) return;
    try {
      await fetch(`/api/ai/conversations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() }),
      });
      loadConversations();
    } catch { /* ignore */ }
  }, [t, loadConversations]);

  useEffect(() => {
    if (!localStorage.getItem(SAVED_MODEL_KEY) && defaultModel) saveModel(defaultModel);
  }, [defaultModel, saveModel]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => { ragBottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [ragMessages]);

  /* Whenever a full assistant turn just settled, ask the model if anything
     durable is worth saving to memory. Runs at most once per turn thanks to
     the ref-based dedup. */
  useEffect(() => {
    if (streaming) return;
    if (messages.length < 2) return;
    const last = messages[messages.length - 1];
    if (last.role !== 'assistant' || !last.content.trim()) return;
    // Dedup: only run once per settled turn.
    const stamp = messages.length;
    if (proposalCheckRef.current === stamp) return;
    proposalCheckRef.current = stamp;
    const timer = setTimeout(async () => {
      const p = await memory.extract(
        messages.map(m => ({ role: m.role, content: m.content })),
      );
      if (p) setProposal(p);
    }, 800);
    return () => clearTimeout(timer);
  }, [messages, streaming, memory]);

  const acceptProposal = useCallback(async () => {
    if (!proposal) return;
    setProposalSaving(true);
    const ok = await memory.write(
      proposal.target,
      proposal.section ? 'replace_section' : 'append',
      proposal.content,
      proposal.section,
      proposal.reason,
    );
    setProposalSaving(false);
    if (ok) setProposal(null);
  }, [proposal, memory]);

  const dismissProposal = useCallback(() => setProposal(null), []);

  /* ── Chat send ── */
  const send = useCallback(async (userContent: string, systemPrefix?: string) => {
    if (!userContent.trim() || streaming) return;
    setInput('');
    const userMsg: Message = { role: 'user', content: userContent };
    setMessages(prev => [...prev, userMsg]);
    setStreaming(true);

    const history = [...messages, userMsg];

    // Compose the system prompt entirely on the client now:
    //   [server preamble = BASE + agent memory] + [localStorage custom_prompt] + [systemPrefix]
    // then stream from the user's own Ollama at localhost.
    let mergedSystem = '';
    try {
      const { system } = await fetchChatPreamble();
      mergedSystem = system;
    } catch {
      // Preamble is best-effort — if it fails we still ship a chat, just
      // without the assistant memory / base persona.
    }
    if (customPrompt.trim()) {
      mergedSystem += (mergedSystem ? '\n\n' : '')
        + `Instructions supplémentaires de l'utilisateur :\n${customPrompt.trim().slice(0, 2000)}`;
    }
    if (systemPrefix) {
      mergedSystem += (mergedSystem ? '\n\n' : '') + systemPrefix;
    }

    const apiMessages = mergedSystem
      ? [{ role: 'system', content: mergedSystem }, ...history.map(m => ({ role: m.role, content: m.content }))]
      : history.map(m => ({ role: m.role, content: m.content }));

    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      await streamLocalOllamaChat(model, apiMessages, (chunk) => {
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { ...copy[copy.length - 1], content: copy[copy.length - 1].content + chunk };
          return copy;
        });
      }, ctrl.signal);
    } catch (e: unknown) {
      if ((e as Error)?.name !== 'AbortError') {
        const msg = (e as Error)?.message || t('ai.error');
        setMessages(prev => { const copy = [...prev]; copy[copy.length - 1] = { role: 'assistant', content: msg }; return copy; });
      }
    } finally { setStreaming(false); abortRef.current = null; }
  }, [messages, model, streaming, t, customPrompt]);

  const handleSubmit = () => {
    if (streaming) { abortRef.current?.abort(); setStreaming(false); return; }
    send(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  /* ── Quick actions ── */
  const handleSummarize = () => {
    if (!docContext) return;
    const prompt = lang === 'fr'
      ? `Résume ce document en 3-5 points clés :\n\n${docContext.slice(0, 6000)}`
      : `Summarize this document in 3-5 key points:\n\n${docContext.slice(0, 6000)}`;
    send(prompt);
  };

  const handleSuggestTags = async () => {
    if (!docContext || !onSuggestTags) return;
    try {
      setStreaming(true);
      const tags = await suggestTags(model, docContext, padTitle ?? '', lang);
      onSuggestTags(tags);
      setMessages(prev => [...prev, { role: 'assistant', content: tags.length
        ? `${t('ai.tagsApplied')} : ${tags.map(tg => `#${tg}`).join(', ')}`
        : t('ai.noTags') }]);
    } catch { setMessages(prev => [...prev, { role: 'assistant', content: t('ai.error') }]); }
    finally { setStreaming(false); }
  };

  const handleImprove = () => {
    if (!docContext) return;
    const prompt = lang === 'fr'
      ? `Améliore le style et la clarté de ce texte sans changer son sens :\n\n${docContext.slice(0, 4000)}`
      : `Improve the style and clarity of this text without changing its meaning:\n\n${docContext.slice(0, 4000)}`;
    send(prompt);
  };

  /* ── Suggest links ── */
  const handleSuggestLinks = async () => {
    if (!docContext || !padTitles.length) return;
    setSuggestingLinks(true);
    setLinkSuggestions(null);
    try {
      const suggs = await suggestLinks(model, docContext, padTitles, lang);
      setLinkSuggestions(suggs.map(name => ({ name, accepted: null })));
    } catch { setLinkSuggestions([]); }
    finally { setSuggestingLinks(false); }
  };

  const acceptLink = (name: string) => {
    onInsertContent?.(`[[${name}]]`);
    setLinkSuggestions(prev => prev?.map(l => l.name === name ? { ...l, accepted: true } : l) ?? null);
  };

  const rejectLink = (name: string) => {
    setLinkSuggestions(prev => prev?.map(l => l.name === name ? { ...l, accepted: false } : l) ?? null);
  };

  /* ── Generate flashcards ── */
  const handleGenerateFlashcards = async () => {
    if (!docContext || !onInsertContent) return;
    setGeneratingFlashcards(true);
    try {
      const cards = await generateFlashcards(model, docContext, lang);
      if (cards) onInsertContent(cards);
    } finally { setGeneratingFlashcards(false); }
  };

  /* ── Generate Mermaid diagram ── */
  const handleGenerateDiagram = async () => {
    if (!docContext || !onInsertContent) return;
    setGeneratingDiagram(true);
    try {
      const diagram = await generateDiagram(model, docContext, undefined, lang);
      if (diagram) onInsertContent(`\n\n${diagram}\n`);
      else setMessages(prev => [...prev, { role: 'assistant', content: t('ai.error') }]);
    } catch { setMessages(prev => [...prev, { role: 'assistant', content: t('ai.error') }]); }
    finally { setGeneratingDiagram(false); }
  };

  /* ── RAG ── */
  const handleIndexAll = async () => {
    setIndexing(true);
    setIndexLogs([]);
    setShowIndexLogs(true);
    try {
      const resp = await fetch('/api/ai/index-all', { method: 'POST' });
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') break;
          try {
            const evt = JSON.parse(payload);
            if (evt.kind !== 'done') setIndexLogs(prev => [...prev, evt.msg]);
          } catch { /* skip */ }
        }
      }
    } finally { setIndexing(false); }
  };

  const handleRagSend = async () => {
    if (!ragQuery.trim() || ragStreaming) return;
    const q = ragQuery;
    setRagQuery('');
    setRagMessages(prev => [...prev, { role: 'user', content: q }]);
    setRagStreaming(true);
    setRagMessages(prev => [...prev, { role: 'assistant', content: '', sources: [] }]);

    try {
      const resp = await fetch('/api/ai/rag-chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, lang }),
      });
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') break;
          try {
            const evt = JSON.parse(payload);
            if (evt.kind === 'sources') {
              setRagMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = { ...copy[copy.length - 1], sources: evt.sources };
                return copy;
              });
            } else if (evt.message?.content) {
              setRagMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = { ...copy[copy.length - 1], content: copy[copy.length - 1].content + evt.message.content };
                return copy;
              });
            }
          } catch { /* skip */ }
        }
      }
    } finally { setRagStreaming(false); }
  };

  /* ── Setup handlers ── */
  const handleSetupDone = () => {
    setSetupDone(true);
    setAvailable(true);
    fetch('/api/ai/models').then(r => r.json()).then(d => {
      if (d.models?.length) saveModel(typeof d.models[0] === 'string' ? d.models[0] : d.models[0].name);
    }).catch(() => {});
  };

  const hasDoc = Boolean(docContext);
  const isAvailable = available !== false || setupDone;

  return (
    <div className="ai-panel">
      {/* Header */}
      <div className="ai-panel__header">
        <div className="ai-panel__header-title">
          <Sparkles size={14} />
          {t('ai.title')}
        </div>
        <span className={`ai-panel__header-badge${!isAvailable ? (starting ? ' ai-panel__header-badge--starting' : ' ai-panel__header-badge--offline') : ''}`}>
          {available === null ? '…' : isAvailable ? 'Ollama' : starting ? 'Démarrage…' : t('ai.offline')}
        </span>
        {isAvailable && (
          <button
            className={`ai-panel__mgr-btn${showModelMgr ? ' ai-panel__mgr-btn--active' : ''}`}
            onClick={() => setShowModelMgr(v => !v)}
            title="Gérer les modèles"
          >
            <Settings size={13} />
          </button>
        )}
        <button className="ai-panel__close" onClick={onClose} title={t('pomodoro.close')}>
          <X size={15} />
        </button>
      </div>

      {/* Auto-starting state */}
      {!isAvailable && starting && (
        <div className="ai-panel__starting">
          <div className="ai-panel__starting-spinner" />
          <span>Démarrage d'Ollama…</span>
        </div>
      )}

      {/* Setup wizard (only if not installed or not auto-starting) */}
      {!isAvailable && !starting && <OllamaSetup onDone={handleSetupDone} />}

      {/* Model manager */}
      {showModelMgr && isAvailable && (
        <ModelManager
          installedModels={ollamaStatus.models}
          onModelsChanged={() => setShowModelMgr(false)}
          onRefresh={ollamaStatus.refresh}
        />
      )}

      {/* Main UI */}
      {isAvailable && !showModelMgr && (
        <>
          {/* Mode tabs */}
          <div className="ai-panel__mode-tabs">
            <button
              className={`ai-panel__mode-tab${panelMode === 'chat' ? ' ai-panel__mode-tab--active' : ''}`}
              onClick={() => setPanelMode('chat')}
            >
              <Bot size={12} /> Chat
            </button>
            <button
              className={`ai-panel__mode-tab${panelMode === 'rag' ? ' ai-panel__mode-tab--active' : ''}`}
              onClick={() => setPanelMode('rag')}
            >
              <Search size={12} /> {t('ai.ragMode')}
            </button>
            <button
              className={`ai-panel__mode-tab${panelMode === 'memory' ? ' ai-panel__mode-tab--active' : ''}`}
              onClick={() => setPanelMode('memory')}
              title={t('ai.memoryTabTitle', 'Mémoire persistante de l\'assistant')}
            >
              <Brain size={12} /> {t('ai.memoryMode', 'Mémoire')}
            </button>
          </div>

          {/* ── CHAT MODE ── */}
          {panelMode === 'chat' && (
            <>
              {/* Conversation bar — history + new thread */}
              <div className="ai-panel__conv-bar">
                <button
                  className={`ai-panel__conv-btn${showHistory ? ' ai-panel__conv-btn--active' : ''}`}
                  onClick={() => setShowHistory(v => !v)}
                  title={t('ai.convHistory')}
                >
                  <MessageSquare size={13} />
                  <span>{t('ai.convHistory')}</span>
                  {conversations.length > 0 && <span className="ai-panel__conv-count">{conversations.length}</span>}
                </button>
                <button
                  className="ai-panel__conv-btn"
                  onClick={newConversation}
                  disabled={messages.length === 0 && !activeConvId}
                  title={t('ai.convNew')}
                >
                  <Plus size={13} />
                  <span>{t('ai.convNew')}</span>
                </button>
              </div>

              {showHistory && (
                <div className="ai-panel__conv-list">
                  {conversations.length === 0 && (
                    <div className="ai-panel__conv-empty">{t('ai.convEmpty')}</div>
                  )}
                  {conversations.map(c => (
                    <div
                      key={c.id}
                      className={`ai-panel__conv-item${c.id === activeConvId ? ' ai-panel__conv-item--active' : ''}`}
                      onClick={() => loadConversation(c.id)}
                    >
                      <MessageSquare size={12} className="ai-panel__conv-item-icon" />
                      <span className="ai-panel__conv-item-title">{c.title}</span>
                      <span className="ai-panel__conv-item-count">{c.message_count}</span>
                      <button
                        className="ai-panel__conv-item-action"
                        onClick={e => { e.stopPropagation(); renameConversation(c.id, c.title); }}
                        title={t('ai.convRename')}
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        className="ai-panel__conv-item-action ai-panel__conv-item-action--danger"
                        onClick={e => { e.stopPropagation(); deleteConversation(c.id); }}
                        title={t('ai.convDelete')}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Model picker */}
              <div className="ai-panel__model-bar">
                <label>{t('ai.model')}</label>
                <select value={model} onChange={e => saveModel(e.target.value)} disabled={!models.length}>
                  {models.length === 0
                    ? <option value={defaultModel}>{defaultModel}</option>
                    : models.map(m => <option key={m} value={m}>{m}</option>)
                  }
                </select>
                <button
                  className={`ai-panel__prompt-btn${showPromptSettings ? ' ai-panel__prompt-btn--active' : ''}${customPrompt.trim() ? ' ai-panel__prompt-btn--set' : ''}`}
                  onClick={() => setShowPromptSettings(v => !v)}
                  title={t('ai.customPromptTitle', 'Instructions personnalisées')}
                >
                  <Pencil size={12} />
                </button>
              </div>

              {/* Custom prompt settings */}
              {showPromptSettings && (
                <div className="ai-panel__prompt-settings">
                  <div className="ai-panel__prompt-settings-label">
                    {t('ai.customPromptLabel', 'Instructions personnalisées (ajoutées à chaque conversation)')}
                  </div>
                  <textarea
                    value={customPrompt}
                    onChange={e => saveCustomPrompt(e.target.value)}
                    placeholder={t('ai.customPromptPlaceholder', 'Ex : Réponds toujours en français. Tutoie-moi. Sois très concis…')}
                    rows={3}
                    maxLength={2000}
                  />
                  {customPrompt.trim() && (
                    <button className="ai-panel__prompt-clear" onClick={() => saveCustomPrompt('')}>
                      {t('ai.customPromptClear', 'Effacer')}
                    </button>
                  )}
                </div>
              )}

              {/* Quick actions */}
              {hasDoc && (
                <div className="ai-panel__quick-actions">
                  <button className="ai-panel__quick-btn" onClick={handleSummarize} disabled={streaming}>
                    <FileText size={12} /> {t('ai.summarize')}
                  </button>
                  {onSuggestTags && (
                    <button className="ai-panel__quick-btn" onClick={handleSuggestTags} disabled={streaming}>
                      <Tag size={12} /> {t('ai.suggestTags')}
                    </button>
                  )}
                  <button className="ai-panel__quick-btn" onClick={handleImprove} disabled={streaming}>
                    <Pencil size={12} /> {t('ai.improve')}
                  </button>
                  <button className="ai-panel__quick-btn" onClick={handleSuggestLinks} disabled={streaming || suggestingLinks}>
                    {suggestingLinks ? <Loader size={12} className="ai-spin" /> : <Link size={12} />} {t('ai.suggestLinks')}
                  </button>
                  {onInsertContent && (
                    <button className="ai-panel__quick-btn" onClick={handleGenerateFlashcards} disabled={streaming || generatingFlashcards}>
                      {generatingFlashcards ? <Loader size={12} className="ai-spin" /> : <Zap size={12} />} {t('ai.generateFlashcards')}
                    </button>
                  )}
                  {onInsertContent && (
                    <button className="ai-panel__quick-btn" onClick={handleGenerateDiagram} disabled={streaming || generatingDiagram}>
                      {generatingDiagram ? <Loader size={12} className="ai-spin" /> : <Workflow size={12} />} {t('ai.generateDiagram')}
                    </button>
                  )}
                </div>
              )}

              {/* Link suggestions */}
              {linkSuggestions !== null && linkSuggestions.length > 0 && (
                <div className="ai-panel__link-suggestions">
                  <div className="ai-panel__link-suggestions-title">{t('ai.suggestedLinks')}</div>
                  {linkSuggestions.map(l => (
                    <div key={l.name} className={`ai-panel__link-row${l.accepted === true ? ' ai-panel__link-row--accepted' : l.accepted === false ? ' ai-panel__link-row--rejected' : ''}`}>
                      <span className="ai-panel__link-name">[[{l.name}]]</span>
                      {l.accepted === null && (
                        <div className="ai-panel__link-actions">
                          <button onClick={() => acceptLink(l.name)} title="Insérer">✓</button>
                          <button onClick={() => rejectLink(l.name)} title="Ignorer">✕</button>
                        </div>
                      )}
                      {l.accepted === true && <span className="ai-panel__link-status">✓ inséré</span>}
                      {l.accepted === false && <span className="ai-panel__link-status ai-panel__link-status--ko">ignoré</span>}
                    </div>
                  ))}
                </div>
              )}
              {linkSuggestions !== null && linkSuggestions.length === 0 && !suggestingLinks && (
                <div className="ai-panel__link-suggestions ai-panel__link-suggestions--empty">
                  {t('ai.noLinks')}
                </div>
              )}

              {/* Messages */}
              <div className="ai-panel__messages">
                {messages.length === 0 && (
                  <div className="ai-panel__empty">
                    <Bot size={32} />
                    <div>{t('ai.placeholder')}</div>
                  </div>
                )}
                {messages.map((msg, i) => {
                  const displayed = msg.role === 'assistant' ? filterThinkBlocks(msg.content) : msg.content;
                  const showThinking = (displayed === '') && streaming && i === messages.length - 1;
                  return (
                    <div key={i} className={`ai-msg ai-msg--${msg.role}`}>
                      <div className="ai-msg__role">
                        {msg.role === 'user' ? t('ai.you') : t('ai.assistant')}
                      </div>
                      {showThinking ? (
                        <div className="ai-msg__thinking"><span /><span /><span /></div>
                      ) : (
                        <>
                          <div className="ai-msg__content">{displayed}</div>
                          {msg.role === 'assistant' && displayed && onInsertContent && (
                            <button
                              className="ai-msg__insert-btn"
                              onClick={() => onInsertContent(displayed)}
                              title={t('ai.insertIntoPad')}
                            >
                              <ArrowDownToLine size={11} /> {t('ai.insertIntoPad')}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              {/* Memory proposal chip — appears after a turn if the model
                  detected a durable fact worth saving. */}
              {proposal && (
                <div className="ai-panel__memory-proposal">
                  <div className="ai-panel__memory-proposal-head">
                    <Brain size={12} />
                    <span>
                      {t('ai.memoryProposeIntro', 'À ajouter à')}{' '}
                      <strong>[[{proposal.target}]]</strong>
                      {proposal.section && <> · <em>{proposal.section}</em></>}
                    </span>
                  </div>
                  <div className="ai-panel__memory-proposal-body">
                    {proposal.content}
                  </div>
                  {proposal.reason && (
                    <div className="ai-panel__memory-proposal-reason">
                      {proposal.reason}
                    </div>
                  )}
                  <div className="ai-panel__memory-proposal-actions">
                    <button
                      className="ai-panel__memory-btn ai-panel__memory-btn--primary"
                      onClick={acceptProposal}
                      disabled={proposalSaving}
                    >
                      {proposalSaving
                        ? <Loader size={11} className="ai-spin" />
                        : <Check size={11} />}
                      {' '}{t('ai.memoryAccept', 'Mémoriser')}
                    </button>
                    <button
                      className="ai-panel__memory-btn"
                      onClick={dismissProposal}
                      disabled={proposalSaving}
                    >
                      {t('ai.memoryDismiss', 'Ignorer')}
                    </button>
                  </div>
                </div>
              )}

              {/* Input */}
              <div className="ai-panel__input-area">
                <textarea
                  ref={inputRef}
                  className="ai-panel__input"
                  placeholder={t('ai.inputPlaceholder')}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={1}
                />
                <button
                  className="ai-panel__send"
                  onClick={handleSubmit}
                  disabled={!streaming && !input.trim()}
                  title={streaming ? t('ai.stop') : t('ai.send')}
                >
                  {streaming ? '■' : <Send size={14} />}
                </button>
              </div>
            </>
          )}

          {/* ── RAG MODE ── */}
          {panelMode === 'rag' && (
            <>
              {/* Index controls */}
              <div className="ai-panel__rag-header">
                <div className="ai-panel__rag-desc">{t('ai.ragDesc')}</div>
                <button
                  className="ai-panel__rag-index-btn"
                  onClick={handleIndexAll}
                  disabled={indexing}
                >
                  {indexing
                    ? <><Loader size={11} className="ai-spin" /> {t('ai.ragIndexing')}</>
                    : t('ai.ragIndexAll')
                  }
                </button>
                {indexLogs.length > 0 && (
                  <div className="ai-panel__rag-index-logs">
                    <button className="ai-panel__logs-toggle" onClick={() => setShowIndexLogs(v => !v)}>
                      Logs {showIndexLogs ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                    </button>
                    {showIndexLogs && (
                      <div className="ai-panel__rag-log-box">
                        {indexLogs.map((l, i) => <div key={i} className="ai-panel__rag-log-line">{l}</div>)}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* RAG messages */}
              <div className="ai-panel__messages">
                {ragMessages.length === 0 && (
                  <div className="ai-panel__empty">
                    <Search size={32} />
                    <div>{t('ai.ragPlaceholder')}</div>
                  </div>
                )}
                {ragMessages.map((msg, i) => (
                  <div key={i} className={`ai-msg ai-msg--${msg.role}`}>
                    <div className="ai-msg__role">
                      {msg.role === 'user' ? t('ai.you') : t('ai.assistant')}
                    </div>
                    {msg.content === '' && ragStreaming && i === ragMessages.length - 1 ? (
                      <div className="ai-msg__thinking"><span /><span /><span /></div>
                    ) : (
                      <>
                        <div className="ai-msg__content">{msg.content}</div>
                        {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
                          <div className="ai-msg__sources">
                            <div className="ai-msg__sources-label">{t('ai.sources')}</div>
                            {msg.sources.map(s => (
                              <span key={s.pad_id} className="ai-msg__source-chip">
                                {s.pad_name} <span className="ai-msg__source-score">{Math.round(s.score * 100)}%</span>
                              </span>
                            ))}
                          </div>
                        )}
                        {msg.role === 'assistant' && msg.content && onInsertContent && (
                          <button className="ai-msg__insert-btn" onClick={() => onInsertContent(msg.content)} title={t('ai.insertIntoPad')}>
                            <ArrowDownToLine size={11} /> {t('ai.insertIntoPad')}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ))}
                <div ref={ragBottomRef} />
              </div>

              {/* RAG input */}
              <div className="ai-panel__input-area">
                <textarea
                  className="ai-panel__input"
                  placeholder={t('ai.ragInputPlaceholder')}
                  value={ragQuery}
                  onChange={e => setRagQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleRagSend(); } }}
                  rows={1}
                />
                <button
                  className="ai-panel__send"
                  onClick={handleRagSend}
                  disabled={!ragQuery.trim() || ragStreaming}
                >
                  {ragStreaming ? '■' : <Search size={14} />}
                </button>
              </div>
            </>
          )}

          {/* ── MEMORY MODE ── */}
          {panelMode === 'memory' && (
            <div className="ai-panel__memory-pane">
              <div className="ai-panel__memory-intro">
                {t(
                  'ai.memoryIntro',
                  "Notes durables que l'assistant garde d'une conversation à l'autre. Chaque entrée est un pad Markdown dans le dossier _agent — modifiable à la main, versionné, jamais synchronisé ailleurs.",
                )}
              </div>
              {memory.loading && memory.slots.length === 0 && (
                <div className="ai-panel__memory-loading">
                  <Loader size={14} className="ai-spin" />
                </div>
              )}
              {memory.slots.map(slot => {
                const trimmed = slot.content.trim();
                // Strip the seed header for the preview — same logic as the
                // backend prompt injection.
                const body = trimmed
                  .replace(/^#\s+.*\n+(_.*_\n+)?/, '')
                  .trim();
                return (
                  <div key={slot.slug} className="ai-panel__memory-slot">
                    <div className="ai-panel__memory-slot-head">
                      <Brain size={12} />
                      <span className="ai-panel__memory-slot-name">
                        {slot.display_name}
                      </span>
                      {slot.pad_id && (
                        <a
                          className="ai-panel__memory-slot-open"
                          href={`/pad/${slot.pad_id}`}
                          target="_blank"
                          rel="noreferrer"
                          title={t('ai.memoryOpen', 'Ouvrir le pad')}
                        >
                          <ArrowDownToLine size={11} />
                        </a>
                      )}
                    </div>
                    <div className="ai-panel__memory-slot-body">
                      {body || (
                        <span className="ai-panel__memory-slot-empty">
                          {t('ai.memoryEmpty', '(vide — sera rempli par l\'assistant au fil des conversations)')}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
