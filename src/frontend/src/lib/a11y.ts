import type { KeyboardEvent } from 'react';

/**
 * Props that make a non-<button> element operable from the keyboard:
 * focusable, announced as a button, activated by Enter or Space. Only fires for
 * keys pressed on the element itself, so nested controls keep their own keys.
 * Prefer a real <button> when the markup allows it.
 */
export function pressable(onActivate: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate();
      }
    },
  };
}
