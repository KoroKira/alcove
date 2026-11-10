import { describe, expect, it } from 'vitest';
import i18n, { applyDocumentLang, setLanguage } from './index';

describe('document language', () => {
  it('matches the UI language at startup and after a language change', async () => {
    expect(document.documentElement.lang).toBe(i18n.language.slice(0, 2));
    setLanguage('de');
    await i18n.changeLanguage('de');
    expect(document.documentElement.lang).toBe('de');
    setLanguage('fr');
    await i18n.changeLanguage('fr');
    expect(document.documentElement.lang).toBe('fr');
  });

  it('ignores an empty language', () => {
    document.documentElement.lang = 'es';
    applyDocumentLang(undefined);
    expect(document.documentElement.lang).toBe('es');
  });

  it('restores the UI language when another library overwrites <html lang>', async () => {
    await i18n.changeLanguage('de');
    document.documentElement.lang = 'en-EN';   // what Excalidraw does after mounting
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.documentElement.lang).toBe('de');
  });
});
