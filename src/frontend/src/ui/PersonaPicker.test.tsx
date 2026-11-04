import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import PersonaPicker from './PersonaPicker';
import { createPersona, getActivePersonaId } from '../lib/personas';

afterEach(() => localStorage.clear());

describe('PersonaPicker keyboard access', () => {
  it('lets keyboard users pick a persona and go back to the default assistant', () => {
    const persona = createPersona('Relecteur', 'Relis de façon critique.');
    const onChange = vi.fn();
    render(<PersonaPicker onChange={onChange} />);
    fireEvent.click(screen.getAllByRole('button')[0]);          // open the dropdown

    const item = screen.getByRole('button', { name: /Relecteur/ });
    expect(item).toHaveAttribute('tabindex', '0');
    item.focus();
    fireEvent.keyDown(item, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: persona.id }));
    expect(getActivePersonaId()).toBe(persona.id);

    fireEvent.click(screen.getAllByRole('button')[0]);          // reopen
    const none = screen.getByRole('button', { name: /Assistant/ });
    none.focus();
    fireEvent.keyDown(none, { key: ' ' });
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(getActivePersonaId()).toBeNull();
  });
});
