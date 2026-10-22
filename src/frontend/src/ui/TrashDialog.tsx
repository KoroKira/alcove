import React, { useCallback, useEffect, useState } from 'react';
import { RotateCcw, Trash2, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import './TrashDialog.scss';

type TrashedPad = {
  id: string;
  display_name: string;
  pad_type: string;
  deleted_at: string | null;
};

interface Props {
  onClose: () => void;
}

const TrashDialog: React.FC<Props> = ({ onClose }) => {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [pads, setPads] = useState<TrashedPad[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/pad/trash', { signal });
      if (!response.ok) throw new Error('trash_load_failed');
      const body = await response.json() as { pads?: TrashedPad[] };
      setPads(Array.isArray(body.pads) ? body.pads : []);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(t('sidebar.trashLoadError'));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const restore = async (pad: TrashedPad) => {
    setRestoringId(pad.id);
    setError('');
    try {
      const response = await fetch(`/api/pad/${pad.id}/restore`, { method: 'POST' });
      if (!response.ok) throw new Error('trash_restore_failed');
      setPads(current => current.filter(item => item.id !== pad.id));
      await queryClient.invalidateQueries({ queryKey: ['padTabs'] });
    } catch {
      setError(t('sidebar.trashRestoreError'));
    } finally {
      setRestoringId(null);
    }
  };

  const date = (value: string | null) => {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    return new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(parsed);
  };

  return (
    <div className="trash-dialog__backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="trash-dialog" role="dialog" aria-modal="true" aria-labelledby="trash-dialog-title" aria-busy={loading}>
        <header className="trash-dialog__header">
          <div className="trash-dialog__heading">
            <Trash2 size={18} aria-hidden="true" />
            <h2 id="trash-dialog-title">{t('sidebar.trashTitle')}</h2>
          </div>
          <button className="trash-dialog__close" type="button" onClick={onClose} aria-label={t('dashboard.close')}>
            <X size={17} />
          </button>
        </header>

        <div className="trash-dialog__body" aria-live="polite">
          {loading ? <p className="trash-dialog__status">{t('sidebar.trashLoading')}</p> : null}
          {!loading && error ? (
            <div className="trash-dialog__error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => void load()}>{t('sidebar.trashRetry')}</button>
            </div>
          ) : null}
          {!loading && !error && pads.length === 0 ? (
            <p className="trash-dialog__status">{t('sidebar.trashEmpty')}</p>
          ) : null}
          {!loading && pads.length > 0 ? (
            <ul className="trash-dialog__list">
              {pads.map(pad => (
                <li className="trash-dialog__item" key={pad.id}>
                  <div className="trash-dialog__item-copy">
                    <strong>{pad.display_name}</strong>
                    <span>{date(pad.deleted_at) ? t('sidebar.trashDeletedAt', { date: date(pad.deleted_at) }) : t('sidebar.trashOnlyRestore')}</span>
                  </div>
                  <button
                    className="trash-dialog__restore"
                    type="button"
                    onClick={() => void restore(pad)}
                    disabled={restoringId !== null}
                    aria-label={`${t('sidebar.trashRestore')} ${pad.display_name}`}
                  >
                    <RotateCcw size={14} />
                    <span>{t('sidebar.trashRestore')}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <footer className="trash-dialog__footer">{t('sidebar.trashRetention')}</footer>
      </section>
    </div>
  );
};

export default TrashDialog;
