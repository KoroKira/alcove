import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Plus, FileText, PenLine, Search, Grid2X2, Layers, Link as LinkIcon, PenTool } from 'lucide-react';
import { Tab } from '../hooks/usePadTabs';
import { CANVAS_TEMPLATES, CanvasTemplate } from '../constants/templates';
import { cardTint } from '../lib/cardTint';
import './Dashboard.scss';

interface Props {
  tabs: Tab[];
  selectedTabId: string;
  onSelectPad: (padId: string) => void;
  /** Ouvre la modale unifiée d'ajout (Ingérer / Créer). Remplace les
   *  anciens boutons Nouveau canvas / Nouveau document. */
  onUnifiedAdd: () => void;
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
  onUnifiedAdd,
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

  /** Label de section pour une date : "Aujourd'hui" / "Hier" / date longue.
   *  L'année n'apparaît que si elle diffère de l'année courante — on garde
   *  les titres courts pour l'année en cours (le cas majoritaire). */
  const sectionLabel = (iso: string): string => {
    const d = new Date(iso + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const y = new Date(today); y.setDate(y.getDate() - 1);
    if (d.getTime() === today.getTime()) return t('dashboard.today');
    if (d.getTime() === y.getTime()) return t('dashboard.yesterday');
    const sameYear = d.getFullYear() === today.getFullYear();
    return d.toLocaleDateString('fr-FR', sameYear
      ? { weekday: 'long', day: 'numeric', month: 'long' }
      : { day: 'numeric', month: 'long', year: 'numeric' });
  };

  /** Regroupe la liste filtrée par jour (YYYY-MM-DD extrait du champ de tri
   *  actif). Retourne un tableau d'entrées [dateISO, tabs[]] ordonnées par
   *  date décroissante — la même que la sort actuelle. Skipé pour les tris
   *  name/type (le grouping par date n'a alors aucun sens). */
  const groupedByDate = (): [string, Tab[]][] => {
    const dateField = (t: Tab) => (sortKey === 'created' ? t.createdAt : t.updatedAt);
    const map = new Map<string, Tab[]>();
    for (const tab of filtered) {
      const iso = dateField(tab).slice(0, 10);
      if (!map.has(iso)) map.set(iso, []);
      map.get(iso)!.push(tab);
    }
    return Array.from(map.entries());
  };
  const useDateGrouping = sortKey === 'updated' || sortKey === 'created';

  /** Rendu d'une carte de pad. Extrait de la boucle map pour rester
   *  lisible pendant que le rendu s'enrichit (thumbnail, source line,
   *  badges d'engagement, …). Une seule source de vérité pour le look
   *  d'une carte, réutilisable dans les sections datées et le fallback
   *  non-grouped. */
  const renderCard = (tab: Tab) => (
    <button
      key={tab.id}
      className={`dashboard__card ${selectedTabId === tab.id ? 'active' : ''} ${tab.isScratch ? 'scratch' : ''} ${tab.thumbnailUrl ? 'has-thumb' : ''}`}
      style={{ '--card-tint': cardTint(tab.id) } as React.CSSProperties}
      onClick={() => handleSelect(tab.id)}
    >
      {tab.thumbnailUrl && (
        <div className="dashboard__card-thumb">
          <img
            src={tab.thumbnailUrl}
            alt=""
            loading="lazy"
            // referrerPolicy tightens tracking cross-origin (YouTube i.ytimg.com,
            // article OG-images, etc.). onError hides the img so the fallback
            // tint + type badge take over cleanly instead of showing a broken icon.
            referrerPolicy="no-referrer"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        </div>
      )}
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
      {tab.sourceUrl && (() => {
        // Domaine extrait de l'URL canonique. Sert de fil rouge visuel :
        // au dashboard, une carte YouTube ne se confond plus avec un
        // article Substack ou un PDF arxiv, même sans lire le titre.
        let host = '';
        try { host = new URL(tab.sourceUrl).hostname.replace(/^www\./, ''); }
        catch { host = ''; }
        if (!host) return null;
        // Service favicon gratuit Google — pratique, pas de key, sert
        // n'importe quel domaine. Fallback silencieux via onError si
        // le service est bloqué (ad-block, offline).
        const fav = `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
        return (
          <div className="dashboard__card-source">
            <img
              className="dashboard__card-source-fav"
              src={fav}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
            />
            <span className="dashboard__card-source-host">{host}</span>
          </div>
        );
      })()}
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
  );

  /** Tuile "Quick actions" épinglée en tête de la première section — le
   *  geste Recall qui remplace le "New pad" du terminal-look ancien par une
   *  colonne d'entrées visuelles au format carte. Un clic sur n'importe
   *  quelle action route vers la modale unifiée (qui garde la source de
   *  vérité de tout le flow de création). */
  const QuickActionsTile: React.FC = () => (
    <div className="dashboard__card dashboard__card--quick" onClick={onUnifiedAdd} role="button" tabIndex={0}>
      <div className="dashboard__quick-grid">
        <div className="dashboard__quick-item"><LinkIcon size={18} /><span>{t('dashboard.addLink')}</span></div>
        <div className="dashboard__quick-item"><FileText size={18} /><span>{t('dashboard.newDocument')}</span></div>
        <div className="dashboard__quick-item"><PenTool size={18} /><span>{t('dashboard.newCanvas')}</span></div>
        <div className="dashboard__quick-item"><Plus size={18} /><span>{t('dashboard.moreTypes')}</span></div>
      </div>
    </div>
  );

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
            <button
              className="dashboard__create-btn dashboard__create-btn--primary"
              onClick={onUnifiedAdd}
              title="Ajouter un contenu ou créer un pad (⌘⇧A)"
            >
              <Plus size={14} /> Ajouter
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
            {filtered.length === 0 && (
              <div className="dashboard__empty">{t('search.noResults')}</div>
            )}
            {filtered.length > 0 && useDateGrouping && groupedByDate().map(([iso, group], sectionIdx) => (
              <section key={iso} className="dashboard__section">
                <h3 className="dashboard__section-head">
                  <span className="dashboard__section-label">{sectionLabel(iso)}</span>
                  <span className="dashboard__section-count">{group.length}</span>
                </h3>
                <div className="dashboard__grid">
                  {sectionIdx === 0 && <QuickActionsTile />}
                  {group.map(tab => renderCard(tab))}
                </div>
              </section>
            ))}
            {filtered.length > 0 && !useDateGrouping && (
              <div className="dashboard__grid">
                <QuickActionsTile />
                {filtered.map(tab => renderCard(tab))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
