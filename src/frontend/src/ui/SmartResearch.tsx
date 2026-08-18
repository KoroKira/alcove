import React, { useState } from 'react';
import { X, Telescope, Loader2, CheckCircle, Sparkles, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './AddFromLink.scss';

interface Props {
  onClose: () => void;
  onCreated: (id: string) => void;
}

interface ResearchResult {
  content: string;
  sources_md: string;
  sources: { idx: number; title: string; url: string }[];
  intent?: string;
  subquestions?: string[];
}

// Consume the /api/research SSE stream: forward progress, return the result.
async function runResearch(
  topic: string, lang: string, length: string, depth: number, onProgress: (msg: string) => void,
): Promise<ResearchResult | null> {
  const resp = await fetch('/api/research', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, lang, length, depth }),
  });
  const reader = resp.body!.getReader();
  const dec = new TextDecoder();
  let buf = '', result: ResearchResult | null = null, err: string | null = null;
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
        else if (o.kind === 'document') result = o as ResearchResult;
        else if (o.kind === 'error') err = o.error;
      } catch { /* ignore */ }
    }
  }
  if (err) throw new Error(err);
  return result;
}

export default function SmartResearch({ onClose, onCreated }: Props) {
  const { i18n } = useTranslation();
  const lang = i18n.language.startsWith('fr') ? 'fr' : 'en';

  const [topic, setTopic] = useState('');
  const [length, setLength] = useState<'short' | 'long'>('long');
  const [depth, setDepth] = useState<1 | 2 | 3>(1);
  const [step, setStep] = useState<'input' | 'processing' | 'done'>('input');
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const log = (s: string) => setLogs(l => [...l, s]);

  const run = async () => {
    const t = topic.trim();
    if (!t) return;
    setStep('processing');
    setLogs([]);
    setError(null);
    try {
      const res = await runResearch(t, lang, length, depth, log);
      if (!res || !res.content) throw new Error('Aucune synthèse produite.');

      const date = new Date().toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-US');
      const header = `> [!NOTE] Recherche · ${date} · ${res.sources.length} sources · moteur : DuckDuckGo${res.intent ? `\n> 🎯 ${res.intent}` : ''}`;
      const content = [`# Recherche : ${t}`, header, res.content, `## Sources\n\n${res.sources_md}`].join('\n\n');

      log('📄 Création de la note…');
      const cr = await fetch('/api/pad/new', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pad_type: 'document', display_name: `Recherche : ${t}`.slice(0, 100) }),
      });
      if (!cr.ok) throw new Error('Création de la note échouée');
      const padId = (await cr.json()).id;
      await fetch(`/api/pad/${padId}/doc`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, format: 'markdown' }),
      });

      log('🏷️ Tags automatiques…');
      try {
        const { suggestTags } = await import('../lib/aiPrompts');
        const model = localStorage.getItem('pad-ws-ai-model') || 'llama3.2';
        const tags = await suggestTags(model, res.content, t, lang);
        if (tags.length) {
          await fetch(`/api/pad/${padId}/tags`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags }),
          });
        }
      } catch { /* non-blocking */ }

      log('📇 Indexation RAG…');
      try {
        const { indexPad } = await import('../lib/rag');
        await indexPad(padId);
      } catch { /* non-blocking — user can retry via "Réindexer tout" */ }

      log('✅ Terminé');
      setStep('done');
      onCreated(padId);
    } catch (e: any) {
      setError(e.message || String(e));
      setStep('input');
    }
  };

  return (
    <div className="addlink__backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="addlink__panel" role="dialog">
        <div className="addlink__header">
          <span className="addlink__title"><Telescope size={14} /> Smart Research</span>
          <button className="addlink__close" onClick={onClose}><X size={14} /></button>
        </div>

        {step === 'input' && (
          <div className="addlink__body">
            <label className="addlink__label">Sur quoi veux-tu une note ?</label>
            <textarea
              className="addlink__input"
              rows={3}
              autoFocus
              placeholder="ex : les ESATs en France en 2025-2026"
              value={topic}
              onChange={e => setTopic(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && topic.trim()) run(); }}
            />
            <label className="addlink__label">Profondeur</label>
            <div className="addlink__seg">
              <button className={`addlink__seg-btn${depth === 1 ? ' addlink__seg-btn--on' : ''}`} onClick={() => setDepth(1)}>Rapide</button>
              <button className={`addlink__seg-btn${depth === 2 ? ' addlink__seg-btn--on' : ''}`} onClick={() => setDepth(2)}>Approfondi</button>
              <button className={`addlink__seg-btn${depth === 3 ? ' addlink__seg-btn--on' : ''}`} onClick={() => setDepth(3)}>Exhaustif</button>
            </div>

            <label className="addlink__label">Longueur</label>
            <div className="addlink__seg">
              <button className={`addlink__seg-btn${length === 'short' ? ' addlink__seg-btn--on' : ''}`} onClick={() => setLength('short')}>Court</button>
              <button className={`addlink__seg-btn${length === 'long' ? ' addlink__seg-btn--on' : ''}`} onClick={() => setLength('long')}>Détaillé</button>
            </div>
            <div className="addlink__hint-row">
              🌐 Recherche via DuckDuckGo ; lecture + synthèse en local. « Approfondi » / « Exhaustif » creusent plusieurs
              niveaux de sous-questions — plus complet, mais compte plusieurs minutes (voire beaucoup) sur un petit modèle.
            </div>
            {error && <div className="addlink__error"><AlertCircle size={12} /> {error}</div>}
            <div className="addlink__footer">
              <button className="addlink__primary" disabled={!topic.trim()} onClick={run}>
                <Sparkles size={14} /> Rechercher
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
                <span className="addlink__done-msg">Note créée ✓</span>
                <button className="addlink__primary" onClick={onClose}>Ouvrir</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
