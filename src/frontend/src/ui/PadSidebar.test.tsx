import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PadSidebar from './PadSidebar';
import { SharingPolicy, type Tab } from '../hooks/usePadTabs';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'fr' } }),
  Trans: ({ children }: { children?: unknown }) => children,
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

// Smoke coverage: the sidebar is 700+ LOC of layout + interactions, and its
// primary jobs are (a) not crash when handed a plausible props shape, (b) list
// the user's pads, (c) route select/new/home clicks to the right handlers.
// These tests catch regressions in that surface without pinning the visual
// layout — hover-only actions are exercised in TabContextMenu tests instead.

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'pad-1',
    title: 'Ma note',
    ownerId: 'user-1',
    sharingPolicy: SharingPolicy.PRIVATE,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    padType: 'document',
    ...overrides,
  };
}

function baseProps(overrides: Partial<React.ComponentProps<typeof PadSidebar>> = {}) {
  return {
    tabs: [] as Tab[],
    selectedTabId: '',
    isAuthenticated: true,
    isCreatingPad: false,
    currentUserId: 'user-1',
    onSelectPad: vi.fn(),
    onNewNote: vi.fn(async () => null),
    onNewCanvas: vi.fn(async () => null),
    onDailyNote: vi.fn(),
    onGraph: vi.fn(),
    onTemplates: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onLeaveSharedPad: vi.fn(),
    onUpdateSharingPolicy: vi.fn(),
    onUpdateTheme: vi.fn(),
    collapsed: false,
    onToggleCollapse: vi.fn(),
    ...overrides,
  };
}

describe('PadSidebar', () => {
  it('renders without crashing with an empty tab list', () => {
    render(<PadSidebar {...baseProps()} />);
    // Sidebar chrome present — the "new note" button always exists.
    // No specific tab entries rendered.
    expect(document.querySelector('.pad-sidebar')).toBeInTheDocument();
  });

  it('renders each tab and calls onSelectPad on click', async () => {
    const onSelectPad = vi.fn();
    render(<PadSidebar {...baseProps({
      tabs: [
        tab({ id: 'pad-1', title: 'Note A' }),
        tab({ id: 'pad-2', title: 'Note B' }),
      ],
      onSelectPad,
    })} />);

    expect(screen.getByText('Note A')).toBeInTheDocument();
    expect(screen.getByText('Note B')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByText('Note B'));
    expect(onSelectPad).toHaveBeenCalledWith('pad-2');
  });

  it('marks the selected tab', () => {
    render(<PadSidebar {...baseProps({
      tabs: [
        tab({ id: 'pad-1', title: 'Note A' }),
        tab({ id: 'pad-2', title: 'Note B' }),
      ],
      selectedTabId: 'pad-2',
    })} />);

    // The active item carries an --active modifier class.
    const activeItem = document.querySelector('.pad-sidebar__item--active');
    expect(activeItem).not.toBeNull();
    expect(activeItem!.textContent).toContain('Note B');
  });

  it('respects the collapsed prop', () => {
    render(<PadSidebar {...baseProps({ collapsed: true })} />);
    // Collapsed sidebar hides text labels — a scratch pad title wouldn't render
    // as visible text. The sidebar itself is still in the DOM.
    const sidebar = document.querySelector('.pad-sidebar');
    expect(sidebar?.className).toMatch(/collapsed/);
  });

  it('groups scratch pads first', () => {
    render(<PadSidebar {...baseProps({
      tabs: [
        tab({ id: 'pad-1', title: 'Regular note' }),
        tab({ id: 'pad-2', title: 'Scratch', isScratch: true }),
      ],
    })} />);
    // Grab all rendered item titles in DOM order.
    const items = Array.from(document.querySelectorAll('.pad-sidebar__item'))
      .map(el => el.textContent?.trim())
      .filter(Boolean);
    const scratchIdx = items.findIndex(t => t?.includes('Scratch'));
    const regularIdx = items.findIndex(t => t?.includes('Regular note'));
    expect(scratchIdx).toBeGreaterThanOrEqual(0);
    expect(regularIdx).toBeGreaterThanOrEqual(0);
    expect(scratchIdx).toBeLessThan(regularIdx);
  });

  it('moves a multi-selection into a folder through the inline form', async () => {
    const onUpdateFolder = vi.fn();
    render(<PadSidebar {...baseProps({
      tabs: [tab({ id: 'pad-1', title: 'Note A' }), tab({ id: 'pad-2', title: 'Note B' })],
      onUpdateFolder,
    })} />);

    fireEvent.click(screen.getByText('Note A'), { ctrlKey: true });
    fireEvent.click(screen.getByText('Note B'), { ctrlKey: true });
    await userEvent.setup().click(screen.getByRole('button', { name: 'sidebar.bulkFolder' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'sidebar.folderDestination' }), {
      target: { value: 'Projects/Launch' },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'sidebar.bulkApply' }));

    expect(onUpdateFolder).toHaveBeenNthCalledWith(1, { padId: 'pad-1', folder: 'Projects/Launch' });
    expect(onUpdateFolder).toHaveBeenNthCalledWith(2, { padId: 'pad-2', folder: 'Projects/Launch' });
    expect(screen.queryByRole('group', { name: 'sidebar.bulkFolder' })).not.toBeInTheDocument();
  });

  it('moves one pad from its context menu through the inline form', async () => {
    const onUpdateFolder = vi.fn();
    render(<PadSidebar {...baseProps({
      tabs: [tab({ id: 'pad-1', title: 'Note A' })],
      onUpdateFolder,
    })} />);

    fireEvent.contextMenu(screen.getByText('Note A'), { clientX: 40, clientY: 80 });
    await userEvent.setup().click(screen.getByRole('button', { name: 'contextMenu.moveToFolder' }));
    fireEvent.change(screen.getByLabelText('sidebar.folderDestination'), {
      target: { value: 'Projects' },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'sidebar.bulkApply' }));

    expect(onUpdateFolder).toHaveBeenCalledWith({ padId: 'pad-1', folder: 'Projects' });
  });

  it('adds comma-separated tags to every selected pad through the inline form', async () => {
    const onUpdateTags = vi.fn();
    render(<PadSidebar {...baseProps({
      tabs: [
        tab({ id: 'pad-1', title: 'Note A', tags: ['existing'] }),
        tab({ id: 'pad-2', title: 'Note B' }),
      ],
      onUpdateTags,
    })} />);

    fireEvent.click(screen.getByText('Note A'), { ctrlKey: true });
    fireEvent.click(screen.getByText('Note B'), { ctrlKey: true });
    await userEvent.setup().click(screen.getByRole('button', { name: 'sidebar.bulkTag' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'sidebar.bulkTagPrompt' }), {
      target: { value: 'daily, planning' },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'sidebar.bulkApply' }));

    expect(onUpdateTags).toHaveBeenNthCalledWith(1, { padId: 'pad-1', tags: ['existing', 'daily', 'planning'] });
    expect(onUpdateTags).toHaveBeenNthCalledWith(2, { padId: 'pad-2', tags: ['daily', 'planning'] });
    expect(screen.queryByRole('group', { name: 'sidebar.bulkTag' })).not.toBeInTheDocument();
  });

  it('keeps the selection when a bulk editor is cancelled and can explicitly ungroup pads', async () => {
    const onUpdateFolder = vi.fn();
    render(<PadSidebar {...baseProps({
      tabs: [tab({ id: 'pad-1', title: 'Note A', folder: 'Projects' })],
      onUpdateFolder,
    })} />);

    fireEvent.click(screen.getByText('Note A'), { ctrlKey: true });
    await userEvent.setup().click(screen.getByRole('button', { name: 'sidebar.bulkFolder' }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'sidebar.bulkCancel' }));
    expect(document.querySelector('.pad-sidebar__item--multiselected')).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'sidebar.bulkFolder' }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'sidebar.folderRemove' }));
    expect(onUpdateFolder).toHaveBeenCalledWith({ padId: 'pad-1', folder: null });
    expect(document.querySelector('.pad-sidebar__item--multiselected')).not.toBeInTheDocument();
  });
});
