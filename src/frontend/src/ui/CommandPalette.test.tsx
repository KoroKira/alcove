import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CommandPalette from './CommandPalette';

const callbacks = {
  onSelectPad: vi.fn(),
  onClose: vi.fn(),
  onNewCanvas: vi.fn(),
  onNewDocument: vi.fn(),
  onDailyNote: vi.fn(),
  onGraph: vi.fn(),
  onDashboard: vi.fn(),
  onSearch: vi.fn(),
  onToggleGrid: vi.fn(),
};

describe('CommandPalette accessibility', () => {
  it('announces itself as a modal and keeps focus inside until it closes', () => {
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open commands</button>
          {open && <CommandPalette tabs={[]} {...callbacks} onClose={() => setOpen(false)} />}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open commands' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'command.placeholder' });
    const input = screen.getByRole('combobox', { name: 'command.placeholder' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(input).toHaveFocus();

    // Options are reached with the arrow keys, so Tab never leaves the input.
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});

const tab = (id: string, title: string, padType: string, updatedAt: string) => ({
  id, title, padType, updatedAt, createdAt: updatedAt, ownerId: 'u1', sharingPolicy: 'private',
}) as any;

describe('CommandPalette listbox semantics', () => {
  const tabs = [
    tab('p-doc', 'Notes de projet', 'document', '2026-01-04'),
    tab('p-kan', 'Sprint 12', 'kanban', '2026-01-03'),
    tab('p-gan', 'Roadmap', 'gantt', '2026-01-02'),
    tab('p-tex', 'Article', 'latex', '2026-01-01'),
    tab('p-db', 'Contacts', 'database', '2025-12-31'),
    tab('p-can', 'Schéma', 'canvas', '2025-12-30'),
  ];

  it('labels every pad type correctly instead of calling them all canvases', () => {
    render(<CommandPalette tabs={tabs} {...callbacks} />);
    const label = (title: string) => screen.getByRole('option', { name: new RegExp(title) }).textContent;
    expect(label('Notes de projet')).toContain('command.typeDocument');
    expect(label('Sprint 12')).toContain('command.typeKanban');
    expect(label('Roadmap')).toContain('command.typeGantt');
    expect(label('Article')).toContain('command.typeLatex');
    expect(label('Contacts')).toContain('command.typeDatabase');
    expect(label('Schéma')).toContain('command.typeCanvas');
  });

  it('exposes the highlighted option to assistive technology and moves it with the arrows', () => {
    render(<CommandPalette tabs={tabs} {...callbacks} />);
    const input = screen.getByRole('combobox');
    const listbox = screen.getByRole('listbox');
    expect(input).toHaveAttribute('aria-controls', listbox.id);

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id);
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    // Options are never extra Tab stops.
    options.forEach(option => expect(option).toHaveAttribute('tabindex', '-1'));
  });

  it('opens the highlighted pad with Enter and groups results', () => {
    const onSelectPad = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette tabs={tabs} {...callbacks} onSelectPad={onSelectPad} onClose={onClose} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'sprint' } });
    expect(screen.getAllByRole('group').length).toBeGreaterThan(0);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelectPad).toHaveBeenCalledWith('p-kan');
    expect(onClose).toHaveBeenCalled();
  });
});
