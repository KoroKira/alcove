import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  const [announcement, setAnnouncement] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

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
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, []);

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
    ) ?? []);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const restore = async (pad: TrashedPad) => {
    setRestoringId(pad.id);
    setError('');
    setAnnouncement('');
    try {
      const response = await fetch(`/api/pad/${pad.id}/restore`, { method: 'POST' });
      if (!response.ok) throw new Error('trash_restore_failed');
      closeRef.current?.focus();
      setPads(current => current.filter(item => item.id !== pad.id));
      setAnnouncement(t('sidebar.trashRestored', { name: pad.display_name }));
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
      <section ref={dialogRef} onKeyDown={handleDialogKeyDown} className="trash-dialog" role="dialog" aria-modal="true" aria-labelledby="trash-dialog-title" aria-busy={loading || restoringId !== null}>
        <header className="trash-dialog__header">
          <div className="trash-dialog__heading">
            <Trash2 size={18} aria-hidden="true" />
            <h2 id="trash-dialog-title">{t('sidebar.trashTitle')}</h2>
          </div>
          <button ref={closeRef} className="trash-dialog__close" type="button" onClick={onClose} aria-label={t('dashboard.close')}>
            <X size={17} />
          </button>
        </header>

        <div className="trash-dialog__body">
          <p className="trash-dialog__announcement" role="status">{announcement}</p>
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
                    title={t('sidebar.trashRestore')}
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
