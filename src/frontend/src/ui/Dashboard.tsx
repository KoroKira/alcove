import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Plus, FileText, PenLine, Search, Grid2X2, Layers } from 'lucide-react';
import { Tab } from '../hooks/usePadTabs';
import { CANVAS_TEMPLATES, CanvasTemplate } from '../constants/templates';
import { cardTint } from '../lib/cardTint';
import './Dashboard.scss';

interface Props {
  tabs: Tab[];
  selectedTabId: string;
  onSelectPad: (padId: string) => void;
  onCreateCanvas: () => void;
  onCreateDocument: () => void;
  onCreateFromTemplate?: (template: CanvasTemplate) => void;
  onClose: () => void;
}

type SortKey = 'updated' | 'created' | 'name' | 'type';

const allTags = (tabs: Tab[]): string[] =>
  Array.from(new Set(tabs.flatMap(t => t.tags || []))).sort();

// TYPE_LABELS is now built dynamically using t() inside the component

/** GitHub-style activity heatmap: one cell per day, last 26 weeks. */
const ActivityHeatmap: React.FC = () => {
  const { t } = useTranslation();
  const [counts, setCounts] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    fetch('/api/pad/activity')
      .then(r => r.json())
      .then(d => setCounts(d.counts || {}))
      .catch(() => setCounts({}));
  }, []);

  if (!counts) return null;

  const WEEKS = 26;
  const today = new Date();
  // Start on the Monday WEEKS-1 weeks back
  const start = new Date(today);
  start.setDate(start.getDate() - start.getDay() + 1 - (WEEKS - 1) * 7);
  const level = (n: number) => (n === 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : n <= 10 ? 3 : 4);

  const weeks: { date: string; n: number; future: boolean }[][] = [];
  const cursor = new Date(start);
  for (let w = 0; w < WEEKS; w++) {
    const days: { date: string; n: number; future: boolean }[] = [];
    for (let d = 0; d < 7; d++) {
      const iso = cursor.toISOString().slice(0, 10);
      days.push({ date: iso, n: counts[iso] || 0, future: cursor > today });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(days);
  }

  return (
    <div className="dashboard__heatmap" title={t('dashboard.heatmapTitle')}>
      {weeks.map((week, wi) => (
        <div key={wi} className="dashboard__heatmap-col">
          {week.map(day => (
            <div
              key={day.date}
              className={`dashboard__heatmap-cell${day.future ? ' future' : ` l${level(day.n)}`}`}
              title={`${day.date} — ${day.n} ${t('dashboard.heatmapEdits')}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
};

const Dashboard: React.FC<Props> = ({
  tabs,
  selectedTabId,
  onSelectPad,
  onCreateCanvas,
  onCreateDocument,
  onCreateFromTemplate,
  onClose,
}) => {
  const { t } = useTranslation();
  const typeLabels: Record<string, string> = {
    canvas: t('dashboard.typeCanvas'),
    document: t('dashboard.typeDocument'),
  };
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('updated');
  const [activeView, setActiveView] = useState<'pads' | 'templates'>('pads');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Lazy-fetch doc previews
  useEffect(() => {
    const docTabs = tabs.filter(t => t.padType === 'document' && !previews[t.id]);
    docTabs.forEach(tab => {
      fetch(`/api/pad/${tab.id}`)
        .then(r => r.json())
        .then(data => {
          const text = (data?.content || '') as string;
          const snippet = text.replace(/#+\s/g, '').replace(/\*\*/g, '').replace(/`/g, '').trim().slice(0, 140);
          setPreviews(prev => ({ ...prev, [tab.id]: snippet }));
        })
        .catch(() => {});
    });
  }, [tabs]);

  const sorted = [...tabs].sort((a, b) => {
    if (sortKey === 'name') return a.title.localeCompare(b.title);
    if (sortKey === 'type') return (a.padType || 'canvas').localeCompare(b.padType || 'canvas');
    if (sortKey === 'created') return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  const filtered = sorted.filter(t => {
    const matchesQuery = !query.trim() || t.title.toLowerCase().includes(query.toLowerCase());
    const matchesTag = !activeTag || (t.tags || []).includes(activeTag);
    return matchesQuery && matchesTag;
  });

  const tagList = allTags(tabs);

  const handleSelect = (id: string) => {
    onSelectPad(id);
    onClose();
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  return (
    <div className="dashboard-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dashboard">
        {/* Header */}
        <div className="dashboard__header">
          <div className="dashboard__title">
            <Grid2X2 size={18} />
            {t('dashboard.title')}
          </div>
          <div className="dashboard__actions">
            <div className="dashboard__tabs">
              <button className={`dashboard__tab-btn ${activeView === 'pads' ? 'active' : ''}`} onClick={() => setActiveView('pads')}>
                <Grid2X2 size={13} /> Pads
              </button>
              <button className={`dashboard__tab-btn ${activeView === 'templates' ? 'active' : ''}`} onClick={() => setActiveView('templates')}>
                <Layers size={13} /> {t('dashboard.templates')}
              </button>
            </div>
            <button className="dashboard__create-btn dashboard__create-btn--canvas" onClick={onCreateCanvas}>
              <Plus size={14} /> {t('dashboard.newCanvas')}
            </button>
            <button className="dashboard__create-btn dashboard__create-btn--doc" onClick={onCreateDocument}>
              <Plus size={14} /> {t('dashboard.newDocument')}
            </button>
            <button className="dashboard__close" onClick={onClose}><X size={18} /></button>
          </div>
        </div>

        {/* Templates view */}
        {activeView === 'templates' && (
          <div className="dashboard__templates">
            <div className="dashboard__templates-label">{t('dashboard.newFromTemplate')}</div>
            <div className="dashboard__templates-grid">
              {CANVAS_TEMPLATES.map(tmpl => (
                <button
                  key={tmpl.id}
                  className="dashboard__template-card"
                  onClick={() => onCreateFromTemplate?.(tmpl)}
                >
                  <span className="dashboard__template-emoji">{tmpl.emoji}</span>
                  <span className="dashboard__template-name">{tmpl.name}</span>
                  <span className="dashboard__template-desc">{tmpl.description}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Search + Sort + Grid */}
        {activeView === 'pads' && (
          <>
            <ActivityHeatmap />
            <div className="dashboard__controls">
              <div className="dashboard__search-wrap">
                <Search size={14} className="dashboard__search-icon" />
                <input
                  ref={searchRef}
                  className="dashboard__search"
                  placeholder={t('search.placeholder')}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
              </div>
              <div className="dashboard__sort">
                {(['updated', 'created', 'name', 'type'] as SortKey[]).map(k => (
                  <button
                    key={k}
                    className={`dashboard__sort-btn ${sortKey === k ? 'active' : ''}`}
                    onClick={() => setSortKey(k)}
                  >
                    {k.charAt(0).toUpperCase() + k.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            {tagList.length > 0 && (
              <div className="dashboard__tag-filter">
                <button
                  className={`dashboard__tag-chip ${!activeTag ? 'active' : ''}`}
                  onClick={() => setActiveTag(null)}
                >{t('sidebar.files')}</button>
                {tagList.map(tag => (
                  <button
                    key={tag}
                    className={`dashboard__tag-chip ${activeTag === tag ? 'active' : ''}`}
                    onClick={() => setActiveTag(t => t === tag ? null : tag)}
                  >#{tag}</button>
                ))}
              </div>
            )}
            <div className="dashboard__grid">
              {filtered.length === 0 && (
                <div className="dashboard__empty">{t('search.noResults')}</div>
              )}
              {filtered.map(tab => (
                <button
                  key={tab.id}
                  className={`dashboard__card ${selectedTabId === tab.id ? 'active' : ''} ${tab.isScratch ? 'scratch' : ''}`}
                  style={{ '--card-tint': cardTint(tab.id) } as React.CSSProperties}
                  onClick={() => handleSelect(tab.id)}
                >
                  <div className="dashboard__card-header">
                    <span className="dashboard__card-icon">
                      {tab.padType === 'document' ? <FileText size={16} /> : <PenLine size={16} />}
                    </span>
                    <span className={`dashboard__card-badge dashboard__card-badge--${tab.padType || 'canvas'}`}>
                      {typeLabels[tab.padType || 'canvas']}
                    </span>
                    {tab.isScratch && <span className="dashboard__card-scratch">Scratch</span>}
                  </div>
                  <div className="dashboard__card-title">{tab.title}</div>
                  {tab.padType === 'document' && previews[tab.id] && (
                    <div className="dashboard__card-preview">{previews[tab.id]}</div>
                  )}
                  {(tab.tags || []).length > 0 && (
                    <div className="dashboard__card-tags">
                      {(tab.tags || []).map(tag => (
                        <span
                          key={tag}
                          className="dashboard__card-tag"
                          onClick={e => { e.stopPropagation(); setActiveTag(t => t === tag ? null : tag); }}
                        >#{tag}</span>
                      ))}
                    </div>
                  )}
                  <div className="dashboard__card-meta">
                    Updated {formatDate(tab.updatedAt)}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
