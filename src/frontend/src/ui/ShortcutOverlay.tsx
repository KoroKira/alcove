import React from 'react';
import { X } from 'lucide-react';
import './ShortcutOverlay.scss';

interface ShortcutGroup {
  label: string;
  items: { keys: string[]; desc: string }[];
}

const GROUPS: ShortcutGroup[] = [
  {
    label: 'Navigation',
    items: [
      { keys: ['⌘', 'P'], desc: 'Palette de commandes' },
      { keys: ['⌘', 'K'], desc: 'Recherche plein-texte' },
      { keys: ['⌘', 'D'], desc: 'Dashboard' },
      { keys: ['⌘', '\\'], desc: 'Sidebar' },
      { keys: ['⌘', '/'], desc: 'Aide & Raccourcis' },
    ],
  },
  {
    label: 'Créer',
    items: [
      { keys: ['⌘', 'N'], desc: 'Nouveau pad' },
      { keys: ['⌘', 'T'], desc: 'Daily note' },
      { keys: ['⌘', '⇧', 'N'], desc: 'Capture rapide → Scratch' },
    ],
  },
  {
    label: 'Éditeur de documents',
    items: [
      { keys: ['⌘', '⇧', 'F'], desc: 'Mode focus' },
      { keys: ['Esc'], desc: 'Quitter le focus' },
    ],
  },
  {
    label: 'Canvas',
    items: [
      { keys: ['⌘', 'G'], desc: 'Grille' },
      { keys: ['⌘', '⇧', 'G'], desc: 'Graphe de liens' },
      { keys: ['Space'], desc: 'Mode présentation — slide suiv.' },
      { keys: ['←', '→'], desc: 'Présentation — navigation' },
    ],
  },
  {
    label: 'Interface',
    items: [
      { keys: ['⌘', '⇧', 'F'], desc: 'Mode focus' },
    ],
  },
];

interface Props {
  onClose: () => void;
}

export default function ShortcutOverlay({ onClose }: Props) {
  return (
    <div className="shortcut__backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="shortcut__panel" role="dialog">
        <div className="shortcut__header">
          <span className="shortcut__title">Aide & Raccourcis</span>
          <button className="shortcut__close" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="shortcut__body">
          {GROUPS.map(group => (
            <div key={group.label} className="shortcut__group">
              <div className="shortcut__group-label">{group.label}</div>
              {group.items.map((item, i) => (
                <div key={i} className="shortcut__item">
                  <span className="shortcut__desc">{item.desc}</span>
                  <span className="shortcut__keys">
                    {item.keys.map((k, j) => (
                      <React.Fragment key={j}>
                        <kbd className="shortcut__key">{k}</kbd>
                        {j < item.keys.length - 1 && <span className="shortcut__plus">+</span>}
                      </React.Fragment>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="shortcut__footer">
          <kbd className="shortcut__key">Esc</kbd> pour fermer
        </div>
      </div>
    </div>
  );
}
