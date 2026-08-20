/**
 * Single message bubble for agentic RAG chat — sub-queries strip, [[N]]
 * citations, numbered Sources drawer, follow-up pills, and the bottom action
 * row (Add to notebook / Insert into pad). Shared between AIPanel's RAG tab
 * and the full-page ChatView so both surfaces render identically.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Play, BookmarkPlus, ArrowDownToLine, Sigma, Check, Loader } from 'lucide-react';
import { Message, renderWithCitations } from '../lib/chatTypes';

interface Props {
  msg: Message;
  index: number;
  isLast: boolean;
  streaming: boolean;
  onFollowup: (q: string) => void;
  onAddToNotebook: (msg: Message) => void;
  onInsertContent?: (content: string) => void;
}

export default function ChatMessage({
  msg, index, isLast, streaming, onFollowup, onAddToNotebook, onInsertContent,
}: Props) {
  const { t } = useTranslation();

  const scrollToSource = (n: number) => {
    const el = document.getElementById(`rag-src-${index}-${n}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    el.classList.add('ai-msg__source--flash');
    setTimeout(() => el.classList.remove('ai-msg__source--flash'), 1400);
  };

  return (
    <div className={`ai-msg ai-msg--${msg.role}`}>
      <div className="ai-msg__role">
        {msg.role === 'user' ? t('ai.you') : t('ai.assistant')}
      </div>
      {msg.role === 'assistant' && msg.steps && msg.steps.length > 0 ? (
        <details className="ai-msg__subqueries">
          <summary>
            <Sigma size={11} />
            {' '}{msg.steps.every(s => s.status === 'done')
              ? t('ai.thoughtDone', { defaultValue: 'Réflexion' })
              : t('ai.thoughtRunning', { defaultValue: 'Réflexion en cours…' })}
          </summary>
          <ul className="ai-msg__steps">
            {msg.steps.map(s => (
              <li key={s.id} className={`ai-msg__step ai-msg__step--${s.status}`}>
                {s.status === 'done' ? <Check size={11} /> : <Loader size={11} className="ai-spin" />}
                <span className="ai-msg__step-label">{s.label}</span>
                {s.detail && <span className="ai-msg__step-detail">{s.detail}</span>}
              </li>
            ))}
            {msg.subqueries && msg.subqueries.length > 0 && (
              <li className="ai-msg__step-subqueries">
                {msg.subqueries.map((s, j) => <div key={j}>{s}</div>)}
              </li>
            )}
          </ul>
        </details>
      ) : msg.role === 'assistant' && msg.subqueries && msg.subqueries.length > 0 && (
        <details className="ai-msg__subqueries">
          <summary>
            <Sigma size={11} />
            {' '}{msg.subqueries.length} {t('ai.ragSubqueriesLabel', { defaultValue: 'sous-requêtes' })}
          </summary>
          <ul>
            {msg.subqueries.map((s, j) => <li key={j}>{s}</li>)}
          </ul>
        </details>
      )}
      {msg.content === '' && streaming && isLast ? (
        <div className="ai-msg__thinking"><span /><span /><span /></div>
      ) : (
        <>
          <div className="ai-msg__content">
            {msg.role === 'assistant'
              ? renderWithCitations(msg.content, scrollToSource)
              : msg.content}
          </div>
          {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
            <div className="ai-msg__sources ai-msg__sources--numbered">
              <div className="ai-msg__sources-label">
                {t('ai.sources')} · {msg.sources.length}
              </div>
              {msg.sources.map((s, j) => {
                const excerptShort = s.chunk_text
                  ? (s.chunk_text.length > 500
                    ? s.chunk_text.slice(0, 500).trimEnd() + '…'
                    : s.chunk_text)
                  : '';
                return (
                  <div
                    key={`${s.pad_id}-${s.n ?? j}`}
                    id={`rag-src-${index}-${s.n ?? j + 1}`}
                    className="ai-msg__source"
                  >
                    <div className="ai-msg__source-head">
                      {s.n !== undefined && (
                        <span className="ai-msg__source-n">{s.n}</span>
                      )}
                      <a
                        className="ai-msg__source-title"
                        href={
                          s.timestamp_seconds != null
                            ? `/pad/${s.pad_id}?t=${s.timestamp_seconds}`
                            : `/pad/${s.pad_id}`
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        {s.pad_name}
                      </a>
                      {s.timestamp_label && (
                        <a
                          className="ai-msg__source-ts"
                          href={`/pad/${s.pad_id}?t=${s.timestamp_seconds ?? 0}`}
                          target="_blank"
                          rel="noreferrer"
                          title={t('ai.ragOpenAtTime', { defaultValue: 'Ouvrir à ce moment' })}
                        >
                          <Play size={9} /> {s.timestamp_label}
                        </a>
                      )}
                      <span className="ai-msg__source-score">
                        {Math.round(s.score * 100)}%
                      </span>
                    </div>
                    {excerptShort && (
                      <div className="ai-msg__source-excerpt">{excerptShort}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {msg.role === 'assistant' && msg.followups && msg.followups.length > 0 && (
            <div className="ai-msg__followups">
              <div className="ai-msg__followups-label">
                {t('ai.ragFollowups', { defaultValue: 'À creuser ensuite' })}
              </div>
              <div className="ai-msg__followups-list">
                {msg.followups.map((f, j) => (
                  <button
                    key={j}
                    className="ai-msg__followup"
                    onClick={() => onFollowup(f)}
                    disabled={streaming}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
          )}
          {msg.role === 'assistant' && msg.content && (
            <div className="ai-msg__actions">
              <button
                className="ai-msg__action-btn"
                onClick={() => onAddToNotebook(msg)}
                title={t('ai.ragAddToNotebook', { defaultValue: 'Ajouter au notebook' })}
              >
                <BookmarkPlus size={11} />
                {' '}{t('ai.ragAddToNotebook', { defaultValue: 'Ajouter au notebook' })}
              </button>
              {onInsertContent && (
                <button
                  className="ai-msg__action-btn"
                  onClick={() => onInsertContent(msg.content)}
                  title={t('ai.insertIntoPad')}
                >
                  <ArrowDownToLine size={11} /> {t('ai.insertIntoPad')}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
