import React from 'react';
import {
  PenLine, FileText, Columns3, GanttChart, CalendarDays,
  Zap, Upload, Clock, X,
} from 'lucide-react';
import type { Tab } from '../hooks/usePadTabs';
import { cardTint } from '../lib/cardTint';
import './HomeHub.scss';

interface Props {
  tabs: Tab[];
  user?: { name?: string; email?: string };
  onSelectPad: (id: string) => void;
  onNewCanvas: () => void;
  onNewDocument: () => void;
  onNewKanban: () => void;
  onNewGantt: () => void;
  onDailyNote: () => void;
  onQuickCapture: () => void;
  onImportObsidian: () => void;
  onClose: () => void;
}

const PAD_ICONS: Record<string, React.ReactNode> = {
  canvas: <PenLine size={16} />,
  document: <FileText size={16} />,
  kanban: <Columns3 size={16} />,
  gantt: <GanttChart size={16} />,
};

const PAD_COLORS: Record<string, string> = {
  canvas: '#cba6f7',
  document: '#89b4fa',
  kanban: '#a6e3a1',
  gantt: '#fab387',
};

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Bonne nuit 🌙';
  if (h < 12) return 'Bonjour ☀️';
  if (h < 18) return 'Bon après-midi ⚡';
  return 'Bonne soirée 🌆';
}

function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'hier';
  if (days < 7) return `il y a ${days} j`;
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

export default function HomeHub({
  tabs, user, onSelectPad, onNewCanvas, onNewDocument, onNewKanban,
  onNewGantt, onDailyNote, onQuickCapture, onImportObsidian, onClose,
}: Props) {
  const recent = [...tabs]
    .filter(t => !t.isScratch)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 6);

  const scratch = tabs.find(t => t.isScratch);

  const typeCount = tabs.reduce((acc, t) => {
    acc[t.padType ?? 'canvas'] = (acc[t.padType ?? 'canvas'] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="home-hub" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="home-hub__inner">

        {/* Close */}
        <button className="home-hub__close" onClick={onClose}><X size={16} /></button>

        {/* Greeting */}
        <div className="home-hub__greeting">
          <h1 className="home-hub__title">{greeting()}</h1>
          {user?.name && <p className="home-hub__sub">{user.name}</p>}
        </div>

        {/* Quick actions */}
        <div className="home-hub__section">
          <h2 className="home-hub__section-label">Créer</h2>
          <div className="home-hub__actions">
            {[
              { icon: <PenLine size={18} />, label: 'Canvas', action: onNewCanvas, color: '#cba6f7' },
              { icon: <FileText size={18} />, label: 'Document', action: onNewDocument, color: '#89b4fa' },
              { icon: <Columns3 size={18} />, label: 'Kanban', action: onNewKanban, color: '#a6e3a1' },
              { icon: <GanttChart size={18} />, label: 'Gantt', action: onNewGantt, color: '#fab387' },
              { icon: <CalendarDays size={18} />, label: 'Daily Note', action: onDailyNote, color: '#f9e2af' },
              { icon: <Zap size={18} />, label: 'Capture rapide', action: onQuickCapture, color: '#f5c2e7' },
              { icon: <Upload size={18} />, label: 'Import Obsidian', action: onImportObsidian, color: '#94e2d5' },
            ].map(({ icon, label, action, color }) => (
              <button
                key={label}
                className="home-hub__action-card"
                onClick={() => { action(); onClose(); }}
                style={{ '--card-accent': color } as React.CSSProperties}
              >
                <span className="home-hub__action-icon">{icon}</span>
                <span className="home-hub__action-label">{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Stats row */}
        <div className="home-hub__stats">
          {Object.entries(typeCount).map(([type, count]) => (
            <div key={type} className="home-hub__stat" style={{ '--stat-color': PAD_COLORS[type] ?? '#cba6f7' } as React.CSSProperties}>
              <span className="home-hub__stat-icon">{PAD_ICONS[type] ?? <PenLine size={14} />}</span>
              <span className="home-hub__stat-num">{count}</span>
              <span className="home-hub__stat-label">{type}</span>
            </div>
          ))}
          {scratch && (
            <div
              className="home-hub__stat home-hub__stat--scratch"
              onClick={() => { onSelectPad(scratch.id); onClose(); }}
              role="button"
            >
              <span className="home-hub__stat-icon"><Clock size={14} /></span>
              <span className="home-hub__stat-label">Scratch</span>
            </div>
          )}
        </div>

        {/* Recent pads */}
        {recent.length > 0 && (
          <div className="home-hub__section">
            <h2 className="home-hub__section-label">Récents</h2>
            <div className="home-hub__recent-grid">
              {recent.map(tab => (
                <button
                  key={tab.id}
                  className="home-hub__recent-card"
                  onClick={() => { onSelectPad(tab.id); onClose(); }}
                  style={{ '--card-tint': cardTint(tab.id), '--card-accent': PAD_COLORS[tab.padType ?? 'canvas'] } as React.CSSProperties}
                >
                  <span className="home-hub__recent-icon">
                    {PAD_ICONS[tab.padType ?? 'canvas']}
                  </span>
                  <span className="home-hub__recent-title">{tab.title}</span>
                  <span className="home-hub__recent-date">{relativeDate(tab.updatedAt)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {recent.length === 0 && (
          <div className="home-hub__empty">
            <p>Aucun pad encore. Créé ton premier avec les boutons ci-dessus 👆</p>
          </div>
        )}
      </div>
    </div>
  );
}
