import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PadSidebar from './PadSidebar';
import { SharingPolicy, type Tab } from '../hooks/usePadTabs';

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
});
