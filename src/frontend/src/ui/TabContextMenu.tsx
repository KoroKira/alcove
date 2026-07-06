import React, { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import clsx from 'clsx';

import './TabContextMenu.scss';

const CONTEXT_MENU_SEPARATOR = "separator";

type ContextMenuItem = typeof CONTEXT_MENU_SEPARATOR | Action;
type ContextMenuItems = (ContextMenuItem | false | null | undefined)[];

interface Action {
  name: string;
  label: string | (() => string);
  predicate?: () => boolean;
  checked?: (appState: any) => boolean;
  dangerous?: boolean;
}

interface ContextMenuProps {
  actionManager: ActionManager;
  items: ContextMenuItems;
  top: number;
  left: number;
  onClose: (callback?: () => void) => void;
}

interface ActionManager {
  executeAction: (action: Action, source: string) => void;
  app: {
    props: any;
  };
}

interface TabContextMenuProps {
  x: number;
  y: number;
  padId: string;
  padName: string;
  onRename: (padId: string, newName: string) => void;
  onDelete: (padId: string) => void;
  onUpdateSharingPolicy: (padId: string, policy: string) => void;
  onUpdateTheme: (padId: string) => void;
  onUpdateTags?: (padId: string, tags: string[]) => void;
  onMoveToFolder?: (padId: string) => void;
  currentFolder?: string;
  onClose: () => void;
  currentUserId?: string;
  tabOwnerId?: string;
  sharingPolicy?: string;
  currentTheme?: string;
  currentTags?: string[];
  onLeaveSharedPad: (padId: string) => void;
  onToggleReadLater?: (padId: string, newTags: string[]) => void;
}

// Popover component
const Popover: React.FC<{
  onCloseRequest: () => void;
  top: number;
  left: number;
  fitInViewport?: boolean;
  offsetLeft?: number;
  offsetTop?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  children: React.ReactNode;
}> = ({
  onCloseRequest,
  top,
  left,
  children,
  fitInViewport = false,
  offsetLeft = 0,
  offsetTop = 0,
  viewportWidth = window.innerWidth,
  viewportHeight = window.innerHeight
}) => {
    const popoverRef = useRef<HTMLDivElement>(null);

    // Handle clicks outside the popover to close it
    useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
        if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
          onCloseRequest();
        }
      };

      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }, [onCloseRequest]);

    // Adjust position if needed to fit in viewport
    useEffect(() => {
      if (fitInViewport && popoverRef.current) {
        const rect = popoverRef.current.getBoundingClientRect();
        const adjustedLeft = Math.min(left, viewportWidth - rect.width);
        const adjustedTop = Math.min(top, viewportHeight - rect.height);

        if (popoverRef.current) {
          popoverRef.current.style.left = `${adjustedLeft}px`;
          popoverRef.current.style.top = `${adjustedTop}px`;
        }
      }
    }, [fitInViewport, left, top, viewportWidth, viewportHeight]);

    return (
      <div
        ref={popoverRef}
        style={{
          position: 'fixed',
          top: `${top}px`,
          left: `${left}px`,
          zIndex: 1000,
        }}
      >
        {children}
      </div>
    );
  };

// ContextMenu component
const ContextMenu: React.FC<ContextMenuProps> = ({
  actionManager,
  items,
  top,
  left,
  onClose
}) => {
  // Filter items based on predicate
  const filteredItems = items.reduce((acc: ContextMenuItem[], item) => {
    if (
      item &&
      (item === CONTEXT_MENU_SEPARATOR ||
        !item.predicate ||
        item.predicate())
    ) {
      acc.push(item);
    }
    return acc;
  }, []);

  return (
    <Popover
      onCloseRequest={() => {
        onClose();
      }}
      top={top}
      left={left}
      fitInViewport={true}
      viewportWidth={window.innerWidth}
      viewportHeight={window.innerHeight}
    >
      <ul
        className="context-menu"
        onContextMenu={(event) => event.preventDefault()}
      >
        {filteredItems.map((item, idx) => {
          if (item === CONTEXT_MENU_SEPARATOR) {
            if (
              !filteredItems[idx - 1] ||
              filteredItems[idx - 1] === CONTEXT_MENU_SEPARATOR
            ) {
              return null;
            }
            return <hr key={idx} className="context-menu-item-separator" />;
          }

          const actionName = item.name;
          let label = "";
          if (item.label) {
            if (typeof item.label === "function") {
              label = item.label();
            } else {
              label = item.label;
            }
          }

          return (
            <li
              key={idx}
              data-testid={actionName}
              onClick={() => {
                // Store the callback to execute after closing
                const callback = () => {
                  actionManager.executeAction(item, "contextMenu");
                };

                // Close the menu and execute the callback
                onClose(callback);
              }}
            >
              <button
                type="button"
                className={clsx("context-menu-item", {
                  dangerous: item.dangerous || actionName === "deleteSelectedElements",
                  checkmark: item.checked && item.checked({}),
                })}
              >
                <div className="context-menu-item__label">{label}</div>
                <kbd className="context-menu-item__shortcut"></kbd>
              </button>
            </li>
          );
        })}
      </ul>
    </Popover>
  );
};

// Simple ActionManager implementation for the tab context menu
class TabActionManager implements ActionManager {
  padId: string;
  padName: string;
  onRename: (padId: string, newName: string) => void;
  onDelete: (padId: string) => void;
  onUpdateSharingPolicy: (padId: string, policy: string) => void;
  onUpdateTheme: (padId: string) => void;
  onUpdateTags?: (padId: string, tags: string[]) => void;
  onToggleReadLater?: (padId: string, newTags: string[]) => void;
  onMoveToFolder?: (padId: string) => void;
  currentTags?: string[];
  app: any;
  sharingPolicy?: string;
  onLeaveSharedPad: (padId: string) => void;

  constructor(
    padId: string,
    padName: string,
    onRename: (padId: string, newName: string) => void,
    onDelete: (padId: string) => void,
    onUpdateSharingPolicy: (padId: string, policy: string) => void,
    onLeaveSharedPad: (padId: string) => void,
    onUpdateTheme: (padId: string) => void,
    sharingPolicy?: string,
    onUpdateTags?: (padId: string, tags: string[]) => void,
    currentTags?: string[],
    onToggleReadLater?: (padId: string, newTags: string[]) => void,
  ) {
    this.padId = padId;
    this.padName = padName;
    this.onRename = onRename;
    this.onDelete = onDelete;
    this.onUpdateSharingPolicy = onUpdateSharingPolicy;
    this.onUpdateTheme = onUpdateTheme;
    this.onLeaveSharedPad = onLeaveSharedPad;
    this.sharingPolicy = sharingPolicy;
    this.onUpdateTags = onUpdateTags;
    this.currentTags = currentTags;
    this.onToggleReadLater = onToggleReadLater;
    this.app = { props: {} };
  }

  executeAction(action: Action, source: string) {
    if (action.name === 'rename') {
      const newName = window.prompt(i18n.t('contextMenu.renamePrompt'), this.padName);
      if (newName && newName.trim() !== '') {
        this.onRename(this.padId, newName);
      }
    } else if (action.name === 'aiRename') {
      this.aiRename();
    } else if (action.name === 'deleteOwnedPad') {
      console.debug('[alcove] Attempting to delete owned pad:', this.padId, this.padName);
      if (window.confirm(`Are you sure you want to delete "${this.padName}"?`)) {
        console.debug('[alcove] User confirmed delete, calling onDelete');
        this.onDelete(this.padId);
      }
    } else if (action.name === 'leaveSharedPad') {
      console.debug('[alcove] Attempting to leave shared pad:', this.padId, this.padName);
      if (window.confirm(`Are you sure you want to leave "${this.padName}"? This will remove it from your list of open pads.`)) {
        this.onLeaveSharedPad(this.padId);
      }
    } else if (action.name === 'toggleSharingPolicy') {
      const newPolicy = this.sharingPolicy === 'public' ? 'private' : 'public';
      this.onUpdateSharingPolicy(this.padId, newPolicy);
    } else if (action.name === 'toggleTheme') {
      this.onUpdateTheme(this.padId);
    } else if (action.name === 'editTags') {
      const current = (this.currentTags || []).join(', ');
      const input = window.prompt(i18n.t('contextMenu.tagsPrompt'), current);
      if (input !== null && this.onUpdateTags) {
        const tags = input.split(',').map(t => t.trim()).filter(Boolean);
        this.onUpdateTags(this.padId, tags);
      }
    } else if (action.name === 'moveToFolder') {
      this.onMoveToFolder?.(this.padId);
    } else if (action.name === 'copyUrl') {
      const url = `${window.location.origin}/pad/${this.padId}`;
      navigator.clipboard.writeText(url).then(() => {
        console.debug('[alcove] URL copied to clipboard:', url);
      }).catch(err => {
        console.error('[alcove] Failed to copy URL:', err);
      });
    } else if (action.name === 'toggleReadLater') {
      const tags = [...(this.currentTags || [])];
      const idx = tags.indexOf('read-later');
      if (idx >= 0) tags.splice(idx, 1);
      else tags.push('read-later');
      this.onToggleReadLater?.(this.padId, tags);
    }
  }

  /** Fetch the pad's text and ask Ollama for a title, then rename. */
  private async aiRename() {
    try {
      const resp = await fetch(`/api/pad/${this.padId}`);
      if (!resp.ok) throw new Error(`fetch pad ${resp.status}`);
      const pad = await resp.json();
      const data = pad.data ?? {};
      const content: string = typeof data.content === 'string'
        ? data.content
        : (data.elements ?? [])
            .map((el: any) => (typeof el.text === 'string' ? el.text : ''))
            .filter(Boolean)
            .join('\n');
      if (!content.trim()) {
        window.alert(i18n.t('contextMenu.aiRenameEmpty'));
        return;
      }
      const model = localStorage.getItem('pad-ws-ai-model') ?? undefined;
      const lang = i18n.language.startsWith('fr') ? 'fr' : 'en';
      const titleResp = await fetch('/api/ai/title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, model, lang }),
      });
      const { title, error } = await titleResp.json();
      if (title) this.onRename(this.padId, title);
      else window.alert(error || i18n.t('contextMenu.aiRenameFailed'));
    } catch (e) {
      window.alert(i18n.t('contextMenu.aiRenameFailed'));
    }
  }
}

// Main TabContextMenu component
const TabContextMenu: React.FC<TabContextMenuProps> = ({
  x,
  y,
  padId,
  padName,
  onRename,
  onDelete,
  onUpdateSharingPolicy,
  onUpdateTheme,
  onUpdateTags,
  onMoveToFolder,
  currentFolder,
  onClose,
  currentUserId,
  tabOwnerId,
  sharingPolicy,
  currentTheme,
  currentTags,
  onLeaveSharedPad,
  onToggleReadLater,
}) => {
  const { t } = useTranslation();
  const isOwner = currentUserId && tabOwnerId && currentUserId === tabOwnerId;
  const isPadPublic = sharingPolicy === 'public';
  const isReadLater = (currentTags || []).includes('read-later');

  const actionManager = new TabActionManager(padId, padName, onRename, onDelete, onUpdateSharingPolicy, onLeaveSharedPad, onUpdateTheme, sharingPolicy, onUpdateTags, currentTags, onToggleReadLater);
  actionManager.onMoveToFolder = onMoveToFolder;

  // Define menu items
  const menuItemsResult: ContextMenuItems = [];

  if (isOwner) {
    menuItemsResult.push({
      name: 'rename',
      label: t('contextMenu.rename'),
    });
    menuItemsResult.push({
      name: 'aiRename',
      label: t('contextMenu.aiRename'),
    });
  }

  menuItemsResult.push({
    name: 'copyUrl',
    label: t('contextMenu.copyUrl'),
  });

  if (onToggleReadLater) {
    menuItemsResult.push({
      name: 'toggleReadLater',
      label: isReadLater ? t('contextMenu.removeFromReading') : t('contextMenu.addToReading'),
    });
  }
  
  if (isOwner) {
    // Add separator if rename was added, before toggle policy
    const renameItemIndex = menuItemsResult.findIndex(item => item && typeof item !== 'string' && item.name === 'rename');
    const copyUrlItemIndex = menuItemsResult.findIndex(item => item && typeof item !== 'string' && item.name === 'copyUrl');

    if (renameItemIndex !== -1 && copyUrlItemIndex !== -1 && copyUrlItemIndex > renameItemIndex) {
       menuItemsResult.splice(copyUrlItemIndex, 0, CONTEXT_MENU_SEPARATOR);
    } else if (renameItemIndex !== -1 && copyUrlItemIndex === -1) {
      // If copyUrl is not there for some reason, but rename is, add separator after rename
      menuItemsResult.push(CONTEXT_MENU_SEPARATOR);
    }

    menuItemsResult.push({
      name: 'toggleSharingPolicy',
      label: isPadPublic ? t('contextMenu.setPrivate') : t('contextMenu.setPublic'),
    });
    menuItemsResult.push({
      // Cycle: follow app theme (currentTheme undefined) → forced dark → forced light → follow app theme
      name: 'toggleTheme',
      label: currentTheme === undefined
        ? t('contextMenu.switchDark')
        : currentTheme === 'dark'
          ? t('contextMenu.switchLight')
          : t('contextMenu.switchAuto'),
    });
    menuItemsResult.push({
      name: 'editTags',
      label: (currentTags && currentTags.length > 0)
        ? t('contextMenu.hasTags', { tags: currentTags.map(tag => '#' + tag).join(' ') })
        : t('contextMenu.addTags'),
    });
    if (onMoveToFolder) {
      menuItemsResult.push({
        name: 'moveToFolder',
        label: currentFolder
          ? t('contextMenu.inFolder', { folder: currentFolder })
          : t('contextMenu.moveToFolder'),
      });
    }
  }

  // Separator before delete/leave
  if (menuItemsResult.length > 0 && menuItemsResult[menuItemsResult.length -1] !== CONTEXT_MENU_SEPARATOR) {
      menuItemsResult.push(CONTEXT_MENU_SEPARATOR);
  }

  menuItemsResult.push({
    name: !isOwner ? 'leaveSharedPad' : 'deleteOwnedPad', // Dynamically set action name
    label: !isOwner ? t('contextMenu.leave') : t('contextMenu.delete'),
    dangerous: true,
  });
  
  const menuItems = menuItemsResult.filter(Boolean) as ContextMenuItems;


  // Create a wrapper for onClose that handles the callback
  const handleClose = (callback?: () => void) => {
    onClose();
    if (callback) {
      callback();
    }
  };

  return (
    <ContextMenu
      actionManager={actionManager}
      items={menuItems}
      top={y - 80} // Position above the cursor
      left={x}
      onClose={handleClose}
    />
  );
};

export default TabContextMenu;
