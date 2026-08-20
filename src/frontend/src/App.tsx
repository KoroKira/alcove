import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from "react";
import type { CanvasTemplate } from './constants/templates';
import { Excalidraw, MainMenu } from "@atyrode/excalidraw";
import type { ExcalidrawImperativeAPI, AppState } from "@atyrode/excalidraw/types";
import type { ExcalidrawEmbeddableElement, NonDeleted } from "@atyrode/excalidraw/element/types";

// Hooks
import { useAuthStatus } from "./hooks/useAuthStatus";
import { usePadTabs } from "./hooks/usePadTabs";
import { useCallbackRefState } from "./hooks/useCallbackRefState";
import { useAppConfig } from "./hooks/useAppConfig";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { usePad } from "./hooks/usePadData";
import { snapshotCanvasPad } from "./lib/thumbnailSnapshot";

// Components
import { MainMenuConfig } from './ui/MainMenu';
import AuthDialog from './ui/AuthDialog';
import Collab from './lib/collab/Collab';
import SearchDialog from './ui/SearchDialog';
import RulerPanel from './ui/RulerPanel';
import Dashboard from './ui/Dashboard';
// Heavy pad editors are lazy-loaded — they pull Monaco / Mermaid / KaTeX /
// frappe-gantt, none of which the default canvas view needs.
const DocumentPad = lazy(() => import('./pad/DocumentPad'));
const KanbanPad = lazy(() => import('./pad/KanbanPad'));
import type { KanbanData } from './pad/KanbanPad';
const GanttPad = lazy(() => import('./pad/GanttPad'));
import type { GanttData } from './pad/GanttPad';
const DatabasePad = lazy(() => import('./pad/DatabasePad'));
import type { DatabaseData } from './pad/DatabasePad';
import PresentationMode from './ui/PresentationMode';
import CommandPalette from './ui/CommandPalette';
import GraphView from './ui/GraphView';
import PadSidebar from './ui/PadSidebar';
import PomodoroTimer from './ui/PomodoroTimer';
import DocumentTemplateDialog from './ui/DocumentTemplateDialog';
// Lazy — statically imports DocumentPad, so keeping it eager would defeat the split.
const SplitDocPanel = lazy(() => import('./ui/SplitDocPanel'));
const ChatView = lazy(() => import('./ui/ChatView'));
import AIPanel from './ui/AIPanel';
import QuickCapture from './ui/QuickCapture';
import ObsidianImport from './ui/ObsidianImport';
import AddFromLink from './ui/AddFromLink';
import SmartResearch from './ui/SmartResearch';
import HomeHub from './ui/HomeHub';
import FlashcardStudio from './ui/FlashcardStudio';
import Onboarding, { shouldShowOnboarding } from './ui/Onboarding';
import UnifiedAddModal from './ui/UnifiedAddModal';
import ThemePicker from './ui/ThemePicker';
import ThemeBuilder from './ui/ThemeBuilder';
import ShortcutOverlay from './ui/ShortcutOverlay';
import { applyTheme, loadSavedTheme, getTheme, type Theme } from './themes';

// Apply theme before first render (no FOUC)
applyTheme(loadSavedTheme());
import type { DocumentTemplate } from './constants/documentTemplates';
import { WELCOME_DOC_CONTENT, WELCOME_DOC_TITLE } from './constants/welcomeDoc';

// Utils
import { useTranslation } from 'react-i18next';
import { initializePostHog } from "./lib/posthog";
import { lockEmbeddables, renderCustomEmbeddable } from './CustomEmbeddableRenderer';
import { INITIAL_APP_DATA, HIDDEN_UI_ELEMENTS } from "./constants";

// ── Canvas color re-mapping when switching dark↔light ─────────────────────────
function hexToHsl(hex: string): [number, number, number] | null {
  const m = hex.replace('#', '').match(/.{2}/g);
  if (!m || m.length < 3) return null;
  const [r, g, b] = m.map(x => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
  const h = max === min ? 0 : max === r ? ((g - b) / (max - min) + (g < b ? 6 : 0)) / 6
    : max === g ? ((b - r) / (max - min) + 2) / 6
    : ((r - g) / (max - min) + 4) / 6;
  return [h * 360, s * 100, l * 100];
}

function remapColorPolarity(color: string, wasDark: boolean, nowDark: boolean, fallback: string): string {
  if (!color || color === 'transparent' || color === 'none' || !color.startsWith('#')) return color;
  const hsl = hexToHsl(color);
  if (!hsl) return color;
  const [, , l] = hsl;
  if (wasDark && !nowDark) {
    // Dark → Light: very light colors (>75% lightness) → use new dark text
    if (l > 75) return fallback;
  } else if (!wasDark && nowDark) {
    // Light → Dark: very dark colors (<25% lightness) → use new light text
    if (l < 25) return fallback;
  }
  return color;
}

// Fallback shown while a lazy-loaded pad editor's chunk is fetched.
function PadLoading() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', color: 'var(--color-on-surface-low, #a6adc8)', fontSize: 14,
    }}>
      Chargement…
    </div>
  );
}

export default function App() {
  const { t, i18n } = useTranslation();
  const excalidrawLang = i18n.language.startsWith('fr') ? 'fr-FR' : 'en-EN';
  const { config, configError } = useAppConfig();
  const { isAuthenticated, isLoading: isLoadingAuth, user } = useAuthStatus();

  const {
    tabs,
    selectedTabId,
    isLoading: isLoadingTabs,
    createNewPadAsync,
    createNewDocumentAsync,
    createNewKanban,
    createNewDatabase,
    createNewGantt,
    createNewLatex,
    isCreating: isCreatingPad,
    renamePad,
    deletePad,
    selectTab,
    updateSharingPolicy,
    updateTheme,
    leaveSharedPad,
    createDailyNote,
    updateTags,
    updateFolder,
    refetchTabs,
  } = usePadTabs(isAuthenticated);

  const [excalidrawAPI, excalidrawRefCallback] = useCallbackRefState<ExcalidrawImperativeAPI>();
  const [searchOpen, setSearchOpen] = useState(false);
  // Landing view — Alcove ouvre par défaut sur le dashboard "bibliothèque" (grille
  // masonry de tous les pads). L'utilisateur peut basculer via localStorage
  // 'alcove-landing' = 'canvas' pour retomber sur l'ancien comportement (canvas
  // Scratch au boot). L'onboarding a la priorité et est traité séparément.
  const [dashboardOpen, setDashboardOpen] = useState(
    () => !shouldShowOnboarding() && localStorage.getItem('alcove-landing') !== 'canvas',
  );
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [chatViewOpen, setChatViewOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [pomodoroOpen, setPomodoroOpen] = useState(false);
  const [docTemplateOpen, setDocTemplateOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitDocId, setSplitDocId] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiDocContent, setAiDocContent] = useState<string | undefined>(undefined);
  const [aiContentToInsert, setAiContentToInsert] = useState<string | null>(null);
  const [pendingDocContent, setPendingDocContent] = useState<string | null>(null);
  const [presentationMode, setPresentationMode] = useState(false);
  const [kanbanData, setKanbanData] = useState<KanbanData | null>(null);
  const [ganttData, setGanttData] = useState<GanttData | null>(null);
  const [databaseData, setDatabaseData] = useState<DatabaseData | null>(null);
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  const [obsidianImportOpen, setObsidianImportOpen] = useState(false);
  const [addLinkOpen, setAddLinkOpen] = useState(false);
  const [smartResearchOpen, setSmartResearchOpen] = useState(false);
  const [homeOpen, setHomeOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(shouldShowOnboarding);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [themeBuilderOpen, setThemeBuilderOpen] = useState(false);
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [flashcardStudioOpen, setFlashcardStudioOpen] = useState(false);
  const [unifiedAddOpen, setUnifiedAddOpen] = useState(false);
  const [currentThemeId, setCurrentThemeId] = useState(() => localStorage.getItem('alcove-theme') ?? 'mocha');
  const activeTheme = getTheme(currentThemeId);
  const prevThemeDarkRef = useRef<boolean>(activeTheme.dark);

  // Canvas colors for the current pad. Excalidraw's appState.theme stays "light"
  // (its dark mode applies an invert() filter that flips custom backgrounds);
  // we drive the background and default ink directly, so the canvas is WYSIWYG.
  // A per-pad theme override opposite to the app polarity uses fixed "paper" colors.
  const canvasColors = useCallback((padTheme?: string) => {
    const wants = padTheme ?? (activeTheme.dark ? 'dark' : 'light');
    if (wants === 'dark') {
      return activeTheme.dark
        ? { bg: activeTheme.vars['--ap-bg0'] ?? '#1e1e2e', ink: activeTheme.vars['--ap-text0'] ?? '#cdd6f4' }
        : { bg: '#1e1e2e', ink: '#cdd6f4' };
    }
    return activeTheme.dark
      ? { bg: '#f6f7f9', ink: '#1f2328' }
      : { bg: activeTheme.vars['--ap-bg0'] ?? '#eff1f5', ink: activeTheme.vars['--ap-text0'] ?? '#4c4f69' };
  }, [activeTheme]);

  // Derived pad-mode flags — declared here (before the canvas effect below) so
  // that effect can reference `isDocumentMode` without a temporal-dead-zone error.
  const selectedTab = tabs.find(t => t.id === selectedTabId);
  const isDocumentMode = selectedTab?.padType === 'document';
  const isKanbanMode = selectedTab?.padType === 'kanban';
  const isGanttMode = selectedTab?.padType === 'gantt';
  const isLatexMode = selectedTab?.padType === 'latex';
  const isDatabaseMode = selectedTab?.padType === 'database';
  const isStructuredMode = isDocumentMode || isKanbanMode || isGanttMode || isLatexMode || isDatabaseMode;
  const firstDocTab = tabs.find(t => t.padType === 'document');
  const splitPanelDocId = splitDocId || firstDocTab?.id || null;

  // Single source of truth for the canvas background/ink. Fires on both theme
  // change AND pad selection change (previously two overlapping effects that
  // double-applied on theme change). On a dark↔light polarity flip it also
  // re-maps existing element colours so nothing becomes invisible.
  useEffect(() => {
    if (!excalidrawAPI || isDocumentMode) return;
    const theme = activeTheme;
    const tab = tabs.find(tb => tb.id === selectedTabId);
    const { bg, ink } = canvasColors(tab?.theme);
    const wasDark = prevThemeDarkRef.current;
    const isDark = theme.dark;

    const baseAppState = { theme: 'light', viewBackgroundColor: bg, currentItemStrokeColor: ink };

    if (wasDark !== isDark) {
      const elements = excalidrawAPI.getSceneElements();
      const remapped = elements.map((el: any) => {
        const sc = remapColorPolarity(el.strokeColor, wasDark, isDark, theme.vars['--ap-text0'] ?? '#cdd6f4');
        const bc = el.backgroundColor && el.backgroundColor !== 'transparent'
          ? remapColorPolarity(el.backgroundColor, wasDark, isDark, theme.vars['--ap-bg2'] ?? '#313244')
          : el.backgroundColor;
        return (sc !== el.strokeColor || bc !== el.backgroundColor) ? { ...el, strokeColor: sc, backgroundColor: bc } : el;
      });
      excalidrawAPI.updateScene({ elements: remapped as any, appState: baseAppState } as any);
    } else {
      excalidrawAPI.updateScene({ appState: baseAppState } as any);
    }

    prevThemeDarkRef.current = isDark;
  }, [currentThemeId, selectedTabId, excalidrawAPI, isDocumentMode, canvasColors, tabs, activeTheme]);

  // Bulletproof guard: Excalidraw toggles a `theme--dark` class on its container
  // whenever its internal state.theme is "dark", and that class both (a) applies
  // an invert(93%) filter to the <canvas> and (b) overrides our chrome colors via
  // higher-specificity vars. Our updateScene calls keep theme "light", but any
  // transient race (pad load, HMR, StrictMode double-mount) can flip it for a beat.
  // A MutationObserver strips the class the instant it appears, so the canvas can
  // never invert regardless of Excalidraw's internal state.
  useEffect(() => {
    if (!excalidrawAPI) return;
    const container = document.querySelector<HTMLElement>('.excalidraw');
    if (!container) return;
    const strip = () => {
      if (container.classList.contains('theme--dark')) {
        container.classList.remove('theme--dark');
      }
    };
    strip();
    const obs = new MutationObserver(strip);
    obs.observe(container, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, [excalidrawAPI]);

  const pendingTemplateRef = useRef<CanvasTemplate | null>(null);

  // Load canvas pad data whenever selectedTabId changes (replaces the usePad in Tabs.tsx)
  usePad(
    isStructuredMode ? null : selectedTabId,
    excalidrawAPI,
    canvasColors(selectedTab?.theme),
  );

  // Load kanban/gantt data when switching to a structured pad
  useEffect(() => {
    if (!selectedTabId) return;
    if (isKanbanMode) {
      setKanbanData(null);
      fetch(`/api/pad/${selectedTabId}`)
        .then(r => r.json())
        .then(d => setKanbanData(d as KanbanData))
        .catch(console.error);
    } else if (isGanttMode) {
      setGanttData(null);
      fetch(`/api/pad/${selectedTabId}`)
        .then(r => r.json())
        .then(d => setGanttData(d as GanttData))
        .catch(console.error);
    } else if (isDatabaseMode) {
      setDatabaseData(null);
      fetch(`/api/pad/${selectedTabId}`)
        .then(r => r.json())
        .then(d => setDatabaseData(d as DatabaseData))
        .catch(console.error);
    }
  }, [selectedTabId, isKanbanMode, isGanttMode, isDatabaseMode]);

  // Auto-collapse sidebar in canvas mode so Excalidraw panels have full viewport
  useEffect(() => {
    setSidebarCollapsed(!isStructuredMode);
  }, [isStructuredMode]);

  // Offline indicator
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const on = () => setIsOffline(false);
    const off = () => setIsOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // Apply pending canvas template after new pad is created
  useEffect(() => {
    if (!excalidrawAPI || !pendingTemplateRef.current || isDocumentMode) return;
    const tmpl = pendingTemplateRef.current;
    pendingTemplateRef.current = null;
    if (!tmpl.elements.length) return;
    setTimeout(() => {
      excalidrawAPI.updateScene({ elements: tmpl.elements as any, appState: (tmpl.appState || {}) as any });
    }, 400);
  }, [excalidrawAPI, selectedTabId, isDocumentMode]);

  const handleCreateFromTemplate = async (template: CanvasTemplate) => {
    if (template.id === 'blank') { createNewPadAsync(); setDashboardOpen(false); return; }
    pendingTemplateRef.current = template;
    createNewPadAsync();
    setDashboardOpen(false);
  };

  const handleNewNoteFromTemplate = (template: DocumentTemplate) => {
    setDocTemplateOpen(false);
    const content = template.content();
    if (!content) {
      createNewDocumentAsync();
      return;
    }
    // Set pendingDocContent BEFORE the pad is selected so DocumentPad uses it on first load
    setPendingDocContent(content);
    createNewDocumentAsync().then(tab => {
      if (!tab) return;
      // Also persist to backend (fire-and-forget — DocumentPad already has the content)
      fetch(`/api/pad/${tab.id}/doc`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, format: 'markdown' }),
      }).catch(console.error);
    });
  };

  // Seed the "Guide Alcove" pad — a living cheat-sheet created once on first
  // launch (from the Onboarding). It stays in the pad list, editable, so the
  // app's hidden syntax (wikilinks, callouts, flashcards…) is discoverable.
  const seedWelcomeGuide = useCallback(async ({ open }: { open: boolean }) => {
    if (localStorage.getItem('alcove_welcome_seeded')) {
      if (open) {
        const existing = tabs.find(t => t.title === WELCOME_DOC_TITLE);
        if (existing) selectTab(existing.id);
      }
      return;
    }
    localStorage.setItem('alcove_welcome_seeded', '1');
    if (open) setPendingDocContent(WELCOME_DOC_CONTENT);
    try {
      const tab = await createNewDocumentAsync();
      if (!tab) return;
      // Sequence, don't race: /doc's save() rewrites the whole row (incl.
      // display_name), so the rename MUST land after the content save — fire
      // them concurrently and the doc save clobbers the title back to default.
      await fetch(`/api/pad/${tab.id}/doc`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: WELCOME_DOC_CONTENT, format: 'markdown' }),
      });
      await fetch(`/api/pad/${tab.id}/rename`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: WELCOME_DOC_TITLE }),
      });
      refetchTabs();
      if (open) selectTab(tab.id);
    } catch (e) {
      console.error('[alcove] Welcome guide seeding failed:', e);
    }
  }, [tabs, createNewDocumentAsync, refetchTabs, selectTab]);

  const handleToggleGrid = () => {
    if (!excalidrawAPI || isDocumentMode) return;
    const current = excalidrawAPI.getAppState() as any;
    excalidrawAPI.updateScene({ appState: { gridModeEnabled: !current.gridModeEnabled } } as any);
  };

  // Dashboard card thumbnail for canvas pads. Unlike the structured pad
  // types (kanban/gantt/database each have one debounced save() call site
  // to hook), canvas content is persisted through the Yjs collab layer —
  // there's no single "just saved" moment in the React tree to react to.
  // A 30s interval while a canvas tab is open is the pragmatic equivalent;
  // snapshotCanvasPad throttles internally too, so this is just the timer
  // that drives it.
  useEffect(() => {
    if (!excalidrawAPI || isStructuredMode || !selectedTabId) return;
    const id = setInterval(() => {
      void snapshotCanvasPad(selectedTabId, excalidrawAPI);
    }, 30_000);
    // Also catch a quick edit-then-switch-away without waiting for the next
    // tick — the internal throttle means this never fires more than once
    // per 30s per pad regardless of how often the effect re-runs.
    return () => {
      clearInterval(id);
      void snapshotCanvasPad(selectedTabId, excalidrawAPI);
    };
  }, [excalidrawAPI, isStructuredMode, selectedTabId]);

  const exportCanvasPng = async () => {
    if (!excalidrawAPI || isDocumentMode) return;
    try {
      const { exportToBlob } = await import('@atyrode/excalidraw');
      const blob = await exportToBlob({
        elements: excalidrawAPI.getSceneElements(),
        appState: excalidrawAPI.getAppState(),
        files: excalidrawAPI.getFiles(),
        mimeType: 'image/png',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const tab = tabs.find(t => t.id === selectedTabId);
      a.href = url; a.download = `${tab?.title || 'canvas'}.png`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('[alcove] Export PNG failed:', e);
    }
  };

  useKeyboardShortcuts({
    onNewPad: () => { if (isAuthenticated) setDocTemplateOpen(true); },
    onSearch: () => { if (isAuthenticated) setSearchOpen(true); },
    onDashboard: () => { if (isAuthenticated) setDashboardOpen(v => !v); },
    onToggleGrid: handleToggleGrid,
    onCommandPalette: () => { if (isAuthenticated) setCommandPaletteOpen(v => !v); },
    onDailyNote: () => { if (isAuthenticated) createDailyNote(); },
    onGraph: () => { if (isAuthenticated) setGraphOpen(v => !v); },
    onToggleSidebar: () => setSidebarCollapsed(v => !v),
    onFocusMode: () => { if (isDocumentMode) setFocusMode(v => !v); },
    onQuickCapture: () => { if (isAuthenticated) setQuickCaptureOpen(true); },
    onShortcuts: () => setShortcutOpen(v => !v),
    onHome: () => { if (isAuthenticated) setHomeOpen(v => !v); },
    onUnifiedAdd: () => { if (isAuthenticated) setUnifiedAddOpen(v => !v); },
    onChat: () => { if (isAuthenticated) setChatViewOpen(v => !v); },
  });

  // Escape exits focus mode
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && focusMode) setFocusMode(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [focusMode]);

  const handleOnScrollChange = () => {
    lockEmbeddables(excalidrawAPI?.getAppState());
  };

  useEffect(() => {
    if (!config?.devMode && config?.posthogKey && config?.posthogHost) {
      initializePostHog({ posthogKey: config.posthogKey, posthogHost: config.posthogHost });
    } else if (configError) {
      console.error('[alcove] Failed to load app config:', configError);
    }
  }, [config, configError]);

  const sidebarWidth = sidebarCollapsed ? 40 : 240;

  return (
    <>
      {/* ── Sidebar — position:fixed, floats above canvas at z-index 100 ── */}
      <PadSidebar
        tabs={tabs}
        selectedTabId={selectedTabId ?? ''}
        isAuthenticated={isAuthenticated}
        isCreatingPad={isCreatingPad}
        currentUserId={user?.id}
        onSelectPad={selectTab}
        onNewNote={() => { setDocTemplateOpen(true); return Promise.resolve(null); }}
        onNewCanvas={createNewPadAsync}
        onNewKanban={() => createNewKanban()}
        onNewGantt={() => createNewGantt()}
        onNewDatabase={() => createNewDatabase()}
        onDailyNote={createDailyNote}
        onGraph={() => setGraphOpen(v => !v)}
        onTemplates={() => setDashboardOpen(true)}
        onRename={renamePad}
        onDelete={deletePad}
        onLeaveSharedPad={leaveSharedPad}
        onUpdateSharingPolicy={updateSharingPolicy}
        onUpdateTheme={updateTheme}
        onUpdateTags={updateTags}
        onUpdateFolder={updateFolder}
        collapsed={sidebarCollapsed || focusMode}
        onToggleCollapse={() => setSidebarCollapsed(v => !v)}
        onTogglePomodoro={() => setPomodoroOpen(v => !v)}
        pomodoroActive={pomodoroOpen}
        onToggleSplit={!isDocumentMode ? () => setSplitOpen(v => !v) : undefined}
        splitActive={splitOpen}
        onToggleAI={() => setAiOpen(v => !v)}
        aiActive={aiOpen}
        onHome={() => setHomeOpen(v => !v)}
        homeActive={homeOpen}
        onTheme={() => setThemePickerOpen(v => !v)}
        onShortcuts={() => setShortcutOpen(v => !v)}
        currentThemeId={currentThemeId}
        user={user}
        onQuickCapture={() => setQuickCaptureOpen(true)}
        onImportObsidian={() => setObsidianImportOpen(true)}
        onAddFromLink={() => setAddLinkOpen(true)}
        onSmartResearch={() => setSmartResearchOpen(true)}
        onFlashcardStudio={() => setFlashcardStudioOpen(true)}
        onNewLatex={() => createNewLatex()}
      />

      {/* ── Canvas — position:fixed inset:0, always full viewport so Excalidraw pointer math is correct ── */}
      <div
        className="app-canvas-wrap"
        style={{ display: isStructuredMode ? 'none' : undefined }}
      >
        <Excalidraw
          excalidrawAPI={excalidrawRefCallback}
          initialData={INITIAL_APP_DATA}
          langCode={excalidrawLang}
          UIOptions={{ hiddenElements: HIDDEN_UI_ELEMENTS }}
          onScrollChange={handleOnScrollChange}
          validateEmbeddable={true}
          renderEmbeddable={(element: NonDeleted<ExcalidrawEmbeddableElement>, appState: AppState) =>
            renderCustomEmbeddable(element, appState, excalidrawAPI)
          }
          renderTopRightUI={() => (
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => excalidrawAPI?.scrollToContent(excalidrawAPI.getSceneElements(), { fitToViewport: true })}
                title={t('canvas.fitToContent')}
                style={{
                  background: 'var(--color-surface-mid, rgba(30,30,46,0.9))',
                  border: '1px solid var(--color-surface-high, rgba(255,255,255,0.1))',
                  borderRadius: 8, color: 'var(--color-text-muted, #7f849c)',
                  cursor: 'pointer', fontSize: 13, padding: '5px 9px',
                }}
              >
                ⊡
              </button>
              <button
                onClick={() => setPresentationMode(true)}
                title="Mode présentation"
                style={{
                  background: 'var(--color-surface-mid, rgba(30,30,46,0.9))',
                  border: '1px solid var(--color-surface-high, rgba(255,255,255,0.1))',
                  borderRadius: 8, color: 'var(--color-text-muted, #7f849c)',
                  cursor: 'pointer', fontSize: 12, padding: '5px 10px',
                }}
              >
                ▶
              </button>
              <button
                onClick={exportCanvasPng}
                title={t('canvas.exportPng')}
                style={{
                  background: 'var(--color-surface-mid, rgba(30,30,46,0.9))',
                  border: '1px solid var(--color-surface-high, rgba(255,255,255,0.1))',
                  borderRadius: 8, color: 'var(--color-text-muted, #7f849c)',
                  cursor: 'pointer', fontSize: 12, padding: '5px 10px',
                }}
              >
                PNG ↓
              </button>
            </div>
          )}
        >
          <MainMenuConfig
            MainMenu={MainMenu}
            excalidrawAPI={excalidrawAPI}
            onOpenDashboard={() => setDashboardOpen(true)}
            onNewDocument={() => createNewDocumentAsync()}
            onCommandPalette={() => setCommandPaletteOpen(true)}
            onDailyNote={() => createDailyNote()}
            onGraph={() => setGraphOpen(true)}
            onChat={() => setChatViewOpen(true)}
          />

          {!isLoadingAuth && !isAuthenticated && <AuthDialog />}

          {excalidrawAPI && user && (
            <Collab
              excalidrawAPI={excalidrawAPI}
              user={user}
              isOnline={!!isAuthenticated}
              isLoadingAuth={isLoadingAuth}
              padId={selectedTabId}
            />
          )}
        </Excalidraw>
      </div>

      {/* ── Document pad — slides right of sidebar ── */}
      {isDocumentMode && (
        <div className="app-doc-wrap" style={{ left: focusMode ? 0 : sidebarWidth }}>
          <Suspense fallback={<PadLoading />}>
            <DocumentPad
              padId={selectedTabId}
              theme={selectedTab?.theme}
              globalThemeDark={getTheme(currentThemeId).dark}
              tabs={tabs}
              onSelectPad={selectTab}
              focusMode={focusMode}
              onToggleFocus={() => setFocusMode(v => !v)}
              pendingContent={pendingDocContent}
              onContentLoaded={() => setPendingDocContent(null)}
              onContentChange={setAiDocContent}
              contentToAppend={aiContentToInsert}
              onContentAppended={() => setAiContentToInsert(null)}
            />
          </Suspense>
        </div>
      )}

      {/* ── Kanban pad ── */}
      {isKanbanMode && selectedTabId && (
        <div className="app-doc-wrap" style={{ left: sidebarWidth }}>
          {kanbanData
            ? <Suspense fallback={<PadLoading />}><KanbanPad padId={selectedTabId} data={kanbanData} onDataChange={setKanbanData} /></Suspense>
            : <PadLoading />
          }
        </div>
      )}

      {/* ── Gantt pad ── */}
      {isGanttMode && selectedTabId && (
        <div className="app-doc-wrap" style={{ left: sidebarWidth }}>
          {ganttData
            ? <Suspense fallback={<PadLoading />}><GanttPad padId={selectedTabId} data={ganttData} onDataChange={setGanttData} /></Suspense>
            : <PadLoading />
          }
        </div>
      )}

      {/* ── Database pad (Table + Board views) ── */}
      {isDatabaseMode && selectedTabId && (
        <div className="app-doc-wrap" style={{ left: sidebarWidth }}>
          {databaseData
            ? <Suspense fallback={<PadLoading />}><DatabasePad padId={selectedTabId} data={databaseData} onDataChange={setDatabaseData} /></Suspense>
            : <PadLoading />
          }
        </div>
      )}

      {/* ── LaTeX pad (rendered as DocumentPad with latex format) ── */}
      {isLatexMode && selectedTabId && (
        <div className="app-doc-wrap" style={{ left: sidebarWidth }}>
          <Suspense fallback={<PadLoading />}>
            <DocumentPad
              padId={selectedTabId}
              format="latex"
              theme={selectedTab?.theme}
              globalThemeDark={activeTheme.dark}
            />
          </Suspense>
        </div>
      )}

      {/* ── Ruler — floats over canvas, below sidebar ── */}
      {excalidrawAPI && !isStructuredMode && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10, pointerEvents: 'none' }}>
          <div style={{ pointerEvents: 'auto' }}>
            <RulerPanel excalidrawAPI={excalidrawAPI} />
          </div>
        </div>
      )}

      {/* ── Presentation mode overlay ── */}
      {presentationMode && excalidrawAPI && (
        <PresentationMode
          excalidrawAPI={excalidrawAPI}
          onClose={() => setPresentationMode(false)}
        />
      )}

      {/* ── Canvas PNG export button ── */}

      {/* ── Pomodoro timer ── */}
      {pomodoroOpen && <PomodoroTimer onClose={() => setPomodoroOpen(false)} />}

      {/* ── Split doc panel (canvas + doc side by side) ── */}
      {splitOpen && !isDocumentMode && splitPanelDocId && (
        <Suspense fallback={<PadLoading />}>
          <SplitDocPanel
            tabs={tabs}
            docTabId={splitPanelDocId}
            onChangeDoc={setSplitDocId}
            onClose={() => setSplitOpen(false)}
          />
        </Suspense>
      )}

      {/* ── AI Panel ── */}
      {aiOpen && (
        <AIPanel
          onClose={() => setAiOpen(false)}
          padId={selectedTabId ?? undefined}
          docContext={isDocumentMode ? aiDocContent : undefined}
          padTitle={selectedTab?.title}
          padTitles={tabs.map(t => t.title)}
          onSuggestTags={isDocumentMode && selectedTabId
            ? (tags) => updateTags({ padId: selectedTabId, tags })
            : undefined
          }
          onInsertContent={isDocumentMode ? (content) => setAiContentToInsert(content) : undefined}
        />
      )}

      {/* ── Document template picker ── */}
      {docTemplateOpen && (
        <DocumentTemplateDialog
          onSelect={handleNewNoteFromTemplate}
          onSelectUser={(tpl) => {
            setDocTemplateOpen(false);
            setPendingDocContent(tpl.content);
            createNewDocumentAsync().then(tab => {
              if (!tab) return;
              fetch(`/api/pad/${tab.id}/doc`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: tpl.content, format: 'markdown' }),
              }).catch(console.error);
            });
          }}
          onClose={() => setDocTemplateOpen(false)}
        />
      )}

      {/* ── Global overlays ── */}
      {searchOpen && (
        <SearchDialog
          onClose={() => setSearchOpen(false)}
          onSelectPad={(padId) => { selectTab(padId); setSearchOpen(false); }}
        />
      )}

      {dashboardOpen && isAuthenticated && (
        <Dashboard
          tabs={tabs}
          selectedTabId={selectedTabId ?? ''}
          onSelectPad={(padId) => { selectTab(padId); setDashboardOpen(false); }}
          onUnifiedAdd={() => setUnifiedAddOpen(true)}
          onCreateFromTemplate={handleCreateFromTemplate}
          onClose={() => setDashboardOpen(false)}
        />
      )}

      {unifiedAddOpen && isAuthenticated && (
        <UnifiedAddModal
          onClose={() => setUnifiedAddOpen(false)}
          onIngest={() => { setUnifiedAddOpen(false); setAddLinkOpen(true); }}
          onImportObsidian={() => { setUnifiedAddOpen(false); setObsidianImportOpen(true); }}
          onQuickCapture={() => { setUnifiedAddOpen(false); setQuickCaptureOpen(true); }}
          onCreateCanvas={() => { setUnifiedAddOpen(false); setDashboardOpen(false); createNewPadAsync(); }}
          onCreateDocument={() => { setUnifiedAddOpen(false); setDashboardOpen(false); createNewDocumentAsync(); }}
          onCreateKanban={() => { setUnifiedAddOpen(false); setDashboardOpen(false); createNewKanban(); }}
          onCreateGantt={() => { setUnifiedAddOpen(false); setDashboardOpen(false); createNewGantt(); }}
          onCreateLatex={() => { setUnifiedAddOpen(false); setDashboardOpen(false); createNewLatex(); }}
          onCreateDatabase={() => { setUnifiedAddOpen(false); setDashboardOpen(false); createNewDatabase(); }}
          onCreateDaily={() => { setUnifiedAddOpen(false); setDashboardOpen(false); createDailyNote(); }}
        />
      )}

      {commandPaletteOpen && isAuthenticated && (
        <CommandPalette
          tabs={tabs}
          onSelectPad={selectTab}
          onClose={() => setCommandPaletteOpen(false)}
          onNewCanvas={() => createNewPadAsync()}
          onNewDocument={() => createNewDocumentAsync()}
          onNewKanban={() => createNewKanban()}
          onNewGantt={() => createNewGantt()}
          onNewDatabase={() => createNewDatabase()}
          onDailyNote={() => createDailyNote()}
          onGraph={() => setGraphOpen(true)}
          onDashboard={() => setDashboardOpen(true)}
          onSearch={() => setSearchOpen(true)}
          onToggleGrid={handleToggleGrid}
          onQuickCapture={() => { setCommandPaletteOpen(false); setQuickCaptureOpen(true); }}
          onImportObsidian={() => { setCommandPaletteOpen(false); setObsidianImportOpen(true); }}
          onAddFromLink={() => { setCommandPaletteOpen(false); setAddLinkOpen(true); }}
          onSmartResearch={() => { setCommandPaletteOpen(false); setSmartResearchOpen(true); }}
          onFlashcardStudio={() => { setCommandPaletteOpen(false); setFlashcardStudioOpen(true); }}
          onOpenGuide={() => { setCommandPaletteOpen(false); seedWelcomeGuide({ open: true }); }}
        />
      )}

      {/* ── Home Hub ── */}
      {homeOpen && isAuthenticated && (
        <HomeHub
          tabs={tabs}
          user={user ? { name: user.name, email: user.email } : undefined}
          onSelectPad={(id) => { selectTab(id); setHomeOpen(false); }}
          onNewCanvas={() => { createNewPadAsync(); setHomeOpen(false); }}
          onNewDocument={() => { createNewDocumentAsync(); setHomeOpen(false); }}
          onNewKanban={() => { createNewKanban(); setHomeOpen(false); }}
          onNewGantt={() => { createNewGantt(); setHomeOpen(false); }}
          onDailyNote={() => { createDailyNote(); setHomeOpen(false); }}
          onQuickCapture={() => { setHomeOpen(false); setQuickCaptureOpen(true); }}
          onImportObsidian={() => { setHomeOpen(false); setObsidianImportOpen(true); }}
          onClose={() => setHomeOpen(false)}
        />
      )}

      {/* ── Onboarding (first launch) ── */}
      {onboardingOpen && (
        <Onboarding
          onDone={() => setOnboardingOpen(false)}
          onCreatePad={(type) => {
            if (type === 'canvas') createNewPadAsync();
            else if (type === 'document') createNewDocumentAsync();
            else if (type === 'kanban') createNewKanban();
            else if (type === 'gantt') createNewGantt();
          }}
          onSeedWelcome={seedWelcomeGuide}
        />
      )}

      {/* ── Theme picker ── */}
      {themePickerOpen && (
        <ThemePicker
          currentThemeId={currentThemeId}
          onSelect={(theme: Theme) => { setCurrentThemeId(theme.id); setThemePickerOpen(false); }}
          onClose={() => setThemePickerOpen(false)}
          onOpenBuilder={() => { setThemePickerOpen(false); setThemeBuilderOpen(true); }}
        />
      )}

      {/* ── Theme builder (custom presets) ── */}
      {themeBuilderOpen && (
        <ThemeBuilder
          initialThemeId={currentThemeId}
          onClose={() => setThemeBuilderOpen(false)}
          onApply={(theme: Theme) => setCurrentThemeId(theme.id)}
          onSaved={(theme: Theme) => { setCurrentThemeId(theme.id); setThemeBuilderOpen(false); }}
        />
      )}

      {/* ── Shortcut overlay ── */}
      {shortcutOpen && (
        <ShortcutOverlay onClose={() => setShortcutOpen(false)} />
      )}

      {/* ── Flashcard Studio ── */}
      {flashcardStudioOpen && (
        <FlashcardStudio
          tabs={tabs}
          onClose={() => setFlashcardStudioOpen(false)}
          onSelectPad={selectTab}
        />
      )}

      {/* ── Quick capture modal ── */}
      {quickCaptureOpen && (
        <QuickCapture
          scratchPadId={tabs.find(t => t.isScratch)?.id ?? null}
          onClose={() => setQuickCaptureOpen(false)}
        />
      )}

      {/* ── Obsidian import dialog ── */}
      {obsidianImportOpen && (
        <ObsidianImport
          onClose={() => setObsidianImportOpen(false)}
          onImported={(ids) => {
            refetchTabs();
            if (ids.length) selectTab(ids[0]);
          }}
        />
      )}

      {/* ── Add from link (web / PDF / YouTube ingestion) ── */}
      {addLinkOpen && (
        <AddFromLink
          tabs={tabs}
          onClose={() => setAddLinkOpen(false)}
          onCreated={(id) => { refetchTabs(); selectTab(id); }}
        />
      )}

      {/* ── Smart Research (web search → cited note) ── */}
      {smartResearchOpen && (
        <SmartResearch
          onClose={() => setSmartResearchOpen(false)}
          onCreated={(id) => { refetchTabs(); selectTab(id); }}
        />
      )}

      {graphOpen && isAuthenticated && (
        <GraphView
          onClose={() => setGraphOpen(false)}
          onSelectPad={(id) => { selectTab(id); setGraphOpen(false); }}
        />
      )}

      {chatViewOpen && isAuthenticated && (
        <Suspense fallback={<PadLoading />}>
          <ChatView onClose={() => setChatViewOpen(false)} />
        </Suspense>
      )}

      {isOffline && (
        <div style={{
          position: 'fixed',
          bottom: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 1000,
          background: '#f38ba8',
          color: '#1e1e2e',
          padding: '6px 18px',
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 700,
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          pointerEvents: 'none',
        }}>
          {t('offline')}
        </div>
      )}
    </>
  );
}
