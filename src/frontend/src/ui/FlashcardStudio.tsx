import React, { useState, useEffect, useCallback } from 'react';
import { X, BookOpen, Sparkles, RotateCcw, ChevronRight, Check, Zap, AlertCircle } from 'lucide-react';
import type { Tab } from '../hooks/usePadTabs';
import './FlashcardStudio.scss';

interface Card { q: string; a: string; padId?: string; padName?: string; }
interface Deck { padId: string; padName: string; cards: Card[]; }

interface SM2Card { n: number; ef: number; interval: number; due: number; }

const SM2_KEY = 'alkopad-quiz-sm2';
const today = () => Math.floor(Date.now() / 86400000);

function loadSM2(cards: Card[]): SM2Card[] {
  const raw = localStorage.getItem(SM2_KEY);
  let saved: Record<string, SM2Card> = {};
  try { saved = raw ? JSON.parse(raw) : {}; } catch { /* empty */ }
  return cards.map((c, i) => saved[`${c.padId}-${i}-${c.q.slice(0,16)}`] ?? { n: 0, ef: 2.5, interval: 1, due: today() });
}

function saveSM2(cards: Card[], sm2: SM2Card[]) {
  const raw = localStorage.getItem(SM2_KEY);
  let saved: Record<string, SM2Card> = {};
  try { saved = raw ? JSON.parse(raw) : {}; } catch { /* empty */ }
  cards.forEach((c, i) => { saved[`${c.padId}-${i}-${c.q.slice(0,16)}`] = sm2[i]; });
  localStorage.setItem(SM2_KEY, JSON.stringify(saved));
}

function updateSM2(sm2: SM2Card[], idx: number, quality: number): SM2Card[] {
  const next = [...sm2];
  const c = next[idx];
  const ef = Math.max(1.3, c.ef + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  const interval = c.n === 0 ? 1 : c.n === 1 ? 6 : Math.round(c.interval * ef);
  next[idx] = { n: c.n + 1, ef, interval, due: today() + interval };
  return next;
}

function parseFlashcards(raw: string, padId = 'generated', padName = 'IA'): Card[] {
  const pairs: Card[] = [];
  const matches = [...raw.matchAll(/^Q:[ \t]*(.+?)$\n^A:[ \t]*(.+?)$/gm)];
  matches.forEach(m => pairs.push({ q: m[1].trim(), a: m[2].trim(), padId, padName }));
  return pairs;
}

interface Props {
  tabs: Tab[];
  onClose: () => void;
  onSelectPad: (id: string) => void;
}

export default function FlashcardStudio({ tabs, onClose, onSelectPad }: Props) {
  const docTabs = tabs.filter(t => t.padType === 'document' && !t.isScratch);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [cards, setCards] = useState<Card[]>([]);
  const [sm2, setSm2] = useState<SM2Card[]>([]);
  const [dueOnly, setDueOnly] = useState(false);
  const [queue, setQueue] = useState<number[]>([]);
  const [queueIdx, setQueueIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [score, setScore] = useState({ ok: 0, ko: 0 });
  const [done, setDone] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'generating'>('idle');
  const [error, setError] = useState('');
  const [topic, setTopic] = useState('');

  const togglePad = (id: string) => setSelectedIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const startSession = useCallback((allCards: Card[]) => {
    const newSm2 = loadSM2(allCards);
    setSm2(newSm2);
    const q = allCards
      .map((_, i) => i)
      .filter(i => !dueOnly || newSm2[i].due <= today())
      .sort(() => Math.random() - 0.5);
    setCards(allCards);
    setQueue(q);
    setQueueIdx(0);
    setFlipped(false);
    setScore({ ok: 0, ko: 0 });
    setDone(q.length === 0);
  }, [dueOnly]);

  const extract = async () => {
    if (!selectedIds.size) return;
    setStatus('loading'); setError('');
    try {
      const resp = await fetch('/api/ai/quiz/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pad_ids: [...selectedIds] }),
      });
      const data = await resp.json();
      const decks: Deck[] = data.decks ?? [];
      const all: Card[] = decks.flatMap(d => d.cards.map(c => ({ ...c, padId: d.padId, padName: d.padName })));
      if (!all.length) { setError('Aucun bloc Q:/A: trouvé dans les documents sélectionnés.'); setStatus('idle'); return; }
      startSession(all);
    } catch { setError('Erreur de connexion.'); }
    setStatus('idle');
  };

  const generate = async () => {
    if (!selectedIds.size) return;
    setStatus('generating'); setError('');
    try {
      const resp = await fetch('/api/ai/quiz/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pad_ids: [...selectedIds], topic: topic || undefined, lang: 'fr', n: 8 }),
      });
      const data = await resp.json();
      if (data.error) { setError(data.error); setStatus('idle'); return; }
      const all = parseFlashcards(data.flashcards);
      if (!all.length) { setError("L'IA n'a pas produit de flashcards. Réessaie."); setStatus('idle'); return; }
      startSession(all);
    } catch { setError('Erreur : Ollama non joignable.'); }
    setStatus('idle');
  };

  const currentCardIdx = queue[queueIdx] ?? -1;
  const currentCard = currentCardIdx >= 0 ? cards[currentCardIdx] : null;

  const answer = (quality: number) => {
    if (currentCardIdx < 0 || !flipped) return;
    const next = updateSM2(sm2, currentCardIdx, quality);
    setSm2(next);
    saveSM2(cards, next);
    setScore(s => ({ ...s, ok: quality >= 3 ? s.ok + 1 : s.ok, ko: quality < 3 ? s.ko + 1 : s.ko }));
    const nextIdx = queueIdx + 1;
    if (nextIdx >= queue.length) { setDone(true); return; }
    setQueueIdx(nextIdx);
    setFlipped(false);
  };

  const dueCount = sm2.filter(c => c.due <= today()).length;
  const progress = queue.length ? Math.round((queueIdx / queue.length) * 100) : 0;

  return (
    <div className="fc-studio" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="fc-studio__panel">

        {/* Header */}
        <div className="fc-studio__header">
          <span className="fc-studio__title"><BookOpen size={16} /> Studio de révision</span>
          <button className="fc-studio__close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="fc-studio__body">

          {/* LEFT — source selector */}
          <aside className="fc-studio__aside">
            <p className="fc-studio__aside-label">Documents sources</p>
            <div className="fc-studio__doc-list">
              {docTabs.length === 0 && <p className="fc-studio__no-docs">Aucun document</p>}
              {docTabs.map(t => (
                <label key={t.id} className={`fc-studio__doc-item${selectedIds.has(t.id) ? ' fc-studio__doc-item--checked' : ''}`}>
                  <input type="checkbox" checked={selectedIds.has(t.id)} onChange={() => togglePad(t.id)} />
                  <span>{t.title}</span>
                </label>
              ))}
            </div>

            <div className="fc-studio__topic">
              <input
                className="fc-studio__topic-input"
                placeholder="Sujet (optionnel pour l'IA)…"
                value={topic}
                onChange={e => setTopic(e.target.value)}
              />
            </div>

            <div className="fc-studio__actions">
              <button
                className="fc-studio__btn fc-studio__btn--extract"
                onClick={extract}
                disabled={!selectedIds.size || status !== 'idle'}
              >
                <BookOpen size={13} />
                {status === 'loading' ? 'Extraction…' : 'Extraire Q/A'}
              </button>
              <button
                className="fc-studio__btn fc-studio__btn--ai"
                onClick={generate}
                disabled={!selectedIds.size || status !== 'idle'}
              >
                <Sparkles size={13} />
                {status === 'generating' ? 'Génération…' : 'Générer (IA)'}
              </button>
            </div>

            {error && (
              <div className="fc-studio__error"><AlertCircle size={12} /> {error}</div>
            )}

            {cards.length > 0 && (
              <div className="fc-studio__meta">
                <span>{cards.length} cartes</span>
                {dueCount > 0 && <span className="fc-studio__due">{dueCount} à réviser</span>}
                <label className="fc-studio__due-toggle">
                  <input type="checkbox" checked={dueOnly} onChange={e => setDueOnly(e.target.checked)} />
                  Due uniquement
                </label>
              </div>
            )}
          </aside>

          {/* CENTER — card + controls */}
          <main className="fc-studio__main">
            {!cards.length && (
              <div className="fc-studio__empty">
                <BookOpen size={48} opacity={0.15} />
                <p>Sélectionne des documents et clique<br /><strong>Extraire Q/A</strong> ou <strong>Générer (IA)</strong></p>
              </div>
            )}

            {cards.length > 0 && !done && currentCard && (
              <>
                {/* Progress */}
                <div className="fc-studio__progress-bar">
                  <div className="fc-studio__progress-fill" style={{ width: `${progress}%` }} />
                </div>
                <div className="fc-studio__progress-label">
                  {queueIdx + 1} / {queue.length} · ✅ {score.ok} ❌ {score.ko}
                </div>

                {/* Card */}
                <div
                  className={`fc-studio__card${flipped ? ' fc-studio__card--flipped' : ''}`}
                  onClick={() => setFlipped(true)}
                >
                  <div className="fc-studio__card-inner">
                    <div className="fc-studio__card-front">
                      <span className="fc-studio__card-label">Q</span>
                      <p className="fc-studio__card-text">{currentCard.q}</p>
                      {!flipped && <span className="fc-studio__card-hint">Cliquer pour révéler</span>}
                    </div>
                    <div className="fc-studio__card-back">
                      <span className="fc-studio__card-label fc-studio__card-label--a">A</span>
                      <p className="fc-studio__card-text">{currentCard.a}</p>
                      {currentCard.padName && (
                        <button
                          className="fc-studio__card-src"
                          onClick={e => { e.stopPropagation(); if (currentCard.padId) { onSelectPad(currentCard.padId); onClose(); } }}
                        >
                          <ChevronRight size={10} /> {currentCard.padName}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Answer buttons */}
                {flipped && (
                  <div className="fc-studio__btns">
                    <button className="fc-studio__ans fc-studio__ans--ko" onClick={() => answer(1)}>
                      <AlertCircle size={14} /> Raté
                    </button>
                    <button className="fc-studio__ans fc-studio__ans--ok" onClick={() => answer(3)}>
                      <Check size={14} /> Bien
                    </button>
                    <button className="fc-studio__ans fc-studio__ans--ez" onClick={() => answer(5)}>
                      <Zap size={14} /> Facile
                    </button>
                  </div>
                )}
              </>
            )}

            {cards.length > 0 && done && (
              <div className="fc-studio__done">
                <span className="fc-studio__done-emoji">🎉</span>
                <h2>Session terminée !</h2>
                <p>✅ {score.ok} correct · ❌ {score.ko} à revoir</p>
                <button className="fc-studio__btn fc-studio__btn--extract" style={{ marginTop: 16 }} onClick={() => startSession(cards)}>
                  <RotateCcw size={13} /> Recommencer
                </button>
              </div>
            )}

            {cards.length > 0 && !done && queue.length === 0 && (
              <div className="fc-studio__done">
                <span className="fc-studio__done-emoji">✨</span>
                <h2>Aucune carte à réviser</h2>
                <p>Toutes les cartes sont à jour !</p>
                <button className="fc-studio__btn fc-studio__btn--extract" style={{ marginTop: 16 }} onClick={() => { setDueOnly(false); startSession(cards); }}>
                  <RotateCcw size={13} /> Revoir tout
                </button>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
