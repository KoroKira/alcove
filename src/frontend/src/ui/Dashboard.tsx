import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X, Plus, FileText, PenLine, Search, Grid2X2, Layers, Link as LinkIcon, PenTool,
  Kanban, GanttChart, Sigma, Database, StickyNote,
} from 'lucide-react';
import { Tab } from '../hooks/usePadTabs';
import { CANVAS_TEMPLATES, CanvasTemplate } from '../constants/templates';
import { cardTint } from '../lib/cardTint';
import './Dashboard.scss';

interface Props {
  initialView?: 'pads' | 'templates';
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
  initialView = 'pads',
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
    kanban: 'Kanban',
    gantt: 'Gantt',
    latex: 'LaTeX',
    database: 'Database',
  };
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('updated');
  const [activeView, setActiveView] = useState<'pads' | 'templates'>(initialView);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  // Toggle Text ⇄ AI dans la barre de recherche — le geste Recall qui
  // bascule la même input entre plein-texte (matching titre) et sémantique
  // (embedding + KNN sur le RAG). Persisté en localStorage pour rester
  // sur le mode que l'utilisateur préfère d'une session à l'autre.
  const [searchMode, setSearchMode] = useState<'text' | 'ai'>(
    () => (localStorage.getItem('alcove-search-mode') as 'text' | 'ai') || 'text',
  );
  const [aiHits, setAiHits] = useState<Set<string> | null>(null);
  const [aiSearching, setAiSearching] = useState(false);
  useEffect(() => {
    localStorage.setItem('alcove-search-mode', searchMode);
  }, [searchMode]);
  // Debounced semantic search — l'embed + KNN prend ~200-500 ms, on ne
  // veut pas déclencher à chaque keystroke ; 350 ms est le sweet spot
  // où le résultat arrive juste après la pause de frappe.
  useEffect(() => {
    if (searchMode !== 'ai' || query.trim().length < 3) {
      setAiHits(null);
      setAiSearching(false);
      return;
    }
    const q = query.trim();
    setAiSearching(true);
    const handle = setTimeout(async () => {
      try {
        const { searchRag } = await import('../lib/rag');
        const results = await searchRag(q, 30);
        setAiHits(new Set(results.map(r => r.pad_id)));
      } catch {
        setAiHits(new Set());
      } finally {
        setAiSearching(false);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [query, searchMode]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => setActiveView(initialView), [initialView]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Lazy-fetch doc previews. On nettoie AGRESSIVEMENT le markdown avant
  // affichage pour que la carte ne montre pas ">[!NOTE] Source > 🔗 [url…"
  // qui pollue le preview de tous les pads ingérés — on veut le premier
  // paragraphe de vrai contenu, pas la callout de métadonnées.
  useEffect(() => {
    const docTabs = tabs.filter(t => t.padType === 'document' && !previews[t.id]);
    docTabs.forEach(tab => {
      fetch(`/api/pad/${tab.id}`)
        .then(r => r.json())
        .then(data => {
          const raw = (data?.content || '') as string;
          const cleaned = raw
            // Retire les commentaires HTML (blocs alcove:video etc.)
            .replace(/<!--[\s\S]*?-->/g, '')
            // Retire les callouts blockquote entiers (>...) — souvent la
            // note "Source" injectée par AddFromLink en tête de digest.
            .replace(/^>.*$/gm, '')
            // Titres, gras, italiques, code, ancres wiki
            .replace(/^#{1,6}\s+/gm, '')
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            // Emojis/markers noise
            .replace(/[👤📅🔗📋✨📚🎬📄🎥🧠]/g, '')
            // Séparateurs et sauts de ligne multiples
            .replace(/\n{2,}/g, ' · ')
            .replace(/^-{3,}$/gm, '')
            .replace(/\s+/g, ' ')
            .trim();
          setPreviews(prev => ({ ...prev, [tab.id]: cleaned.slice(0, 160) }));
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
    // AI mode : le filter passe uniquement par l'ID renvoyé par le RAG.
    // Si aiHits est null (chargement en cours ou moins de 3 caractères)
    // on tombe sur le comportement text pour ne pas afficher un vide
    // trompeur pendant le debounce.
    const matchesQuery = !query.trim()
      ? true
      : searchMode === 'ai' && aiHits
        ? aiHits.has(t.id)
        : t.title.toLowerCase().includes(query.toLowerCase());
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

  /** Icône dominante par type de pad — grosse silhouette au centre du
   *  thumb quand aucune image n'a été extraite. Chaque type garde une
   *  identité visuelle même sans cover : canvas dessine, kanban range,
   *  gantt planifie, latex calcule. */
  const iconForType = (padType?: string, size?: number): React.ReactNode => {
    const props = size ? { size } : {};
    switch (padType) {
      case 'canvas':   return <PenTool {...props} />;
      case 'kanban':   return <Kanban {...props} />;
      case 'gantt':    return <GanttChart {...props} />;
      case 'latex':    return <Sigma {...props} />;
      case 'database': return <Database {...props} />;
      case 'document':
      default:         return <FileText {...props} />;
    }
  };

  /** Rendu d'une carte de pad. Le thumb domine visuellement — soit une
   *  image extraite (YouTube, OG, PDF cover), soit un gradient au tint
   *  de la carte avec l'icône type au centre. Le type de pad passe en
   *  overlay coin sur le thumb, plus en bannière au-dessus qui volait
   *  l'attention pour rien. */
  const renderCard = (tab: Tab) => {
    const typeLabel = (typeLabels as Record<string, string>)[tab.padType || 'canvas']
      || (tab.padType || 'canvas');
    let sourceHost = '';
    if (tab.sourceUrl) {
      try { sourceHost = new URL(tab.sourceUrl).hostname.replace(/^www\./, ''); } catch {}
    }
    const fav = sourceHost ? `https://www.google.com/s2/favicons?domain=${sourceHost}&sz=32` : '';
    const preview = tab.padType === 'document' ? previews[tab.id] : '';
    return (
      <button
        key={tab.id}
        className={`dashboard__card ${selectedTabId === tab.id ? 'active' : ''} ${tab.isScratch ? 'scratch' : ''}`}
        style={{ '--card-tint': cardTint(tab.id) } as React.CSSProperties}
        onClick={() => handleSelect(tab.id)}
      >
        <div className={`dashboard__card-thumb ${tab.thumbnailUrl ? '' : 'dashboard__card-thumb--iconic'}`}>
          {tab.thumbnailUrl ? (
            <img
              src={tab.thumbnailUrl}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            iconForType(tab.padType)
          )}
          <span className="dashboard__card-type">
            {iconForType(tab.padType, 11)}
            {typeLabel}
          </span>
          {tab.isScratch && <span className="dashboard__card-scratch">Scratch</span>}
        </div>
        <div className="dashboard__card-body">
          {sourceHost && (
            <div className="dashboard__card-source">
              {fav && (
                <img
                  className="dashboard__card-source-fav"
                  src={fav}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                />
              )}
              <span className="dashboard__card-source-host">{sourceHost}</span>
            </div>
          )}
          <div className="dashboard__card-title">{tab.title}</div>
          {preview && (
            <div className="dashboard__card-preview">{preview}</div>
          )}
          {(tab.tags || []).length > 0 && (
            <div className="dashboard__card-tags">
              {(tab.tags || []).slice(0, 4).map(tag => (
                <span
                  key={tag}
                  className="dashboard__card-tag"
                  onClick={e => { e.stopPropagation(); setActiveTag(t => t === tag ? null : tag); }}
                >{tag}</span>
              ))}
            </div>
          )}
          <div className="dashboard__card-meta">{formatDate(tab.updatedAt)}</div>
        </div>
      </button>
    );
  };

  /** Tuile "Quick actions" épinglée en tête de la première section — le
   *  geste Recall qui remplace le "New pad" du terminal-look ancien par une
   *  colonne d'entrées visuelles au format carte. Un clic sur n'importe
   *  quelle action route vers la modale unifiée (qui garde la source de
   *  vérité de tout le flow de création). */
  const QuickActionsTile: React.FC = () => (
    <div
      className="dashboard__card dashboard__card--quick"
      onClick={onUnifiedAdd}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onUnifiedAdd(); }}
      role="button"
      tabIndex={0}
      aria-label={t('dashboard.add')}
    >
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
      <div className="dashboard" role="dialog" aria-modal="true" aria-labelledby="dashboard-title">
        {/* Header */}
        <div className="dashboard__header">
          <div className="dashboard__title" id="dashboard-title">
            <span className="dashboard__brand-mark"><LinkIcon size={17} /></span>
            <span>
              <strong>Alcove</strong>
              <small>Ta mémoire personnelle, retrouvable.</small>
            </span>
          </div>
          <div className="dashboard__actions">
            <div className="dashboard__tabs">
              <button className={`dashboard__tab-btn ${activeView === 'pads' ? 'active' : ''}`} onClick={() => setActiveView('pads')}>
                <Grid2X2 size={13} /> {t('dashboard.pads')}
              </button>
              <button className={`dashboard__tab-btn ${activeView === 'templates' ? 'active' : ''}`} onClick={() => setActiveView('templates')}>
                <Layers size={13} /> {t('dashboard.templates')}
              </button>
            </div>
            <button
              className="dashboard__create-btn dashboard__create-btn--primary"
              onClick={onUnifiedAdd}
              title={t('dashboard.addTitle')}
            >
              <Plus size={14} /> {t('dashboard.add')}
            </button>
            <button className="dashboard__close" onClick={onClose} aria-label={t('dashboard.close')} title={t('dashboard.close')}><X size={18} /></button>
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
            <div className="dashboard__capture">
              <div>
                <strong>Garde ce qui compte.</strong>
                <span>Ajoute un lien, une vidéo, un PDF ou une idée. Alcove résume, organise et te permet de tout retrouver.</span>
              </div>
              <button onClick={onUnifiedAdd}><Plus size={16} /> Ajouter une source</button>
            </div>
            <div className="dashboard__controls">
              <div className="dashboard__search-wrap">
                <Search size={14} className="dashboard__search-icon" />
                <input
                  ref={searchRef}
                  className="dashboard__search"
                  placeholder={searchMode === 'ai' ? t('search.aiPlaceholder') : t('search.placeholder')}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
                <div className="dashboard__search-mode" role="tablist" aria-label={t('search.mode')}>
                  <button
                    className={`dashboard__search-mode-btn ${searchMode === 'text' ? 'active' : ''}`}
                    onClick={() => setSearchMode('text')}
                    role="tab"
                    aria-selected={searchMode === 'text'}
                    title={t('search.textTooltip')}
                  >{t('search.text')}</button>
                  <button
                    className={`dashboard__search-mode-btn ${searchMode === 'ai' ? 'active' : ''}`}
                    onClick={() => setSearchMode('ai')}
                    role="tab"
                    aria-selected={searchMode === 'ai'}
                    title={t('search.aiTooltip')}
                  >{t('search.ai')}{aiSearching ? '…' : ''}</button>
                </div>
              </div>
              <div className="dashboard__sort">
                {(['updated', 'created', 'name', 'type'] as SortKey[]).map(k => (
                  <button
                    key={k}
                    className={`dashboard__sort-btn ${sortKey === k ? 'active' : ''}`}
                    onClick={() => setSortKey(k)}
                  >
                    {t(`dashboard.sort.${k}`)}
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
