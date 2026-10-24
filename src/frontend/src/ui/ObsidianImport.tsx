import React, { useState, useRef } from 'react';
import { X, Upload, FolderOpen, CheckCircle, AlertCircle } from 'lucide-react';
import { importObsidianFiles, type ObsidianImportResult } from '../lib/obsidianImport';
import './ObsidianImport.scss';

interface Props {
  onClose: () => void;
  onImported: (ids: string[]) => void;
}

export default function ObsidianImport({ onClose, onImported }: Props) {
  const [results, setResults] = useState<ObsidianImportResult[]>([]);
  const [failedFiles, setFailedFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [emptyError, setEmptyError] = useState('');
  const importKeys = useRef<WeakMap<File, string>>(new WeakMap());
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, []);

  const close = () => {
    if (!importing) onClose();
  };

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled):not([type="file"]), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
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

  const runImport = async (files: File[], retry = false) => {
    if (importing) return;
    const mdFiles = files.filter(file => {
      if (!/\.md$/i.test(file.name)) return false;
      const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
      return !path.split(/[\\/]/).some(part => part === '.obsidian' || part === '.trash');
    });
    if (!mdFiles.length) {
      setEmptyError('Aucune note Markdown trouvée dans cette sélection.');
      return;
    }

    setTotal(mdFiles.length);
    setProgress(0);
    setDone(false);
    setEmptyError('');
    if (!retry) {
      importKeys.current = new WeakMap();
      setResults([]);
      setFailedFiles([]);
    }
    setImporting(true);
    closeRef.current?.focus();
    try {
      const imported = await importObsidianFiles(mdFiles, setProgress, fetch, importKeys.current);
      const fileByIdempotencyKey = new Map(mdFiles.map(file => [importKeys.current.get(file), file]));
      setFailedFiles(imported.flatMap(result => result.error && result.idempotencyKey && fileByIdempotencyKey.has(result.idempotencyKey)
        ? [fileByIdempotencyKey.get(result.idempotencyKey)!]
        : []));
      setResults(current => {
        if (!retry) return imported;
        const bySource = new Map(current.map(result => [result.idempotencyKey || result.sourceKey, result]));
        imported.forEach(result => bySource.set(result.idempotencyKey || result.sourceKey, result));
        return [...bySource.values()];
      });

      setDone(true);
      const ids = imported.flatMap(result => result.id ? [result.id] : []);
      if (ids.length) onImported(ids);
    } finally {
      setImporting(false);
    }
  };

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (files.length) void runImport(files);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files) runImport(Array.from(e.dataTransfer.files));
  };

  const successCount = results.filter(r => !r.error).length;
  const pct = total ? Math.round((progress / total) * 100) : 0;

  return (
    <div className="obs-import__backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div ref={dialogRef} onKeyDown={handleDialogKeyDown} className="obs-import__panel" role="dialog" aria-modal="true" aria-busy={importing} aria-labelledby="obs-import-title">
        <div className="obs-import__header">
          <span id="obs-import-title" className="obs-import__header-title"><Upload size={13} /> Importer depuis Obsidian</span>
          <button
            ref={closeRef}
            className="obs-import__close"
            type="button"
            aria-label={importing ? 'Import en cours, fermeture indisponible' : 'Fermer l’import'}
            aria-disabled={importing}
            title={importing ? 'Attends la fin de l’import pour fermer cette fenêtre.' : undefined}
            onClick={close}
          ><X size={14} /></button>
        </div>

        {!total ? (
          <div
            className={`obs-import__drop${dragging ? ' obs-import__drop--over' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <FolderOpen size={36} className="obs-import__drop-icon" />
            <div className="obs-import__drop-title">Glisse tes fichiers <code>.md</code> ici</div>
            <div className="obs-import__drop-sub">Choisis des fichiers individuels ou tout un dossier.</div>
            <div className="obs-import__drop-sub">Les notes sont importées avec leurs dossiers; les images et pièces jointes ne le sont pas encore.</div>
            {emptyError && <div className="obs-import__empty-error" role="alert">{emptyError}</div>}
            <div className="obs-import__selection-actions">
              <button className="obs-import__folder-btn" onClick={() => fileRef.current?.click()}>
                Sélectionner des fichiers
              </button>
              <button className="obs-import__folder-btn" onClick={() => folderRef.current?.click()}>
                Sélectionner un dossier
              </button>
            </div>

            {/* Hidden inputs */}
            <input ref={fileRef} type="file" accept=".md" multiple style={{ display: 'none' }} onChange={handleFiles} />
            <input
              ref={folderRef}
              type="file"
              style={{ display: 'none' }}
              multiple
              // @ts-ignore
              webkitdirectory=""
              onChange={handleFiles}
            />
          </div>
        ) : (
          <div className="obs-import__body">
            <div
              className="obs-import__prog-bar"
              role="progressbar"
              aria-label="Progression de l’import Obsidian"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={progress}
              aria-valuetext={`${progress} / ${total} fichiers traités`}
            >
              <div className="obs-import__prog-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="obs-import__counter" role="status" aria-live="polite" aria-atomic="true">
              {progress} / {total} fichiers traités
            </div>
            <div className="obs-import__results">
              {results.map((r, i) => (
                <div key={i} className={`obs-import__result${r.error ? ' obs-import__result--err' : ''}`}>
                  {r.error
                    ? <AlertCircle size={12} className="obs-import__result-icon--err" />
                    : <CheckCircle size={12} className="obs-import__result-icon--ok" />
                  }
                  <span className="obs-import__result-name">{r.name}</span>
                  {r.error && <span className="obs-import__result-err">{r.error}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {done && (
          <div className="obs-import__footer">
            <span className="obs-import__summary">
              {successCount} note{successCount > 1 ? 's' : ''} importée{successCount > 1 ? 's' : ''} ✓
            </span>
            {failedFiles.length > 0 && (
              <button className="obs-import__btn" onClick={() => void runImport(failedFiles, true)}>
                Réessayer les {failedFiles.length} échec{failedFiles.length > 1 ? 's' : ''}
              </button>
            )}
            <button className="obs-import__btn" type="button" onClick={close}>Fermer</button>
          </div>
        )}
      </div>
    </div>
  );
}
