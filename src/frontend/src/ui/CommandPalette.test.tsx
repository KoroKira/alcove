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
    const input = screen.getByRole('textbox', { name: 'command.placeholder' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    const controls = dialog.querySelectorAll<HTMLElement>(
      'input:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    );
    const lastControl = controls.item(controls.length - 1);
    expect(lastControl).toHaveFocus();
    fireEvent.keyDown(lastControl, { key: 'Tab' });
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
