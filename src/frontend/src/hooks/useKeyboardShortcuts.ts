import { useEffect } from 'react';

type ShortcutHandlers = {
  onNewPad?: () => void;
  onSearch?: () => void;
  onToggleGrid?: () => void;
  onDashboard?: () => void;
  onCommandPalette?: () => void;
  onDailyNote?: () => void;
  onGraph?: () => void;
  onToggleSidebar?: () => void;
  onFocusMode?: () => void;
  onQuickCapture?: () => void;
  onShortcuts?: () => void;
  onHome?: () => void;
  onUnifiedAdd?: () => void;
  onChat?: () => void;
};

const isTyping = () => {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable;
};

export const useKeyboardShortcuts = (handlers: ShortcutHandlers) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key === 'n' && !e.shiftKey) {
        if (isTyping()) return;
        e.preventDefault();
        handlers.onNewPad?.();
        return;
      }

      if (mod && e.key === 'k') {
        e.preventDefault();
        handlers.onSearch?.();
        return;
      }

      if (mod && e.key === 'g') {
        e.preventDefault();
        handlers.onToggleGrid?.();
        return;
      }

      if (mod && e.key === 'd') {
        e.preventDefault();
        handlers.onDashboard?.();
        return;
      }

      if (mod && e.key === 'p') {
        e.preventDefault();
        handlers.onCommandPalette?.();
        return;
      }

      if (mod && e.key === 't') {
        e.preventDefault();
        handlers.onDailyNote?.();
        return;
      }

      if (mod && e.shiftKey && e.key === 'G') {
        e.preventDefault();
        handlers.onGraph?.();
        return;
      }

      if (mod && e.key === '\\') {
        e.preventDefault();
        handlers.onToggleSidebar?.();
        return;
      }

      if (mod && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        handlers.onFocusMode?.();
        return;
      }

      if (mod && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        handlers.onQuickCapture?.();
        return;
      }

      if (mod && e.key === '/') {
        e.preventDefault();
        handlers.onShortcuts?.();
        return;
      }

      if (mod && e.shiftKey && e.key === 'H') {
        e.preventDefault();
        handlers.onHome?.();
        return;
      }

      // Cmd+Shift+A / Ctrl+Shift+A → modale unifiée d'ajout (ingérer + créer)
      // Accessible depuis n'importe où — pad, canvas, dashboard.
      if (mod && e.shiftKey && e.key === 'A') {
        e.preventDefault();
        handlers.onUnifiedAdd?.();
        return;
      }

      // Cmd+Shift+C / Ctrl+Shift+C → full-page AI Chat view
      if (mod && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        handlers.onChat?.();
        return;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handlers]);
};
