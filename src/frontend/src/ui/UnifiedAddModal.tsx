import React, { useEffect, useRef } from 'react';
import {
  X, Link2, FileText, Presentation, KanbanSquare, GanttChartSquare,
  Sigma, Table2, CalendarDays, StickyNote, Import, Mic,
} from 'lucide-react';
import './UnifiedAddModal.scss';

/**
 * Modale unifiée de création : un seul geste pour ajouter n'importe quel type
 * de contenu à Alcove. Remplace le patchwork de boutons dispersés
 * (PadSidebar "New", Dashboard "Nouveau canvas/document", CommandPalette,
 * HomeHub, MainMenu…) par une entrée unique.
 *
 * Deux zones :
 *  - Ingérer : contenu externe transformé par l'IA (web, PDF, YouTube, audio,
 *    vidéo, vault Obsidian). Ouvre les dialogues existants (AddFromLink,
 *    ObsidianImport) — pas de duplication de logique.
 *  - Créer   : les 7 types de pad natifs. Ouvre directement le pad via les
 *    fonctions createNew* de usePadTabs.
 */

interface Props {
  onClose: () => void;
  onIngest: () => void;                // → ouvre AddFromLink
  onImportObsidian: () => void;        // → ouvre ObsidianImport
  onQuickCapture: () => void;          // → ouvre QuickCapture (note express)
  onCreateCanvas: () => void;
  onCreateDocument: () => void;
  onCreateKanban: () => void;
  onCreateGantt: () => void;
  onCreateLatex: () => void;
  onCreateDatabase: () => void;
  onCreateDaily: () => void;
}

interface Tile {
  key: string;
  icon: React.ReactNode;
  title: string;
  hint: string;
  onClick: () => void;
  accent?: 'ingest' | 'create';
}

export default function UnifiedAddModal({
  onClose, onIngest, onImportObsidian, onQuickCapture,
  onCreateCanvas, onCreateDocument, onCreateKanban, onCreateGantt,
  onCreateLatex, onCreateDatabase, onCreateDaily,
}: Props) {
  const closeAfter = (fn: () => void) => () => { fn(); onClose(); };

  const ingestTiles: Tile[] = [
    {
      key: 'link',
      icon: <Link2 size={20} />,
      title: 'Ajouter depuis un lien',
      hint: 'Web, YouTube, PDF, audio, vidéo — l\'IA résume, tague et indexe',
      onClick: closeAfter(onIngest),
      accent: 'ingest',
    },
    {
      key: 'note',
      icon: <StickyNote size={20} />,
      title: 'Capture rapide',
      hint: 'Une note flash dans le pad Scratch',
      onClick: closeAfter(onQuickCapture),
      accent: 'ingest',
    },
    {
      key: 'obsidian',
      icon: <Import size={20} />,
      title: 'Importer un vault Obsidian',
      hint: 'Batch import de .md et assets',
      onClick: closeAfter(onImportObsidian),
      accent: 'ingest',
    },
  ];

  const createTiles: Tile[] = [
    {
      key: 'document',
      icon: <FileText size={20} />,
      title: 'Document',
      hint: 'Markdown · wikilinks · KaTeX · Mermaid',
      onClick: closeAfter(onCreateDocument),
      accent: 'create',
    },
    {
      key: 'canvas',
      icon: <Presentation size={20} />,
      title: 'Canvas',
      hint: 'Tableau blanc Excalidraw',
      onClick: closeAfter(onCreateCanvas),
      accent: 'create',
    },
    {
      key: 'kanban',
      icon: <KanbanSquare size={20} />,
      title: 'Kanban',
      hint: 'À faire · En cours · Terminé',
      onClick: closeAfter(onCreateKanban),
      accent: 'create',
    },
    {
      key: 'gantt',
      icon: <GanttChartSquare size={20} />,
      title: 'Gantt',
      hint: 'Diagramme de projet interactif',
      onClick: closeAfter(onCreateGantt),
      accent: 'create',
    },
    {
      key: 'database',
      icon: <Table2 size={20} />,
      title: 'Database',
      hint: 'Vue Table ⇄ Board avec propriétés typées',
      onClick: closeAfter(onCreateDatabase),
      accent: 'create',
    },
    {
      key: 'latex',
      icon: <Sigma size={20} />,
      title: 'LaTeX',
      hint: 'Éditeur avec compilation PDF',
      onClick: closeAfter(onCreateLatex),
      accent: 'create',
    },
    {
      key: 'daily',
      icon: <CalendarDays size={20} />,
      title: 'Note du jour',
      hint: 'Journal quotidien auto-généré',
      onClick: closeAfter(onCreateDaily),
      accent: 'create',
    },
  ];

  // Focus le premier bouton pour la nav clavier
  const firstTileRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    firstTileRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const renderTile = (t: Tile, idx: number, section: 'ingest' | 'create') => (
    <button
      key={t.key}
      ref={section === 'ingest' && idx === 0 ? firstTileRef : undefined}
      className={`unified-add__tile unified-add__tile--${t.accent}`}
      onClick={t.onClick}
      type="button"
    >
      <span className="unified-add__tile-icon">{t.icon}</span>
      <span className="unified-add__tile-body">
        <span className="unified-add__tile-title">{t.title}</span>
        <span className="unified-add__tile-hint">{t.hint}</span>
      </span>
    </button>
  );

  return (
    <div
      className="unified-add__backdrop"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="unified-add-title"
    >
      <div className="unified-add">
        <header className="unified-add__header">
          <h2 id="unified-add-title" className="unified-add__title">Ajouter à Alcove</h2>
          <button className="unified-add__close" onClick={onClose} aria-label="Fermer">
            <X size={18} />
          </button>
        </header>

        <section className="unified-add__section">
          <div className="unified-add__section-label">
            <Mic size={12} /> Ingérer un contenu <span className="unified-add__section-hint">l'IA travaille pour vous</span>
          </div>
          <div className="unified-add__grid unified-add__grid--ingest">
            {ingestTiles.map((t, i) => renderTile(t, i, 'ingest'))}
          </div>
        </section>

        <section className="unified-add__section">
          <div className="unified-add__section-label">
            <FileText size={12} /> Créer un pad <span className="unified-add__section-hint">un nouvel espace vide</span>
          </div>
          <div className="unified-add__grid unified-add__grid--create">
            {createTiles.map((t, i) => renderTile(t, i, 'create'))}
          </div>
        </section>
      </div>
    </div>
  );
}
