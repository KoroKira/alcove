import React, { useEffect, useState } from 'react';
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
  onRestore: () => void;
}

const HistoryPanel: React.FC<Props> = ({ padId, onClose, onRestore }) => {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
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
    if (previewId === v.id) { setPreview(null); setPreviewId(null); return; }
    setError(null);
    try {
      const response = await fetch(`/api/pad/${padId}/versions/${v.id}`);
      if (!response.ok) throw new Error(`Impossible de charger cette version (${response.status}).`);
      const d = await response.json();
      if (!d.data) throw new Error('Les données de cette version sont indisponibles.');
      setPreview(d.data.content || JSON.stringify(d.data, null, 2));
      setPreviewId(v.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Impossible de charger cette version.');
    }
  };

  const restore = async (versionId: string) => {
    setRestoring(versionId);
    setError(null);
    try {
      const response = await fetch(`/api/pad/${padId}/versions/${versionId}/restore`, { method: 'POST' });
      if (!response.ok) throw new Error(`Impossible de restaurer cette version (${response.status}).`);
      onRestore();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Impossible de restaurer cette version.');
    } finally {
      setRestoring(null);
    }
  };

  const fmt = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const reasonLabel = (r: string) => {
    if (r === 'manual') return 'Manuel';
    if (r === 'pre-restore') return 'Avant restore';
    return 'Auto';
  };

  return (
    <div className="history-panel">
      <div className="history-panel__header">
        <Clock size={14} />
        <span>Historique</span>
        <button className="history-panel__close" onClick={onClose}><X size={14} /></button>
      </div>
      <div className="history-panel__list">
        {loading && <div className="history-panel__empty">Chargement…</div>}
        {!loading && !error && versions.length === 0 && (
          <div className="history-panel__empty">Aucune version sauvegardée</div>
        )}
        {versions.map(v => (
          <div key={v.id} className={`history-panel__item ${previewId === v.id ? 'history-panel__item--active' : ''}`}>
            <button className="history-panel__item-main" onClick={() => loadPreview(v)}>
              <span className="history-panel__item-date">{fmt(v.created_at)}</span>
              <span className={`history-panel__item-reason history-panel__item-reason--${v.snapshot_reason}`}>
                {reasonLabel(v.snapshot_reason)}
              </span>
            </button>
            <button
              className="history-panel__restore-btn"
              onClick={() => restore(v.id)}
              disabled={restoring === v.id}
              title="Restaurer cette version"
            >
              <RotateCcw size={12} />
            </button>
          </div>
        ))}
      </div>
      {error && <div className="history-panel__error" role="alert">{error}</div>}
      {preview !== null && (
        <div className="history-panel__preview">
          <div className="history-panel__preview-label">Aperçu</div>
          <pre className="history-panel__preview-content">{preview.slice(0, 2000)}{preview.length > 2000 ? '…' : ''}</pre>
        </div>
      )}
    </div>
  );
};

export default HistoryPanel;
