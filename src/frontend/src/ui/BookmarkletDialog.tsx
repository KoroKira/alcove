/**
 * "Save to Alcove" bookmarklet (chantier #12, step 1 of the roadmap's
 * browser-extension plan). A full Chrome extension needs an API-key auth
 * subsystem (new DB table, issuing UI, Bearer middleware — a separate,
 * larger piece of work per the roadmap's own prerequisite note) that isn't
 * worth building for what a bookmarklet already solves: one click, from any
 * page, to open Alcove's own "Add from link" flow pre-filled with the
 * current tab's URL. It reuses the browser's existing Alcove session
 * cookie — no new auth mechanism, no extension packaging/store review.
 *
 * The bookmarklet itself just opens `{origin}/?add=<url>` in a new tab —
 * App.tsx's bookmarklet effect does the rest (opens AddFromLink, auto-
 * ingests, strips the query param).
 */
import React, { useRef } from 'react';
import { X, Bookmark, MousePointerClick } from 'lucide-react';
import './BookmarkletDialog.scss';

interface Props {
  onClose: () => void;
}

function buildBookmarkletHref(): string {
  const origin = window.location.origin;
  // Minified inline: open a new tab at {origin}/?add={current page URL}.
  const js = `javascript:(function(){window.open('${origin}/?add='+encodeURIComponent(location.href),'_blank');})();`;
  return js;
}

export default function BookmarkletDialog({ onClose }: Props) {
  const linkRef = useRef<HTMLAnchorElement>(null);
  const href = buildBookmarkletHref();

  return (
    <div className="bookmarklet-dialog__backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bookmarklet-dialog__panel" role="dialog">
        <div className="bookmarklet-dialog__header">
          <span className="bookmarklet-dialog__title"><Bookmark size={14} /> Enregistrer depuis n'importe quel site</span>
          <button className="bookmarklet-dialog__close" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="bookmarklet-dialog__body">
          <p className="bookmarklet-dialog__intro">
            Glisse ce bouton dans ta barre de favoris. Depuis n'importe quelle page,
            un clic dessus l'envoie directement dans Alcove.
          </p>

          <div className="bookmarklet-dialog__drag-row">
            <a
              ref={linkRef}
              className="bookmarklet-dialog__bookmarklet"
              href={href}
              onClick={e => e.preventDefault()}
              draggable
            >
              <MousePointerClick size={13} /> Enregistrer dans Alcove
            </a>
            <span className="bookmarklet-dialog__drag-hint">← glisse-moi dans tes favoris</span>
          </div>

          <div className="bookmarklet-dialog__steps">
            <div className="bookmarklet-dialog__step">
              <strong>1.</strong> Affiche ta barre de favoris (Ctrl+Maj+B / Cmd+Maj+B)
            </div>
            <div className="bookmarklet-dialog__step">
              <strong>2.</strong> Glisse le bouton ci-dessus dedans
            </div>
            <div className="bookmarklet-dialog__step">
              <strong>3.</strong> Sur n'importe quelle page, clique-le — Alcove s'ouvre avec la page prête à ingérer
            </div>
          </div>

          <div className="bookmarklet-dialog__note">
            Fonctionne dans l'onglet où tu es déjà connecté à Alcove. Une vraie extension
            Chrome (avec clé API) fait partie de la roadmap pour un usage cross-appareil.
          </div>
        </div>
      </div>
    </div>
  );
}
