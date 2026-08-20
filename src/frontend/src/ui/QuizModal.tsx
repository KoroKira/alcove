/**
 * Ungraded per-note quiz session (chantier #19, Recall's "Test Your
 * Knowledge" per-card tab). Linear flow: show question → reveal answer →
 * self-mark correct/incorrect → next. Score shown at the end. Nothing here
 * persists — this is a quick comprehension check, not the FSRS-5 deck.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Eye, Check, RotateCcw } from 'lucide-react';
import type { QuizQuestion } from '../lib/aiPrompts';
import './QuizModal.scss';

interface Props {
  questions: QuizQuestion[];
  onClose: () => void;
}

export default function QuizModal({ questions, onClose }: Props) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [results, setResults] = useState<boolean[]>([]);

  const total = questions.length;
  const done = index >= total;
  const current = !done ? questions[index] : null;
  const correctCount = results.filter(Boolean).length;

  const mark = (correct: boolean) => {
    setResults(prev => [...prev, correct]);
    setRevealed(false);
    setIndex(i => i + 1);
  };

  const restart = () => { setIndex(0); setRevealed(false); setResults([]); };

  return (
    <div className="quiz-modal-overlay" onClick={onClose}>
      <div className="quiz-modal" onClick={e => e.stopPropagation()}>
        <div className="quiz-modal__header">
          <div className="quiz-modal__title">
            {t('ai.quizTitle', { defaultValue: 'Test de compréhension' })}
          </div>
          <button className="quiz-modal__close" onClick={onClose}><X size={16} /></button>
        </div>

        {total === 0 ? (
          <div className="quiz-modal__empty">
            {t('ai.quizEmpty', { defaultValue: 'Impossible de générer un quiz pour cette note.' })}
          </div>
        ) : done ? (
          <div className="quiz-modal__result">
            <div className="quiz-modal__score">{correctCount} / {total}</div>
            <div className="quiz-modal__score-label">
              {t('ai.quizScoreLabel', { defaultValue: 'bonnes réponses' })}
            </div>
            <button className="quiz-modal__restart" onClick={restart}>
              <RotateCcw size={13} /> {t('ai.quizRestart', { defaultValue: 'Recommencer' })}
            </button>
          </div>
        ) : (
          <>
            <div className="quiz-modal__progress">{index + 1} / {total}</div>
            <div className="quiz-modal__question">{current!.q}</div>
            {revealed ? (
              <>
                <div className="quiz-modal__answer">{current!.a}</div>
                <div className="quiz-modal__mark-actions">
                  <button className="quiz-modal__mark quiz-modal__mark--wrong" onClick={() => mark(false)}>
                    {t('ai.quizReview', { defaultValue: 'À revoir' })}
                  </button>
                  <button className="quiz-modal__mark quiz-modal__mark--right" onClick={() => mark(true)}>
                    <Check size={13} /> {t('ai.quizCorrect', { defaultValue: 'Bonne réponse' })}
                  </button>
                </div>
              </>
            ) : (
              <button className="quiz-modal__reveal" onClick={() => setRevealed(true)}>
                <Eye size={13} /> {t('ai.quizReveal', { defaultValue: 'Voir la réponse' })}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
