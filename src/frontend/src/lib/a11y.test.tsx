import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { pressable } from './a11y';

describe('pressable', () => {
  it('makes a div focusable, announced as a button, and keyboard-activated', () => {
    const onActivate = vi.fn();
    render(<div {...pressable(onActivate)}>Ouvrir</div>);
    const el = screen.getByRole('button', { name: 'Ouvrir' });
    expect(el).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(el, { key: 'Enter' });
    fireEvent.keyDown(el, { key: ' ' });
    expect(onActivate).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(el, { key: 'a' });
    fireEvent.keyDown(el, { key: 'Tab' });
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it('ignores keys pressed on a nested control', () => {
    const onActivate = vi.fn();
    render(<div {...pressable(onActivate)} aria-label="Ligne"><button>Renommer</button></div>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Renommer' }), { key: 'Enter' });
    expect(onActivate).not.toHaveBeenCalled();
  });
});
