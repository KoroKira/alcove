import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search, FileText, CalendarDays, Network,
  Grid2X2, Grid3X3, Plus, Columns3, GanttChart, Zap, Upload, BookOpen, LifeBuoy, Link2, Telescope, Table2,
} from 'lucide-react';
import { Tab } from '../hooks/usePadTabs';
import { fuzzyFilter } from '../lib/fuzzy';
import './CommandPalette.scss';

interface Command {
  id: string;
  label: string;
  icon: React.ReactNode;
  kbd?: string;
  action: () => void;
}

interface Props {
  tabs: Tab[];
  onSelectPad: (id: string) => void;
  onClose: () => void;
  onNewCanvas: () => void;
  onNewDocument: () => void;
  onNewKanban?: () => void;
  onNewGantt?: () => void;
  onNewDatabase?: () => void;
  onDailyNote: () => void;
  onGraph: () => void;
  onDashboard: () => void;
  onSearch: () => void;
  onToggleGrid: () => void;
  onQuickCapture?: () => void;
  onImportObsidian?: () => void;
  onFlashcardStudio?: () => void;
  onOpenGuide?: () => void;
  onAddFromLink?: () => void;
  onSmartResearch?: () => void;
}

const CommandPalette: React.FC<Props> = ({
  tabs, onSelectPad, onClose,
  onNewCanvas, onNewDocument, onNewKanban, onNewGantt, onNewDatabase, onDailyNote, onGraph,
  onDashboard, onSearch, onToggleGrid, onQuickCapture, onImportObsidian, onFlashcardStudio,
  onOpenGuide, onAddFromLink, onSmartResearch,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const wrap = (fn: () => void) => () => { fn(); onClose(); };

  const commands: Command[] = [
    { id: 'new-canvas',   label: t('command.newCanvas'),    icon: <Plus size={15} />,          kbd: '⌘N',  action: wrap(onNewCanvas) },
    { id: 'new-doc',      label: t('command.newNote'),      icon: <FileText size={15} />,      action: wrap(onNewDocument) },
    ...(onNewKanban ? [{ id: 'new-kanban', label: 'Nouveau Kanban',  icon: <Columns3 size={15} />, action: wrap(onNewKanban) }] : []),
    ...(onNewGantt  ? [{ id: 'new-gantt',  label: 'Nouveau Gantt',   icon: <GanttChart size={15} />, action: wrap(onNewGantt) }] : []),
    ...(onNewDatabase ? [{ id: 'new-database', label: 'Nouvelle base de données (Table / Board)', icon: <Table2 size={15} />, action: wrap(onNewDatabase) }] : []),
    { id: 'daily',        label: t('command.dailyNote'),    icon: <CalendarDays size={15} />, kbd: '⌘T',  action: wrap(onDailyNote) },
    { id: 'graph',        label: t('command.graph'),        icon: <Network size={15} />,      kbd: '⌘⇧G', action: wrap(onGraph) },
    { id: 'dashboard',    label: t('command.dashboard'),    icon: <Grid2X2 size={15} />,      kbd: '⌘D',  action: wrap(onDashboard) },
    { id: 'search',       label: t('command.search'),       icon: <Search size={15} />,       kbd: '⌘K',  action: wrap(onSearch) },
    { id: 'grid',         label: t('command.toggleGrid'),   icon: <Grid3X3 size={15} />,      kbd: '⌘G',  action: wrap(onToggleGrid) },
    ...(onQuickCapture    ? [{ id: 'quick-capture', label: 'Capture rapide', icon: <Zap size={15} />, kbd: '⌘⇧N', action: wrap(onQuickCapture) }] : []),
    ...(onAddFromLink     ? [{ id: 'add-from-link', label: 'Ajouter depuis un lien (web / PDF / YouTube / audio / vidéo)', icon: <Link2 size={15} />, action: wrap(onAddFromLink) }] : []),
    ...(onSmartResearch   ? [{ id: 'smart-research', label: 'Smart Research (recherche web → note citée)', icon: <Telescope size={15} />, action: wrap(onSmartResearch) }] : []),
    ...(onImportObsidian  ? [{ id: 'import-obsidian', label: 'Importer depuis Obsidian', icon: <Upload size={15} />, action: wrap(onImportObsidian) }] : []),
    ...(onFlashcardStudio ? [{ id: 'flashcard-studio', label: 'Studio de révision (flashcards)', icon: <BookOpen size={15} />, action: wrap(onFlashcardStudio) }] : []),
    ...(onOpenGuide       ? [{ id: 'open-guide', label: 'Ouvrir le guide Alcove', icon: <LifeBuoy size={15} />, action: wrap(onOpenGuide) }] : []),
  ];

  const q = query.trim();

  // Fuzzy-rank commands by label.
  const matchedCommands = fuzzyFilter(commands, q, c => c.label).map(r => r.item);

  // Pads: fuzzy-rank by title when searching; otherwise show the most recently
  // updated first (a proper "jump to what I was working on" switcher). Scratch
  // pad always floats to the top of the recency list.
  const matchedPads = q
    ? fuzzyFilter(tabs, q, t => t.title).map(r => r.item).slice(0, 12)
    : [...tabs]
        .sort((a, b) => {
          if (a.isScratch !== b.isScratch) return a.isScratch ? -1 : 1;
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        })
        .slice(0, 8);

  // When the user is actively searching, prioritise pads (switcher intent);
  // with an empty query, lead with commands as an action menu.
  type Item = { kind: 'cmd'; cmd: Command } | { kind: 'pad'; tab: Tab };
  const cmdItems: Item[] = matchedCommands.map(c => ({ kind: 'cmd' as const, cmd: c }));
  const padItems: Item[] = matchedPads.map(t => ({ kind: 'pad' as const, tab: t }));
  const items: Item[] = q ? [...padItems, ...cmdItems] : [...cmdItems, ...padItems];

  useEffect(() => { setActiveIndex(0); }, [query]);

  useEffect(() => {
    const active = listRef.current?.querySelector('.command-palette__item--active');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, items.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[activeIndex];
      if (!item) return;
      if (item.kind === 'cmd') item.cmd.action();
      else { onSelectPad(item.tab.id); onClose(); }
    }
  };

  const padTypeLabel = (type?: string) => type === 'document' ? t('command.typeDocument') : t('command.typeCanvas');

  return (
    <div className="command-palette-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="command-palette" onKeyDown={handleKeyDown}>
        <div className="command-palette__input-wrap">
          <Search size={16} className="command-palette__icon" />
          <input
            ref={inputRef}
            className="command-palette__input"
            placeholder={t('command.placeholder')}
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <span className="command-palette__hint">↑↓ · ↵ · Esc</span>
        </div>

        <div className="command-palette__results" ref={listRef}>
          {items.length === 0 && (
            <div className="command-palette__empty">{t('search.noResults')}</div>
          )}

          {items.map((item, idx) => {
            const prev = items[idx - 1];
            const showHeader = idx === 0 || prev?.kind !== item.kind;
            const isActive = activeIndex === idx;
            const groupLabel = item.kind === 'cmd' ? 'Commandes' : 'Pads';

            if (item.kind === 'cmd') {
              const cmd = item.cmd;
              return (
                <React.Fragment key={cmd.id}>
                  {showHeader && <div className="command-palette__group-label">{groupLabel}</div>}
                  <button
                    className={`command-palette__item ${isActive ? 'command-palette__item--active' : ''}`}
                    onClick={cmd.action}
                    onMouseEnter={() => setActiveIndex(idx)}
                  >
                    <span className="command-palette__item-icon">{cmd.icon}</span>
                    <span className="command-palette__item-label">{cmd.label}</span>
                    <span className="command-palette__item-meta">
                      {cmd.kbd && <span className="command-palette__item-kbd">{cmd.kbd}</span>}
                    </span>
                  </button>
                </React.Fragment>
              );
            }

            const tab = item.tab;
            return (
              <React.Fragment key={tab.id}>
                {showHeader && <div className="command-palette__group-label">{groupLabel}</div>}
                <button
                  className={`command-palette__item ${isActive ? 'command-palette__item--active' : ''}`}
                  onClick={() => { onSelectPad(tab.id); onClose(); }}
                  onMouseEnter={() => setActiveIndex(idx)}
                >
                  <span className="command-palette__item-icon">
                    {tab.padType === 'document' ? <FileText size={15} /> : tab.padType === 'kanban' ? <Columns3 size={15} /> : tab.padType === 'gantt' ? <GanttChart size={15} /> : <FileText size={15} />}
                  </span>
                  <span className="command-palette__item-label">{tab.title}</span>
                  <span className="command-palette__item-meta">
                    <span className={`command-palette__item-badge command-palette__item-badge--${tab.padType || 'canvas'}`}>
                      {padTypeLabel(tab.padType)}
                    </span>
                    {tab.isScratch && <span className="command-palette__item-kbd">Scratch</span>}
                  </span>
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
