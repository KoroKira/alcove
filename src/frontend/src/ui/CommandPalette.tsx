import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search, FileText, CalendarDays, Network,
  Grid2X2, Grid3X3, Plus, Columns3, GanttChart, Zap, Upload, BookOpen, LifeBuoy, Link2, Telescope, Table2, Sigma, Pencil,
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
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

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
    if (e.key === 'Tab') {
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled]):not([tabindex="-1"]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) {
        e.preventDefault();
      } else {
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!dialogRef.current?.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
      return;
    }
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

  const padTypeMeta = (type?: string): { label: string; icon: React.ReactNode } => {
    switch (type) {
      case 'document': return { label: t('command.typeDocument'), icon: <FileText size={15} /> };
      case 'kanban': return { label: t('command.typeKanban'), icon: <Columns3 size={15} /> };
      case 'gantt': return { label: t('command.typeGantt'), icon: <GanttChart size={15} /> };
      case 'latex': return { label: t('command.typeLatex'), icon: <Sigma size={15} /> };
      case 'database': return { label: t('command.typeDatabase'), icon: <Table2 size={15} /> };
      default: return { label: t('command.typeCanvas'), icon: <Pencil size={15} /> };
    }
  };

  // Group contiguous items of the same kind; each option keeps its flat index
  // so keyboard navigation (aria-activedescendant) and mouse hover agree.
  const groups: { kind: Item['kind']; entries: { item: Item; idx: number }[] }[] = [];
  items.forEach((item, idx) => {
    const last = groups[groups.length - 1];
    if (last && last.kind === item.kind) last.entries.push({ item, idx });
    else groups.push({ kind: item.kind, entries: [{ item, idx }] });
  });

  const listboxId = 'command-palette-listbox';
  const optionId = (idx: number) => `command-palette-option-${idx}`;
  const activeOptionId = items.length > 0 ? optionId(Math.min(activeIndex, items.length - 1)) : undefined;

  return (
    <div className="command-palette-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('command.placeholder')}
        onKeyDown={handleKeyDown}
      >
        <div className="command-palette__input-wrap">
          <Search size={16} className="command-palette__icon" />
          <input
            ref={inputRef}
            className="command-palette__input"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
            aria-label={t('command.placeholder')}
            placeholder={t('command.placeholder')}
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <span className="command-palette__hint">↑↓ · ↵ · Esc</span>
        </div>

        {/* Result count for screen readers; the highlighted option itself is
            announced through aria-activedescendant. */}
        <div role="status" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
          {items.length > 0 ? t('command.resultsCount', { count: items.length }) : ''}
        </div>

        <div className="command-palette__results" ref={listRef} role="listbox" id={listboxId} aria-label={t('command.placeholder')}>
          {items.length === 0 && (
            <div className="command-palette__empty" role="status">{t('search.noResults')}</div>
          )}

          {groups.map(group => {
            const labelId = `command-palette-group-${group.kind}`;
            return (
              <div key={group.kind} role="group" aria-labelledby={labelId}>
                <div id={labelId} className="command-palette__group-label">
                  {group.kind === 'cmd' ? t('command.groupCommands') : t('command.groupPads')}
                </div>
                {group.entries.map(({ item, idx }) => {
                  const isActive = activeIndex === idx;
                  const common = {
                    id: optionId(idx),
                    role: 'option' as const,
                    tabIndex: -1,
                    'aria-selected': isActive,
                    className: `command-palette__item ${isActive ? 'command-palette__item--active' : ''}`,
                    onMouseEnter: () => setActiveIndex(idx),
                  };
                  if (item.kind === 'cmd') {
                    const cmd = item.cmd;
                    return (
                      <button key={cmd.id} {...common} onClick={cmd.action}>
                        <span className="command-palette__item-icon">{cmd.icon}</span>
                        <span className="command-palette__item-label">{cmd.label}</span>
                        <span className="command-palette__item-meta">
                          {cmd.kbd && <span className="command-palette__item-kbd">{cmd.kbd}</span>}
                        </span>
                      </button>
                    );
                  }
                  const tab = item.tab;
                  const meta = padTypeMeta(tab.padType);
                  return (
                    <button key={tab.id} {...common} onClick={() => { onSelectPad(tab.id); onClose(); }}>
                      <span className="command-palette__item-icon">{meta.icon}</span>
                      <span className="command-palette__item-label">{tab.title}</span>
                      <span className="command-palette__item-meta">
                        <span className={`command-palette__item-badge command-palette__item-badge--${tab.padType || 'canvas'}`}>
                          {meta.label}
                        </span>
                        {tab.isScratch && <span className="command-palette__item-kbd">Scratch</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
