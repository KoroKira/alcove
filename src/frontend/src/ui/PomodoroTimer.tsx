import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Timer, Play, Pause, RotateCcw, X, ChevronDown, ChevronUp } from 'lucide-react';
import './PomodoroTimer.scss';

type Phase = 'work' | 'break';

const WORK_SECONDS = 25 * 60;
const BREAK_SECONDS = 5 * 60;

interface Props {
  onClose: () => void;
}

const PomodoroTimer: React.FC<Props> = ({ onClose }) => {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('work');
  const [timeLeft, setTimeLeft] = useState(WORK_SECONDS);
  const [running, setRunning] = useState(false);
  const [cycles, setCycles] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const total = phase === 'work' ? WORK_SECONDS : BREAK_SECONDS;
  const progress = ((total - timeLeft) / total) * 100;

  const reset = useCallback(() => {
    setRunning(false);
    setTimeLeft(phase === 'work' ? WORK_SECONDS : BREAK_SECONDS);
  }, [phase]);

  const skipPhase = useCallback(() => {
    setRunning(false);
    if (phase === 'work') {
      setPhase('break');
      setTimeLeft(BREAK_SECONDS);
      setCycles(c => c + 1);
    } else {
      setPhase('work');
      setTimeLeft(WORK_SECONDS);
    }
  }, [phase]);

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(() => {
        setTimeLeft(t => {
          if (t <= 1) {
            clearInterval(intervalRef.current!);
            setRunning(false);
            // Notification
            if (Notification.permission === 'granted') {
              new Notification(phase === 'work' ? '🍅 Pause !' : '💪 Au travail !', {
                body: phase === 'work' ? 'Temps de faire une pause.' : 'C\'est reparti !',
              });
            }
            skipPhase();
            return 0;
          }
          return t - 1;
        });
      }, 1000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [running, phase, skipPhase]);

  const mins = String(Math.floor(timeLeft / 60)).padStart(2, '0');
  const secs = String(timeLeft % 60).padStart(2, '0');

  const requestNotifPerm = () => {
    if (Notification.permission === 'default') Notification.requestPermission();
  };

  return (
    <div className={`pomodoro${collapsed ? ' pomodoro--collapsed' : ''}${phase === 'break' ? ' pomodoro--break' : ''}`}>
      <div className="pomodoro__header">
        <div className="pomodoro__title-row">
          <Timer size={13} />
          <span className="pomodoro__label">{phase === 'work' ? t('pomodoro.work') : t('pomodoro.break')}</span>
          {cycles > 0 && <span className="pomodoro__cycles">{cycles}×</span>}
        </div>
        <div className="pomodoro__header-btns">
          <button onClick={() => setCollapsed(v => !v)} className="pomodoro__icon-btn" title={t('pomodoro.minimize')}>
            {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          <button onClick={onClose} className="pomodoro__icon-btn" title={t('pomodoro.close')}>
            <X size={12} />
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          <div className="pomodoro__ring-wrap">
            <svg className="pomodoro__ring" viewBox="0 0 80 80">
              <circle cx="40" cy="40" r="34" className="pomodoro__ring-bg" />
              <circle
                cx="40" cy="40" r="34"
                className="pomodoro__ring-fill"
                strokeDasharray={`${2 * Math.PI * 34}`}
                strokeDashoffset={`${2 * Math.PI * 34 * (1 - progress / 100)}`}
              />
            </svg>
            <div className="pomodoro__time">{mins}:{secs}</div>
          </div>

          <div className="pomodoro__controls">
            <button className="pomodoro__icon-btn" onClick={reset} title={t('pomodoro.reset')}>
              <RotateCcw size={14} />
            </button>
            <button
              className="pomodoro__play-btn"
              onClick={() => { setRunning(v => !v); requestNotifPerm(); }}
              title={running ? t('pomodoro.pause') : t('pomodoro.start')}
            >
              {running ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button className="pomodoro__icon-btn" onClick={skipPhase} title={t('pomodoro.skip')}>
              <ChevronDown size={14} style={{ transform: 'rotate(-90deg)' }} />
            </button>
          </div>
        </>
      )}

      {collapsed && (
        <div className="pomodoro__compact-time">{mins}:{secs}</div>
      )}
    </div>
  );
};

export default PomodoroTimer;
