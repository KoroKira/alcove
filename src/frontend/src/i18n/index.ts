import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import fr from './locales/fr.json';
import en from './locales/en.json';
import de from './locales/de.json';
import es from './locales/es.json';

export const LANGUAGES = {
  fr: { label: 'Français', flag: '🇫🇷' },
  en: { label: 'English', flag: '🇬🇧' },
  de: { label: 'Deutsch', flag: '🇩🇪' },
  es: { label: 'Español', flag: '🇪🇸' },
} as const;

export type LangCode = keyof typeof LANGUAGES;

function detectLang(): LangCode {
  const nav = navigator.language.slice(0, 2);
  return (nav in LANGUAGES ? nav : 'fr') as LangCode;
}

const saved = localStorage.getItem('pad-ws-lang') as LangCode | null;

i18n
  .use(initReactI18next)
  .init({
    resources: {
      fr: { translation: fr },
      en: { translation: en },
      de: { translation: de },
      es: { translation: es },
    },
    lng: saved ?? detectLang(),
    fallbackLng: 'fr',
    interpolation: { escapeValue: false },
  });

export const setLanguage = (lang: LangCode) => {
  i18n.changeLanguage(lang);
  localStorage.setItem('pad-ws-lang', lang);
};

export default i18n;
