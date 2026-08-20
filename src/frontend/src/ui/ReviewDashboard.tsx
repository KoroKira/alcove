/**
 * Review dashboard (chantier #20, Recall's `/spaced-repetition` UI). The
 * FSRS-5 engine + review session already exist in FlashcardStudio.tsx — this
 * is purely the "here's how you're doing" surface Recall wraps around the
 * same idea: due counts, a streak grid, accuracy stats, a 7-day activity
 * chart. Reads lib/reviewActivity.ts (localStorage, same tier as FSRS state).
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, GraduationCap, Flame } from 'lucide-react';
import { getDueCounts, getRecentActivity, getTotals, getStreak } from '../lib/reviewActivity';
import './ReviewDashboard.scss';

interface Props {
  onClose: () => void;
  onStartReview: () => void;
}

const WEEKDAY_LABELS_FR = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

export default function ReviewDashboard({ onClose, onStartReview }: Props) {
  const { t } = useTranslation();

  const due = useMemo(() => getDueCounts(), []);
  const activity = useMemo(() => getRecentActivity(7), []);
  const totals = useMemo(() => getTotals(), []);
  const streak = useMemo(() => getStreak(), []);
  const accuracy = totals.answered > 0 ? Math.round((totals.correct / totals.answered) * 100) : 0;
  const maxAnswered = Math.max(1, ...activity.map(a => a.answered));

  // Weekday labels for the streak grid, oldest→newest, matching JS's
  // getDay() (0=Sunday) remapped to a Monday-first week like Recall's own.
  const streakDays = activity.map(a => {
    const jsDay = new Date(a.day * 86_400_000).getDay();
    const mondayFirst = (jsDay + 6) % 7;
    return { ...a, label: WEEKDAY_LABELS_FR[mondayFirst] };
  });

  return (
    <div className="review-dashboard-overlay">
      <div className="review-dashboard">
        <div className="review-dashboard__header">
          <div className="review-dashboard__title">
            <GraduationCap size={16} /> {t('review.title', { defaultValue: 'Révision' })}
          </div>
          <button className="review-dashboard__close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="review-dashboard__hero">
          <div className="review-dashboard__hero-text">
            <div className="review-dashboard__hero-title">
              {t('review.heroTitle', { defaultValue: 'Répétition espacée' })}
            </div>
            <div className="review-dashboard__hero-sub">
              {t('review.heroSub', { defaultValue: 'Retiens plus longtemps grâce à des révisions programmées de façon optimale.' })}
            </div>
          </div>
          <button className="review-dashboard__start" onClick={onStartReview}>
            {t('review.start', { defaultValue: 'Démarrer une révision' })}
          </button>
        </div>

        <div className="review-dashboard__stats">
          <div className="review-dashboard__stat">
            <div className="review-dashboard__stat-icon"><GraduationCap size={14} /></div>
            <div className="review-dashboard__stat-label">{t('review.readyToday', { defaultValue: 'Prêtes aujourd\'hui' })}</div>
            <div className="review-dashboard__stat-value">{due.today}</div>
          </div>
          <div className="review-dashboard__stat">
            <div className="review-dashboard__stat-label">{t('review.dueThisWeek', { defaultValue: 'Cette semaine' })}</div>
            <div className="review-dashboard__stat-value">{due.thisWeek}</div>
          </div>
          <div className="review-dashboard__stat">
            <div className="review-dashboard__stat-label">{t('review.dueNextWeek', { defaultValue: 'Semaine prochaine' })}</div>
            <div className="review-dashboard__stat-value">{due.nextWeek}</div>
          </div>
        </div>

        <div className="review-dashboard__section">
          <div className="review-dashboard__section-title">
            {t('review.streakTitle', { defaultValue: 'Série & activité' })}
          </div>
          <div className="review-dashboard__streak">
            <div className="review-dashboard__streak-grid">
              {streakDays.map(d => (
                <div key={d.day} className="review-dashboard__streak-day">
                  <div className="review-dashboard__streak-label">{d.label}</div>
                  <div className={`review-dashboard__streak-dot${d.answered > 0 ? ' review-dashboard__streak-dot--active' : ''}`} />
                </div>
              ))}
            </div>
            <div className="review-dashboard__streak-count">
              <Flame size={14} className={streak > 0 ? 'review-dashboard__streak-flame--on' : ''} />
              {streak} {t('review.streakDays', { defaultValue: streak === 1 ? 'jour' : 'jours' })}
            </div>
          </div>
        </div>

        <div className="review-dashboard__stats">
          <div className="review-dashboard__stat">
            <div className="review-dashboard__stat-label">{t('review.answered', { defaultValue: 'Répondu' })}</div>
            <div className="review-dashboard__stat-value">{totals.answered}</div>
          </div>
          <div className="review-dashboard__stat">
            <div className="review-dashboard__stat-label">{t('review.correct', { defaultValue: 'Correct' })}</div>
            <div className="review-dashboard__stat-value">{totals.correct}</div>
          </div>
          <div className="review-dashboard__stat">
            <div className="review-dashboard__stat-label">{t('review.accuracy', { defaultValue: 'Précision' })}</div>
            <div className="review-dashboard__stat-value">{accuracy}%</div>
          </div>
        </div>

        <div className="review-dashboard__section">
          <div className="review-dashboard__section-title">
            {t('review.activityTitle', { defaultValue: 'Activité — 7 derniers jours' })}
          </div>
          {totals.answered === 0 ? (
            <div className="review-dashboard__no-activity">
              {t('review.noActivity', { defaultValue: 'Aucune activité pour l\'instant.' })}
            </div>
          ) : (
            <div className="review-dashboard__chart">
              {activity.map(a => (
                <div key={a.day} className="review-dashboard__chart-col" title={`${a.answered} · ${a.correct} ✓`}>
                  <div
                    className="review-dashboard__chart-bar"
                    style={{ height: `${Math.max(4, (a.answered / maxAnswered) * 100)}%` }}
                  />
                  <div className="review-dashboard__chart-val">{a.answered || ''}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
