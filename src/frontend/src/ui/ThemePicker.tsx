import React, { useState } from 'react';
import { X, Check, Plus, Trash2 } from 'lucide-react';
import { THEMES, applyTheme, type Theme } from '../themes';
import { loadCustomThemes, saveCustomThemes } from './ThemeBuilder';
import './ThemePicker.scss';

interface Props {
  currentThemeId: string;
  onClose: () => void;
  onSelect: (theme: Theme) => void;
  onOpenBuilder: () => void;
}

export default function ThemePicker({ currentThemeId, onClose, onSelect, onOpenBuilder }: Props) {
  const [customThemes, setCustomThemes] = useState<Theme[]>(loadCustomThemes);

  const deleteCustom = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = customThemes.filter(t => t.id !== id);
    setCustomThemes(next);
    saveCustomThemes(next);
  };

  const allThemes = [...THEMES, ...customThemes];

  return (
    <div className="theme-picker__backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="theme-picker" role="dialog">
        <div className="theme-picker__header">
          <span className="theme-picker__title">Thème</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button className="theme-picker__create-btn" onClick={onOpenBuilder} title="Créer un thème personnalisé">
              <Plus size={13} /> Créer
            </button>
            <button className="theme-picker__close" onClick={onClose}><X size={14} /></button>
          </div>
        </div>

        {customThemes.length > 0 && (
          <p className="theme-picker__section-label">Presets intégrés</p>
        )}

        <div className="theme-picker__grid">
          {THEMES.map(theme => <ThemeCard key={theme.id} theme={theme} active={theme.id === currentThemeId} onSelect={onSelect} />)}
        </div>

        {customThemes.length > 0 && (
          <>
            <p className="theme-picker__section-label theme-picker__section-label--custom">Mes thèmes</p>
            <div className="theme-picker__grid">
              {customThemes.map(theme => (
                <ThemeCard
                  key={theme.id}
                  theme={theme}
                  active={theme.id === currentThemeId}
                  onSelect={onSelect}
                  onDelete={id => deleteCustom(id, { stopPropagation: () => {} } as any)}
                  deleteBtn
                />
              ))}
            </div>
          </>
        )}

        <p className="theme-picker__hint">
          Sauvegardé localement · appliqué immédiatement sur toute l'interface
        </p>
      </div>
    </div>
  );
}

function ThemeCard({
  theme, active, onSelect, onDelete, deleteBtn,
}: {
  theme: Theme; active: boolean;
  onSelect: (t: Theme) => void;
  onDelete?: (id: string) => void;
  deleteBtn?: boolean;
}) {
  return (
    <button
      className={`theme-picker__card${active ? ' theme-picker__card--active' : ''}`}
      onClick={() => { applyTheme(theme); onSelect(theme); }}
      title={theme.name}
    >
      <div className="theme-picker__preview" style={{ background: theme.swatches[0] }}>
        <div className="theme-picker__swatch-row">
          {theme.swatches.slice(1).map((c, i) => (
            <span key={i} className="theme-picker__swatch" style={{ background: c }} />
          ))}
        </div>
        <div className="theme-picker__fake-ui">
          <div className="theme-picker__fake-sidebar" style={{ background: `${theme.swatches[0]}cc` }}>
            <div style={{ background: theme.swatches[1], width: 24, height: 4, borderRadius: 2, opacity: 0.7 }} />
            <div style={{ background: theme.swatches[2], width: 40, height: 3, borderRadius: 2, marginTop: 4, opacity: 0.5 }} />
            <div style={{ background: theme.swatches[2], width: 30, height: 3, borderRadius: 2, marginTop: 3, opacity: 0.5 }} />
          </div>
          <div className="theme-picker__fake-canvas">
            <div style={{ background: theme.swatches[1], width: 48, height: 32, borderRadius: 4, opacity: 0.6 }} />
            <div style={{ background: theme.swatches[3], width: 28, height: 8, borderRadius: 2, marginTop: 6, opacity: 0.7 }} />
          </div>
        </div>
        {active && <div className="theme-picker__check"><Check size={12} /></div>}
        {deleteBtn && onDelete && (
          <button
            className="theme-picker__delete"
            onClick={e => { e.stopPropagation(); onDelete(theme.id); }}
            title="Supprimer ce preset"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>

      <div className="theme-picker__card-footer">
        <span className="theme-picker__card-emoji">{theme.emoji}</span>
        <span className="theme-picker__card-name">{theme.name}</span>
        {!theme.dark && <span className="theme-picker__badge">clair</span>}
      </div>
    </button>
  );
}
