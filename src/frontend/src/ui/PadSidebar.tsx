import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  PenLine,
  Pin,
  CalendarDays,
  Network,
  Layers,
  MoreHorizontal,
  Hash,
  FilePlus,
  Bookmark,
  Columns2,
  Sparkles,
  Columns3,
  GanttChart,
  Table2,
  Home,
  Palette,
  Keyboard,
  Zap,
  Upload,
  Link2,
  Telescope,
  BookOpen,
  GraduationCap,
  Sigma,
  Trash2,
  X,
  Folder,
  FolderInput,
  ChevronDown,
} from 'lucide-react';
import { LANGUAGES, setLanguage, type LangCode } from '../i18n';
import { getTheme } from '../themes';
import { getDueCounts } from '../lib/reviewActivity';
import type { Tab } from '../hooks/usePadTabs';
import TabContextMenu from './TabContextMenu';
import './PadSidebar.scss';

interface PadSidebarProps {
  tabs: Tab[];
  selectedTabId: string;
  isAuthenticated: boolean;
  isCreatingPad: boolean;
  currentUserId?: string;
  onSelectPad: (id: string) => void;
  onNewNote: () => Promise<Tab | null | undefined>;
  onNewCanvas: () => Promise<Tab | null | undefined>;
  onNewKanban?: () => void;
  onNewGantt?: () => void;
  onNewDatabase?: () => void;
  onDailyNote: () => void;
  onGraph: () => void;
  onTemplates: () => void;
  onRename: (args: { padId: string; newName: string }) => void;
  onDelete: (padId: string) => void;
  onLeaveSharedPad: (padId: string) => void;
  onUpdateSharingPolicy: (args: { padId: string; policy: string }) => void;
  onUpdateTheme: (args: { padId: string; theme: 'light' | 'dark' | null }) => void;
  onUpdateTags?: (args: { padId: string; tags: string[] }) => void;
  onUpdateFolder?: (args: { padId: string; folder: string | null }) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onTogglePomodoro?: () => void;
  pomodoroActive?: boolean;
  onToggleSplit?: () => void;
  splitActive?: boolean;
  onToggleAI?: () => void;
  aiActive?: boolean;
  onHome?: () => void;
  homeActive?: boolean;
  onTheme?: () => void;
  onShortcuts?: () => void;
  currentThemeId?: string;
  user?: { id?: string; name?: string; email?: string } | null;
  onQuickCapture?: () => void;
  onImportObsidian?: () => void;
  onAddFromLink?: () => void;
  onSmartResearch?: () => void;
  onFlashcardStudio?: () => void;
  onReviewDashboard?: () => void;
  onNewLatex?: () => void;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  padId: string;
  padName: string;
}

const PadIcon: React.FC<{ tab: Tab }> = ({ tab }) => {
  if (tab.isScratch) return <Pin size={13} />;
  if (tab.padType === 'document') return <FileText size={13} />;
  if (tab.padType === 'kanban') return <Columns3 size={13} />;
  if (tab.padType === 'gantt') return <GanttChart size={13} />;
  if (tab.padType === 'latex') return <Sigma size={13} />;
  if (tab.padType === 'database') return <Table2 size={13} />;
  return <PenLine size={13} />;
};

const PadSidebar: React.FC<PadSidebarProps> = ({
  tabs,
  selectedTabId,
  isAuthenticated,
  isCreatingPad,
  currentUserId,
  onSelectPad,
  onNewNote,
  onNewCanvas,
  onNewKanban,
  onNewGantt,
  onNewDatabase,
  onDailyNote,
  onGraph,
  onTemplates,
  onRename,
  onDelete,
  onLeaveSharedPad,
  onUpdateSharingPolicy,
  onUpdateTheme,
  onUpdateTags,
  onUpdateFolder,
  collapsed,
  onToggleCollapse,
  onTogglePomodoro,
  pomodoroActive,
  onToggleSplit,
  splitActive,
  onToggleAI,
  aiActive,
  onHome,
  homeActive,
  onTheme,
  onShortcuts,
  currentThemeId,
  user,
  onQuickCapture,
  onImportObsidian,
  onAddFromLink,
  onSmartResearch,
  onFlashcardStudio,
  onReviewDashboard,
  onNewLatex,
}) => {
  const { t, i18n } = useTranslation();
  const theme = getTheme(currentThemeId ?? 'mocha');
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);

  // Flashcards due today (FSRS-5 state lives in localStorage — see
  // FlashcardStudio / lib/reviewActivity.ts). Was reading the legacy SM-2 key
  // (`alcove-quiz-sm2`) here, which the FSRS migration stopped writing to —
  // the badge silently went stale for any card created after that switch.
  const [dueFlashcards, setDueFlashcards] = useState(0);
  useEffect(() => {
    const count = () => {
      try { setDueFlashcards(getDueCounts().today); }
      catch { setDueFlashcards(0); }
    };
    count();
    const id = setInterval(count, 60_000);
    window.addEventListener('storage', count);
    return () => { clearInterval(id); window.removeEventListener('storage', count); };
  }, []);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false, x: 0, y: 0, padId: '', padName: '',
  });

  // Multi-selection: Cmd/Ctrl+click toggles, Shift+click range-selects.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastClickedRef = useRef<string | null>(null);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Escape clears an active multi-selection.
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') clearSelection(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds.size, clearSelection]);

  const allTags = useMemo(
    () => Array.from(new Set(tabs.flatMap(t => t.tags || []).filter(tag => tag !== 'read-later'))).sort(),
    [tabs],
  );

  const readLaterTabs = useMemo(
    () => tabs.filter(t => (t.tags || []).includes('read-later')),
    [tabs],
  );

  const sortedFiltered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return [...tabs]
      .filter(t => {
        const matchQ = !q || t.title.toLowerCase().includes(q);
        const matchTag = !activeTag || (t.tags || []).includes(activeTag);
        return matchQ && matchTag;
      })
      .sort((a, b) => {
        if (a.isScratch && !b.isScratch) return -1;
        if (!a.isScratch && b.isScratch) return 1;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
  }, [tabs, query, activeTag]);

  // ── Folder grouping ──
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('alcove-collapsed-folders') || '[]')); }
    catch { return new Set(); }
  });
  const toggleFolder = useCallback((name: string) => {
    setCollapsedFolders(prev => {
      const n = new Set(prev);
      n.has(name) ? n.delete(name) : n.add(name);
      localStorage.setItem('alcove-collapsed-folders', JSON.stringify([...n]));
      return n;
    });
  }, []);

  const folderNames = useMemo(() => {
    const s = new Set<string>();
    sortedFiltered.forEach(tb => { if (tb.folder) s.add(tb.folder); });
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [sortedFiltered]);

  const knownFolders = useMemo(
    () => Array.from(new Set(tabs.map(tb => tb.folder).filter(Boolean) as string[])).sort(),
    [tabs],
  );

  // Flat render sequence: folder groups (alphabetical) then ungrouped pads.
  // Each pad row carries its index into the *visible* pad sequence so Shift-
  // range selection keeps working across the grouped layout.
  type Row =
    | { kind: 'header'; folder: string; count: number }
    | { kind: 'pad'; tab: Tab; flatIndex: number };
  const rows = useMemo(() => {
    const r: Row[] = [];
    let flat = 0;
    for (const f of folderNames) {
      const inFolder = sortedFiltered.filter(tb => tb.folder === f);
      r.push({ kind: 'header', folder: f, count: inFolder.length });
      if (!collapsedFolders.has(f)) {
        for (const tab of inFolder) r.push({ kind: 'pad', tab, flatIndex: flat++ });
      }
    }
    for (const tab of sortedFiltered.filter(tb => !tb.folder)) {
      r.push({ kind: 'pad', tab, flatIndex: flat++ });
    }
    return r;
  }, [folderNames, sortedFiltered, collapsedFolders]);

  const flatVisibleIds = useMemo(
    () => rows.flatMap(row => (row.kind === 'pad' ? [row.tab.id] : [])),
    [rows],
  );

  // Ask for a folder name (existing or new) and move a set of pads into it.
  const promptMoveToFolder = useCallback((padIds: string[]) => {
    if (!onUpdateFolder || padIds.length === 0) return;
    const hint = knownFolders.length ? `\n(${t('sidebar.folderExisting')} : ${knownFolders.join(', ')})` : '';
    const input = window.prompt(t('sidebar.folderPrompt') + hint, '');
    if (input === null) return; // cancelled
    const folder = input.trim() || null; // empty = ungroup
    padIds.forEach(id => onUpdateFolder({ padId: id, folder }));
  }, [onUpdateFolder, knownFolders, t]);

  // Click on a pad row: plain = open, Cmd/Ctrl = toggle, Shift = range-select.
  const handleItemClick = (e: React.MouseEvent, tab: Tab, index: number) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      setSelectedIds(prev => {
        const n = new Set(prev);
        n.has(tab.id) ? n.delete(tab.id) : n.add(tab.id);
        return n;
      });
      lastClickedRef.current = tab.id;
      return;
    }
    if (e.shiftKey && lastClickedRef.current) {
      e.preventDefault();
      const ids = flatVisibleIds;
      const a = ids.indexOf(lastClickedRef.current);
      const b = index;
      if (a !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelectedIds(prev => {
          const n = new Set(prev);
          for (let i = lo; i <= hi; i++) n.add(ids[i]);
          return n;
        });
      }
      return;
    }
    clearSelection();
    lastClickedRef.current = tab.id;
    onSelectPad(tab.id);
  };

  const bulkAddTag = () => {
    const input = window.prompt(t('sidebar.bulkTagPrompt'));
    if (!input?.trim() || !onUpdateTags) return;
    const newTags = input.split(',').map(s => s.trim()).filter(Boolean);
    tabs.filter(tb => selectedIds.has(tb.id)).forEach(tb => {
      const merged = Array.from(new Set([...(tb.tags || []), ...newTags]));
      onUpdateTags({ padId: tb.id, tags: merged });
    });
    clearSelection();
  };

  const bulkDelete = () => {
    const count = selectedIds.size;
    if (!window.confirm(t('sidebar.bulkDeleteConfirm', { count }))) return;
    selectedIds.forEach(id => onDelete(id));
    clearSelection();
  };

  const bulkMoveFolder = () => {
    promptMoveToFolder([...selectedIds]);
    clearSelection();
  };

  const openContextMenu = (e: React.MouseEvent, tab: Tab) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, padId: tab.id, padName: tab.title });
  };

  const openContextMenuFromBtn = (e: React.MouseEvent, tab: Tab) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenu({ visible: true, x: rect.right + 4, y: rect.top, padId: tab.id, padName: tab.title });
  };

  const closeContextMenu = () => setContextMenu(prev => ({ ...prev, visible: false }));
  const ctxTab = tabs.find(t => t.id === contextMenu.padId);

  if (collapsed) {
    return (
      <div className="pad-sidebar pad-sidebar--collapsed">
        <button
          className="pad-sidebar__icon-btn"
          onClick={onToggleCollapse}
          title={t('sidebar.toggleOpen')}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    );
  }

  return (
    <aside className="pad-sidebar">
      {/* Header */}
      <div className="pad-sidebar__header">
        <span className="pad-sidebar__wordmark">Alcove</span>
        <button
          className="pad-sidebar__icon-btn"
          onClick={onToggleCollapse}
          title={t('sidebar.toggleClose')}
        >
          <ChevronLeft size={15} />
        </button>
      </div>

      {/* Search */}
      <div className="pad-sidebar__search-row">
        <input
          className="pad-sidebar__search"
          type="text"
          placeholder={t('sidebar.filter')}
          value={query}
          onChange={e => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>

      {/* File list */}
      <div className="pad-sidebar__section pad-sidebar__section--fill">
        <div className="pad-sidebar__section-header">
          <span className="pad-sidebar__section-label">{t('sidebar.files').toUpperCase()}</span>
          {isAuthenticated && (
            <div className="pad-sidebar__section-actions">
              <button
                className="pad-sidebar__icon-btn"
                onClick={() => onNewNote()}
                disabled={isCreatingPad}
                title={t('sidebar.newNote')}
              >
                <FilePlus size={14} />
              </button>
              <button
                className="pad-sidebar__icon-btn"
                onClick={() => onNewCanvas()}
                disabled={isCreatingPad}
                title={t('sidebar.newCanvas')}
              >
                <PenLine size={14} />
              </button>
              {onNewKanban && (
                <button
                  className="pad-sidebar__icon-btn"
                  onClick={onNewKanban}
                  disabled={isCreatingPad}
                  title="Nouveau Kanban"
                >
                  <Columns3 size={14} />
                </button>
              )}
              {onNewGantt && (
                <button
                  className="pad-sidebar__icon-btn"
                  onClick={onNewGantt}
                  disabled={isCreatingPad}
                  title="Nouveau Gantt"
                >
                  <GanttChart size={14} />
                </button>
              )}
              {onNewDatabase && (
                <button
                  className="pad-sidebar__icon-btn"
                  onClick={onNewDatabase}
                  disabled={isCreatingPad}
                  title="Nouvelle base de données (Table / Board)"
                >
                  <Table2 size={14} />
                </button>
              )}
              {onNewLatex && (
                <button
                  className="pad-sidebar__icon-btn"
                  onClick={onNewLatex}
                  disabled={isCreatingPad}
                  title="Nouveau document LaTeX"
                >
                  <Sigma size={14} />
                </button>
              )}
              <button
                className="pad-sidebar__icon-btn"
                onClick={onDailyNote}
                title={t('sidebar.dailyNote')}
              >
                <CalendarDays size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Bulk-action bar — shown while a multi-selection is active */}
        {selectedIds.size > 0 && (
          <div className="pad-sidebar__bulk-bar">
            <span className="pad-sidebar__bulk-count">{t('sidebar.bulkSelected', { count: selectedIds.size })}</span>
            {onUpdateFolder && (
              <button className="pad-sidebar__bulk-btn" onClick={bulkMoveFolder} title={t('sidebar.bulkFolder')}>
                <FolderInput size={13} />
              </button>
            )}
            {onUpdateTags && (
              <button className="pad-sidebar__bulk-btn" onClick={bulkAddTag} title={t('sidebar.bulkTag')}>
                <Hash size={13} />
              </button>
            )}
            <button className="pad-sidebar__bulk-btn pad-sidebar__bulk-btn--danger" onClick={bulkDelete} title={t('sidebar.bulkDelete')}>
              <Trash2 size={13} />
            </button>
            <button className="pad-sidebar__bulk-btn" onClick={clearSelection} title={t('sidebar.bulkClear')}>
              <X size={13} />
            </button>
          </div>
        )}

        <div className="pad-sidebar__list">
          {sortedFiltered.length === 0 && (
            <div className="pad-sidebar__empty">{t('sidebar.noFiles')}</div>
          )}
          {rows.map(row => {
            if (row.kind === 'header') {
              const isCollapsed = collapsedFolders.has(row.folder);
              return (
                <button
                  key={`folder-${row.folder}`}
                  className="pad-sidebar__folder-header"
                  onClick={() => toggleFolder(row.folder)}
                  title={row.folder}
                >
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <Folder size={12} className="pad-sidebar__folder-icon" />
                  <span className="pad-sidebar__folder-name">{row.folder}</span>
                  <span className="pad-sidebar__folder-count">{row.count}</span>
                </button>
              );
            }
            const { tab, flatIndex } = row;
            return (
              <div
                key={tab.id}
                className={[
                  'pad-sidebar__item',
                  tab.folder ? 'pad-sidebar__item--in-folder' : '',
                  selectedTabId === tab.id ? 'pad-sidebar__item--active' : '',
                  selectedIds.has(tab.id) ? 'pad-sidebar__item--multiselected' : '',
                  tab.isScratch ? 'pad-sidebar__item--scratch' : '',
                ].filter(Boolean).join(' ')}
                onClick={e => handleItemClick(e, tab, flatIndex)}
                onContextMenu={e => openContextMenu(e, tab)}
                title={tab.title}
              >
                <span className="pad-sidebar__item-icon">
                  <PadIcon tab={tab} />
                </span>
                <span className="pad-sidebar__item-title">{tab.title}</span>
                {(tab.tags?.length ?? 0) > 0 && (
                  <span
                    className="pad-sidebar__item-dot"
                    title={(tab.tags || []).map(t => '#' + t).join(' ')}
                  />
                )}
                <button
                  className="pad-sidebar__item-more"
                  onClick={e => openContextMenuFromBtn(e, tab)}
                  title={t('sidebar.options')}
                  tabIndex={-1}
                >
                  <MoreHorizontal size={12} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Reading list */}
      {readLaterTabs.length > 0 && (
        <div className="pad-sidebar__section">
          <div className="pad-sidebar__section-header">
            <Bookmark size={10} className="pad-sidebar__section-icon" />
            <span className="pad-sidebar__section-label">{t('sidebar.reading').toUpperCase()}</span>
          </div>
          <div className="pad-sidebar__list pad-sidebar__list--compact">
            {readLaterTabs.map(tab => (
              <div
                key={tab.id}
                className={`pad-sidebar__item${selectedTabId === tab.id ? ' pad-sidebar__item--active' : ''}`}
                onClick={() => onSelectPad(tab.id)}
                onContextMenu={e => openContextMenu(e, tab)}
                title={tab.title}
              >
                <span className="pad-sidebar__item-icon"><PadIcon tab={tab} /></span>
                <span className="pad-sidebar__item-title">{tab.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tags */}
      {allTags.length > 0 && (
        <div className="pad-sidebar__section">
          <div className="pad-sidebar__section-header">
            <Hash size={10} className="pad-sidebar__section-icon" />
            <span className="pad-sidebar__section-label">{t('sidebar.tags').toUpperCase()}</span>
          </div>
          <div className="pad-sidebar__tags">
            {allTags.map(tag => (
              <button
                key={tag}
                className={`pad-sidebar__tag${activeTag === tag ? ' pad-sidebar__tag--active' : ''}`}
                onClick={() => setActiveTag(t => t === tag ? null : tag)}
              >
                #{tag}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="pad-sidebar__spacer" />

      {toolsOpen && (
        <div className="pad-sidebar__tools" role="menu" aria-label={t('sidebar.tools')}>
          <div className="pad-sidebar__tools-title">{t('sidebar.tools')}</div>
          {onTogglePomodoro && <button role="menuitem" onClick={() => { onTogglePomodoro(); setToolsOpen(false); }}><span>🍅</span>{t('sidebar.pomodoro')}</button>}
          {onAddFromLink && <button role="menuitem" onClick={() => { onAddFromLink(); setToolsOpen(false); }}><Link2 size={15} />{t('sidebar.addFromLink')}</button>}
          {onSmartResearch && <button role="menuitem" onClick={() => { onSmartResearch(); setToolsOpen(false); }}><Telescope size={15} />{t('sidebar.smartResearch')}</button>}
          {onImportObsidian && <button role="menuitem" onClick={() => { onImportObsidian(); setToolsOpen(false); }}><Upload size={15} />{t('sidebar.importObsidian')}</button>}
          {onFlashcardStudio && <button role="menuitem" onClick={() => { onFlashcardStudio(); setToolsOpen(false); }}><BookOpen size={15} />{t('sidebar.flashcards')}{dueFlashcards > 0 && <span className="pad-sidebar__tools-count">{dueFlashcards}</span>}</button>}
          {onReviewDashboard && <button role="menuitem" onClick={() => { onReviewDashboard(); setToolsOpen(false); }}><GraduationCap size={15} />{t('sidebar.review')}</button>}
        </div>
      )}

      {/* Bottom toolbar — the five recurring destinations stay visible;
          occasional utilities live in the labelled Tools menu. */}
      <div className="pad-sidebar__bottom">
        {onHome && (
          <button className={`pad-sidebar__icon-btn${homeActive ? ' pad-sidebar__icon-btn--active' : ''}`} onClick={onHome} title={t('sidebar.home')} aria-label={t('sidebar.home')}>
            <Home size={16} />
          </button>
        )}
        <button className="pad-sidebar__icon-btn" onClick={onGraph} title={t('sidebar.graph')} aria-label={t('sidebar.graph')}>
          <Network size={16} />
        </button>
        {onToggleSplit && (
          <button className={`pad-sidebar__icon-btn${splitActive ? ' pad-sidebar__icon-btn--active' : ''}`} onClick={onToggleSplit} title={t('sidebar.split')} aria-label={t('sidebar.split')}>
            <Columns2 size={16} />
          </button>
        )}
        {onToggleAI && (
          <button className={`pad-sidebar__icon-btn${aiActive ? ' pad-sidebar__icon-btn--active' : ''}`} onClick={onToggleAI} title={t('ai.title')} aria-label={t('ai.title')} style={aiActive ? { color: 'var(--ap-accent, #cba6f7)' } : undefined}>
            <Sparkles size={16} />
          </button>
        )}
        {onQuickCapture && (
          <button className="pad-sidebar__icon-btn" onClick={onQuickCapture} title={t('sidebar.quickCapture')} aria-label={t('sidebar.quickCapture')}>
            <Zap size={15} />
          </button>
        )}
        <button className={`pad-sidebar__icon-btn${toolsOpen ? ' pad-sidebar__icon-btn--active' : ''}`} onClick={() => setToolsOpen(v => !v)} title={t('sidebar.tools')} aria-label={t('sidebar.tools')} aria-expanded={toolsOpen}>
          <MoreHorizontal size={16} />
        </button>
      </div>

      {/* Bottom toolbar row 2 — theme / lang / shortcuts */}
      <div className="pad-sidebar__bottom-bar">
        {/* Theme swatch button */}
        {onTheme && (
          <button className="pad-sidebar__bar-btn pad-sidebar__bar-btn--theme" onClick={onTheme} title={`${t('sidebar.theme')} : ${theme.name}`} aria-label={`${t('sidebar.theme')} : ${theme.name}`}>
            <span className="pad-sidebar__theme-dot" style={{ background: theme.swatches[1] }} />
            <span className="pad-sidebar__theme-dot" style={{ background: theme.swatches[2] }} />
            <Palette size={12} />
          </button>
        )}

        {/* Language picker (compact flags) */}
        <div className="pad-sidebar__lang-compact">
          {(Object.entries(LANGUAGES) as [LangCode, { label: string; flag: string }][]).map(([code, { flag, label }]) => (
            <button
              key={code}
              className={`pad-sidebar__lang-flag${i18n.language.startsWith(code) ? ' pad-sidebar__lang-flag--active' : ''}`}
              title={label}
              aria-label={label}
              aria-pressed={i18n.language.startsWith(code)}
              onClick={() => setLanguage(code)}
            >
              {flag}
            </button>
          ))}
        </div>

        {/* Shortcuts */}
        {onShortcuts && (
          <button className="pad-sidebar__bar-btn" onClick={onShortcuts} title={t('sidebar.shortcuts')} aria-label={t('sidebar.shortcuts')}>
            <Keyboard size={13} />
          </button>
        )}
      </div>

      {/* Context menu */}
      {contextMenu.visible && ctxTab && (
        <TabContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          padId={contextMenu.padId}
          padName={contextMenu.padName}
          sharingPolicy={ctxTab.sharingPolicy}
          currentUserId={currentUserId}
          tabOwnerId={ctxTab.ownerId}
          currentTheme={ctxTab.theme}
          currentTags={ctxTab.tags}
          onRename={(padId, newName) => onRename({ padId, newName })}
          onDelete={onDelete}
          onLeaveSharedPad={onLeaveSharedPad}
          onUpdateSharingPolicy={(padId, policy) => onUpdateSharingPolicy({ padId, policy })}
          onUpdateTheme={padId => {
            // Cycle: follow app theme (undefined) → forced dark → forced light → follow app theme
            const theme: 'light' | 'dark' | null =
              ctxTab.theme === undefined ? 'dark' : ctxTab.theme === 'dark' ? 'light' : null;
            onUpdateTheme({ padId, theme });
          }}
          onUpdateTags={onUpdateTags ? (padId, tags) => onUpdateTags({ padId, tags }) : undefined}
          onMoveToFolder={onUpdateFolder ? (padId) => promptMoveToFolder([padId]) : undefined}
          currentFolder={ctxTab.folder}
          onToggleReadLater={onUpdateTags ? (padId, tags) => onUpdateTags({ padId, tags }) : undefined}
          onClose={closeContextMenu}
        />
      )}
    </aside>
  );
};

export default PadSidebar;
