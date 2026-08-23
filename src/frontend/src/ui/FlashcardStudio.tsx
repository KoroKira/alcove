import React, { useState, useEffect, useCallback } from 'react';
import { X, BookOpen, Sparkles, RotateCcw, ChevronRight, Check, Zap, AlertCircle, Meh } from 'lucide-react';
import type { Tab } from '../hooks/usePadTabs';
import { FSRSCard, Rating, review, today, newCard, migrateFromSM2 } from '../lib/fsrs';
import { logReview } from '../lib/reviewActivity';
import './FlashcardStudio.scss';

interface Card { q: string; a: string; padId?: string; padName?: string; }
interface Deck { padId: string; padName: string; cards: Card[]; }

// New key — the payload shape changed from SM-2 to FSRS. The old key
// `alcove-quiz-sm2` is read once during migration below then left alone (users
// can always clear it manually; keeping it makes rollback trivial).
const FSRS_KEY = 'alcove-quiz-fsrs';
const LEGACY_SM2_KEY = 'alcove-quiz-sm2';

function cardKey(c: Card, idx: number): string {
  return `${c.padId}-${idx}-${c.q.slice(0, 16)}`;
}

function loadFSRS(cards: Card[]): FSRSCard[] {
  let saved: Record<string, FSRSCard> = {};
  try {
    const raw = localStorage.getItem(FSRS_KEY);
    saved = raw ? JSON.parse(raw) : {};
  } catch { /* empty */ }

  // One-time migration from the old SM-2 payload — read the legacy key on the
  // first FSRS load and fill in any missing keys. We don't delete the old
  // record so rolling back stays possible.
  let legacy: Record<string, { n: number; ef: number; interval: number; due: number }> = {};
  try {
    const raw = localStorage.getItem(LEGACY_SM2_KEY);
    legacy = raw ? JSON.parse(raw) : {};
  } catch { /* empty */ }

  return cards.map((c, i) => {
    const k = cardKey(c, i);
    if (saved[k]) return saved[k];
    if (legacy[k]) return migrateFromSM2(legacy[k]);
    return newCard();
  });
}

function saveFSRS(cards: Card[], state: FSRSCard[]) {
  let saved: Record<string, FSRSCard> = {};
  try {
    const raw = localStorage.getItem(FSRS_KEY);
    saved = raw ? JSON.parse(raw) : {};
  } catch { /* empty */ }
  cards.forEach((c, i) => { saved[cardKey(c, i)] = state[i]; });
  localStorage.setItem(FSRS_KEY, JSON.stringify(saved));
}

function parseFlashcards(raw: string, padId = 'generated', padName = 'IA'): Card[] {
  const cleaned = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  // Accept JSON too: smaller local models often obey the content but choose a
  // safer structured representation despite the requested Q:/A: format.
  try {
    const start = cleaned.indexOf('['), end = cleaned.lastIndexOf(']');
    if (start >= 0 && end > start) {
      const items = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(items)) {
        const cards = items.map(x => ({ q: String(x.q || x.question || '').trim(), a: String(x.a || x.answer || '').trim(), padId, padName }))
          .filter(x => x.q && x.a);
        if (cards.length) return cards;
      }
    }
  } catch { /* fall through to tolerant Q/A parser */ }

  const pairs: Card[] = [];
  const block = /^\s*(?:[-*]\s*)?Q\s*:\s*(.+?)\r?\n\s*(?:[-*]\s*)?A\s*:\s*([\s\S]*?)(?=\r?\n\s*(?:[-*]\s*)?Q\s*:|$)/gim;
  for (const match of cleaned.matchAll(block)) {
    const q = match[1].trim();
    const a = match[2].trim().replace(/\n{3,}/g, '\n\n');
    if (q && a) pairs.push({ q, a, padId, padName });
  }
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
  const [srsState, setSrsState] = useState<FSRSCard[]>([]);
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
    const loaded = loadFSRS(allCards);
    setSrsState(loaded);
    const now = today();
    const q = allCards
      .map((_, i) => i)
      .filter(i => !dueOnly || loaded[i].due <= now)
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
      const { quizGenerate } = await import('../lib/aiPrompts');
      const model = localStorage.getItem('pad-ws-ai-model') || 'llama3.2';
      const raw = await quizGenerate(model, [...selectedIds], topic || undefined, 8, 'fr');
      const all = parseFlashcards(raw);
      if (!all.length) { setError("L'IA n'a pas produit de flashcards. Réessaie."); setStatus('idle'); return; }
      startSession(all);
    } catch (e) {
      setError(`Génération impossible : ${e instanceof Error ? e.message : 'Ollama indisponible'}`);
    }
    setStatus('idle');
  };

  const currentCardIdx = queue[queueIdx] ?? -1;
  const currentCard = currentCardIdx >= 0 ? cards[currentCardIdx] : null;

  const answer = (rating: Rating) => {
    if (currentCardIdx < 0 || !flipped) return;
    const updatedCard = review(srsState[currentCardIdx], rating);
    const nextState = [...srsState];
    nextState[currentCardIdx] = updatedCard;
    setSrsState(nextState);
    saveFSRS(cards, nextState);
    // "Again" counts as ko, everything else as ok (Hard still means recalled).
    logReview(rating >= 2);
    setScore(s => ({
      ...s,
      ok: rating >= 2 ? s.ok + 1 : s.ok,
      ko: rating === 1 ? s.ko + 1 : s.ko,
    }));
    const nextIdx = queueIdx + 1;
    if (nextIdx >= queue.length) { setDone(true); return; }
    setQueueIdx(nextIdx);
    setFlipped(false);
  };

  const nowDay = today();
  const dueCount = srsState.filter(c => c.due <= nowDay).length;
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

                {/* Answer buttons — FSRS 4-rating scale */}
                {flipped && (
                  <div className="fc-studio__btns">
                    <button className="fc-studio__ans fc-studio__ans--ko" onClick={() => answer(1)}>
                      <AlertCircle size={14} /> Raté
                    </button>
                    <button className="fc-studio__ans fc-studio__ans--hard" onClick={() => answer(2)}>
                      <Meh size={14} /> Dur
                    </button>
                    <button className="fc-studio__ans fc-studio__ans--ok" onClick={() => answer(3)}>
                      <Check size={14} /> Bien
                    </button>
                    <button className="fc-studio__ans fc-studio__ans--ez" onClick={() => answer(4)}>
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
