// Global test setup — runs once before every test file.

import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Mock react-i18next globally: components import `useTranslation` widely and
// the real i18next isn't initialized here. Return the key back as the
// translation so assertions can still match on stable text, and hand back a
// fake `i18n` object with a known language.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'fr', changeLanguage: async () => {} },
  }),
  Trans: ({ children }: { children?: unknown }) => children as never,
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

// Unmount + reset DOM between tests so state doesn't leak across suites.
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

// Silence i18next's "no init" console.warn in components that import it.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// Polyfills for jsdom: scrollIntoView is called by AI panel / flashcards but
// doesn't exist in the default jsdom Element prototype.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
