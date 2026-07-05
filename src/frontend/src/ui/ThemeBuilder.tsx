import React, { useState, useCallback } from 'react';
import { X, Wand2, Save, Play } from 'lucide-react';
import { THEMES, type Theme, applyTheme } from '../themes';
import './ThemeBuilder.scss';

const CUSTOM_KEY = 'alkopad-custom-themes';

export function loadCustomThemes(): Theme[] {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]'); } catch { return []; }
}

export function saveCustomThemes(themes: Theme[]) {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(themes));
}

const COLOR_GROUPS = [
  {
    label: 'Fonds',
    fields: [
      { key: '--ap-sidebar-bg', label: 'Sidebar' },
      { key: '--ap-bg0',        label: 'Canvas / Fond principal' },
      { key: '--ap-bg1',        label: 'Surface #1 (éditeur)' },
      { key: '--ap-bg2',        label: 'Surface #2 (cartes)' },
      { key: '--ap-bg3',        label: 'Bordures / Séparateurs' },
    ],
  },
  {
    label: 'Textes',
    fields: [
      { key: '--ap-text0', label: 'Texte principal' },
      { key: '--ap-text1', label: 'Texte secondaire' },
      { key: '--ap-text2', label: 'Texte tertiaire / Icônes' },
    ],
  },
  {
    label: 'Accents',
    fields: [
      { key: '--ap-accent',  label: 'Accent principal' },
      { key: '--ap-accent2', label: 'Accent secondaire' },
    ],
  },
  {
    label: 'Couleurs sémantiques',
    fields: [
      { key: '--ap-green',  label: 'Succès / Vert' },
      { key: '--ap-red',    label: 'Erreur / Rouge' },
      { key: '--ap-yellow', label: 'Avertissement / Jaune' },
      { key: '--ap-orange', label: 'Orange' },
    ],
  },
] as const;

function hexToRgb(hex: string): string {
  const m = hex.replace('#', '').match(/.{2}/g);
  if (!m) return '0,0,0';
  return m.slice(0, 3).map(x => parseInt(x, 16)).join(',');
}

function varsToTheme(name: string, dark: boolean, vars: Record<string, string>): Theme {
  const accent = vars['--ap-accent'] ?? '#cba6f7';
  return {
    id: `custom-${Date.now()}`,
    name,
    emoji: dark ? '🎨' : '🖼️',
    dark,
    swatches: [
      vars['--ap-bg0'] ?? '#1e1e2e',
      vars['--ap-accent'] ?? '#cba6f7',
      vars['--ap-accent2'] ?? '#89b4fa',
      vars['--ap-green'] ?? '#a6e3a1',
    ],
    vars: {
      ...vars,
      '--ap-accent-rgb': hexToRgb(accent),
      '--color-surface': vars['--ap-bg1'] ?? vars['--ap-bg0'] ?? '#181825',
      '--color-surface-lowest': vars['--ap-bg0'] ?? '#1e1e2e',
      '--color-surface-mid': vars['--ap-bg2'] ?? '#313244',
      '--color-surface-high': vars['--ap-bg3'] ?? '#45475a',
      '--color-on-surface': vars['--ap-text0'] ?? '#cdd6f4',
      '--color-on-surface-low': vars['--ap-text2'] ?? '#a6adc8',
    },
  };
}

interface Props {
  onClose: () => void;
  onSaved: (theme: Theme) => void;
  onApply: (theme: Theme) => void;
  initialThemeId?: string;
}

export default function ThemeBuilder({ onClose, onSaved, onApply, initialThemeId }: Props) {
  const base = THEMES.find(t => t.id === initialThemeId) ?? THEMES[0];

  const [name, setName] = useState('Mon thème');
  const [dark, setDark] = useState(base.dark);
  const [vars, setVars] = useState<Record<string, string>>({ ...base.vars });

  const setVar = useCallback((key: string, value: string) => {
    setVars(v => ({ ...v, [key]: value }));
  }, []);

  const loadBase = (id: string) => {
    const t = THEMES.find(th => th.id === id);
    if (t) { setVars({ ...t.vars }); setDark(t.dark); }
  };

  const preview = varsToTheme(name, dark, vars);

  const handleApply = () => { applyTheme(preview); onApply(preview); };

  const handleSave = () => {
    const theme = { ...preview, id: `custom-${Date.now()}` };
    const existing = loadCustomThemes().filter(t => t.name !== name);
    saveCustomThemes([...existing, theme]);
    applyTheme(theme);
    onSaved(theme);
  };

  return (
    <div className="theme-builder" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="theme-builder__panel">

        {/* Header */}
        <div className="theme-builder__header">
          <span className="theme-builder__title"><Wand2 size={16} /> Créer un thème</span>
          <div className="theme-builder__header-right">
            <button className="theme-builder__close" onClick={onClose}><X size={16} /></button>
          </div>
        </div>

        <div className="theme-builder__body">

          {/* Left editor */}
          <div className="theme-builder__editor">
            <div className="theme-builder__name-row">
              <span className="theme-builder__group-label">Nom du preset</span>
              <input
                className="theme-builder__input"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Mon thème…"
              />
            </div>

            <div className="theme-builder__base-row">
              <span className="theme-builder__group-label">Partir d'un thème existant</span>
              <select className="theme-builder__select" onChange={e => loadBase(e.target.value)} defaultValue="">
                <option value="" disabled>Choisir une base…</option>
                {THEMES.map(t => (
                  <option key={t.id} value={t.id}>{t.emoji} {t.name}</option>
                ))}
              </select>
            </div>

            <label className="theme-builder__dark-toggle">
              <input type="checkbox" checked={dark} onChange={e => setDark(e.target.checked)} />
              Mode sombre (Monaco + Excalidraw en dark)
            </label>

            {COLOR_GROUPS.map(group => (
              <div key={group.label} className="theme-builder__group">
                <span className="theme-builder__group-label">{group.label}</span>
                {group.fields.map(({ key, label }) => (
                  <div key={key} className="theme-builder__color-row">
                    <span className="theme-builder__color-label">{label}</span>
                    <label className="theme-builder__color-swatch">
                      <input
                        type="color"
                        value={vars[key] ?? '#000000'}
                        onChange={e => setVar(key, e.target.value)}
                      />
                      <span>{vars[key] ?? '—'}</span>
                    </label>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Right preview */}
          <div className="theme-builder__preview">
            <span className="theme-builder__preview-label">Aperçu en direct</span>

            {/* Mini mockup */}
            <div className="theme-builder__mockup">
              {/* Sidebar */}
              <div
                className="theme-builder__mock-sidebar"
                style={{ background: vars['--ap-sidebar-bg'] ?? vars['--ap-bg0'] }}
              >
                {['--ap-text2', '--ap-accent', '--ap-text2', '--ap-text2', '--ap-text2'].map((c, i) => (
                  <div
                    key={i}
                    className={`theme-builder__mock-item${i === 1 ? ' theme-builder__mock-item--active' : ''}`}
                    style={{ background: vars[c] ?? '#cba6f7', borderRadius: i === 1 ? 4 : 3 }}
                  />
                ))}
              </div>

              {/* Canvas */}
              <div className="theme-builder__mock-canvas" style={{ background: vars['--ap-bg0'] }}>
                {/* Toolbar mockup */}
                <div
                  className="theme-builder__mock-card"
                  style={{
                    background: vars['--ap-bg1'],
                    border: `1px solid ${vars['--ap-bg3'] ?? 'rgba(255,255,255,0.1)'}`,
                    display: 'flex', alignItems: 'center', gap: 6, height: 28,
                  }}
                >
                  {['--ap-accent', '--ap-text2', '--ap-text2', '--ap-text2'].map((c, i) => (
                    <div key={i} style={{ width: 10, height: 10, borderRadius: '50%', background: vars[c] ?? '#cba6f7', opacity: i === 0 ? 1 : 0.5 }} />
                  ))}
                </div>

                {/* Cards */}
                {[1, 0.7].map((op, i) => (
                  <div
                    key={i}
                    className="theme-builder__mock-card"
                    style={{
                      background: vars['--ap-bg2'],
                      border: `1px solid ${vars['--ap-bg3'] ?? 'rgba(255,255,255,0.07)'}`,
                      opacity: op,
                    }}
                  >
                    <div className="theme-builder__mock-text" style={{ background: vars['--ap-text0'], width: '70%' }} />
                    <div className="theme-builder__mock-text" style={{ background: vars['--ap-text2'] }} />
                  </div>
                ))}

                {/* Accent bar */}
                <div style={{ height: 4, width: '60%', borderRadius: 2, background: vars['--ap-accent'] }} />
              </div>
            </div>

            {/* Color palette dots */}
            <span className="theme-builder__preview-label">Palette</span>
            <div className="theme-builder__palette">
              {[
                '--ap-sidebar-bg','--ap-bg0','--ap-bg1','--ap-bg2','--ap-bg3',
                '--ap-text0','--ap-text2',
                '--ap-accent','--ap-accent2',
                '--ap-green','--ap-red','--ap-yellow','--ap-orange',
              ].map(k => (
                <div
                  key={k}
                  className="theme-builder__swatch-dot"
                  style={{ background: vars[k] ?? '#888' }}
                  title={k}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="theme-builder__footer">
          <button className="theme-builder__btn theme-builder__btn--ghost" onClick={onClose}>Annuler</button>
          <button className="theme-builder__btn theme-builder__btn--ghost" onClick={handleApply}>
            <Play size={12} /> Prévisualiser
          </button>
          <button className="theme-builder__btn theme-builder__btn--save" onClick={handleSave}>
            <Save size={12} /> Sauvegarder le preset
          </button>
        </div>
      </div>
    </div>
  );
}
