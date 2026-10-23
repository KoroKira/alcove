import React, { useEffect, useRef, useState } from 'react';
import { X, RotateCcw, Clock } from 'lucide-react';
import './HistoryPanel.scss';

interface Version {
  id: string;
  pad_type: string;
  snapshot_reason: string;
  created_at: string;
}

interface Props {
  padId: string;
  onClose: () => void;
  onRestore: () => void | Promise<void>;
  canRestore?: boolean;
  restoreBlockedReason?: string;
  onRestoringChange?: (restoring: boolean) => void;
}

const HistoryPanel: React.FC<Props> = ({
  padId,
  onClose,
  onRestore,
  canRestore = true,
  restoreBlockedReason,
  onRestoringChange,
}) => {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Version | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreTrigger = useRef<HTMLButtonElement | null>(null);
  const previewRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      previewRequest.current?.abort();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  useEffect(() => {
    if (confirmation) cancelRef.current?.focus();
  }, [confirmation]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setVersions([]);
    setPreview(null);
    setPreviewId(null);
    setPreviewLoadingId(null);
    setConfirmation(null);
    previewRequest.current?.abort();
    fetch(`/api/pad/${padId}/versions`)
      .then(async r => {
        if (!r.ok) throw new Error(`Impossible de charger l’historique (${r.status}).`);
        return r.json();
      })
      .then(d => { if (active) setVersions(Array.isArray(d.versions) ? d.versions : []); })
      .catch(cause => {
        if (!active) return;
        setVersions([]);
        setError(cause instanceof Error ? cause.message : 'Impossible de charger l’historique.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [padId]);

  const loadPreview = async (v: Version) => {
    previewRequest.current?.abort();
    setPreview(null);
    if (previewId === v.id || previewLoadingId === v.id) {
      setPreviewId(null);
      setPreviewLoadingId(null);
      return;
    }
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreviewId(null);
    setPreviewLoadingId(v.id);
    setError(null);
    try {
      const response = await fetch(`/api/pad/${padId}/versions/${v.id}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Impossible de charger cette version (${response.status}).`);
      const d = await response.json();
      if (!d.data) throw new Error('Les données de cette version sont indisponibles.');
      if (controller.signal.aborted) return;
      setPreview(typeof d.data.content === 'string' ? d.data.content : JSON.stringify(d.data, null, 2));
      setPreviewId(v.id);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Impossible de charger cette version.');
    } finally {
      if (!controller.signal.aborted) setPreviewLoadingId(null);
    }
  };

  const cancelConfirmation = () => {
    setConfirmation(null);
    restoreTrigger.current?.focus();
  };

  const restore = async (versionId: string) => {
    if (restoring || !canRestore) return;
    setRestoring(versionId);
    onRestoringChange?.(true);
    setError(null);
    try {
      const response = await fetch(`/api/pad/${padId}/versions/${versionId}/restore`, { method: 'POST' });
      if (!response.ok) throw new Error(`Impossible de restaurer cette version (${response.status}).`);
      await onRestore();
      setConfirmation(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Impossible de restaurer cette version.');
    } finally {
      setRestoring(null);
      onRestoringChange?.(false);
    }
  };

  const fmt = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const reasonLabel = (r: string) => {
    if (r === 'manual') return 'Manuel';
    if (r === 'pre-restore') return 'Avant restauration';
    return 'Auto';
  };

  return (
    <section className="history-panel" aria-label="Historique des versions" onKeyDown={event => {
      if (event.key !== 'Escape' || restoring) return;
      event.preventDefault();
      event.stopPropagation();
      if (confirmation) cancelConfirmation();
      else onClose();
    }}>
      <div className="history-panel__header">
        <Clock size={14} aria-hidden="true" />
        <span>Historique</span>
        <button ref={closeRef} type="button" className="history-panel__close" onClick={onClose} aria-label="Fermer l’historique" disabled={restoring !== null}><X size={14} aria-hidden="true" /></button>
      </div>
      {!canRestore && restoreBlockedReason && (
        <div className="history-panel__hint" role="status">{restoreBlockedReason}</div>
      )}
      <div className="history-panel__list" aria-busy={loading}>
        {loading && <div className="history-panel__empty" role="status">Chargement…</div>}
        {!loading && !error && versions.length === 0 && (
          <div className="history-panel__empty">Aucune version sauvegardée</div>
        )}
        {versions.map(v => (
          <div key={v.id} className={`history-panel__item ${previewId === v.id ? 'history-panel__item--active' : ''}`}>
            <button type="button" className="history-panel__item-main" onClick={() => void loadPreview(v)} aria-expanded={previewId === v.id} aria-controls={previewId === v.id ? 'history-version-preview' : undefined} disabled={restoring !== null}>
              <time className="history-panel__item-date" dateTime={v.created_at}>{fmt(v.created_at)}</time>
              <span className={`history-panel__item-reason history-panel__item-reason--${v.snapshot_reason}`}>
                {reasonLabel(v.snapshot_reason)}
              </span>
            </button>
            <button
              type="button"
              className="history-panel__restore-btn"
              onClick={event => { restoreTrigger.current = event.currentTarget; setConfirmation(v); }}
              disabled={restoring !== null || !canRestore}
              title="Restaurer cette version"
              aria-label={`Restaurer la version du ${fmt(v.created_at)}`}
            >
              <RotateCcw size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      {confirmation && (
        <div className="history-panel__confirmation" role="group" aria-labelledby="history-restore-title" aria-describedby="history-restore-description">
          <strong id="history-restore-title">Restaurer la version du {fmt(confirmation.created_at)} ?</strong>
          <p id="history-restore-description">Le contenu actuel sera remplacé. Une copie sera conservée dans l’historique pour revenir en arrière.</p>
          <div className="history-panel__confirmation-actions">
            <button ref={cancelRef} type="button" onClick={cancelConfirmation} disabled={restoring !== null}>Annuler</button>
            <button type="button" onClick={() => void restore(confirmation.id)} disabled={restoring !== null || !canRestore}>
              {restoring ? 'Restauration…' : 'Confirmer la restauration'}
            </button>
          </div>
        </div>
      )}
      {error && <div className="history-panel__error" role="alert">{error}</div>}
      {previewLoadingId && <div className="history-panel__hint" role="status">Chargement de l’aperçu…</div>}
      {preview !== null && (
        <section id="history-version-preview" className="history-panel__preview" aria-label="Aperçu de la version">
          <div className="history-panel__preview-label">Aperçu</div>
          {preview === '' ? <p className="history-panel__empty">Cette version est vide.</p> : <pre className="history-panel__preview-content" tabIndex={0}>{preview.slice(0, 2000)}{preview.length > 2000 ? '…' : ''}</pre>}
        </section>
      )}
    </section>
  );
};

export default HistoryPanel;
