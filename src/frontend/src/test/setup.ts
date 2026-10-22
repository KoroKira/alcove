// Global test setup — runs once before every test file.

import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Node versions with an experimental global localStorage can shadow JSDOM's
// storage globals. Provide deterministic per-test storage in either runtime.
function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(String(key)) ?? null,
    key: index => Array.from(values.keys())[index] ?? null,
    removeItem: key => { values.delete(String(key)); },
    setItem: (key, value) => { values.set(String(key), String(value)); },
  };
}

for (const key of ['localStorage', 'sessionStorage'] as const) {
  if (!window[key]) {
    Object.defineProperty(window, key, { configurable: true, value: createMemoryStorage() });
  }
  vi.stubGlobal(key, window[key]);
}

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
