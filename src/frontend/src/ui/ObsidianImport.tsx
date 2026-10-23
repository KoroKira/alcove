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
  const [dragging, setDragging] = useState(false);
  const [emptyError, setEmptyError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const runImport = async (files: File[], retry = false) => {
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
      setResults([]);
      setFailedFiles([]);
    }
    const imported = await importObsidianFiles(mdFiles, setProgress);
    const fileByPath = new Map(mdFiles.map(file => [
      ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).replace(/\\/g, '/'),
      file,
    ]));
    setFailedFiles(imported.flatMap(result => result.error && fileByPath.has(result.sourceKey)
      ? [fileByPath.get(result.sourceKey)!]
      : []));
    setResults(current => {
      if (!retry) return imported;
      const bySource = new Map(current.map(result => [result.sourceKey, result]));
      imported.forEach(result => bySource.set(result.sourceKey, result));
      return [...bySource.values()];
    });

    setDone(true);
    const ids = imported.flatMap(result => result.id ? [result.id] : []);
    if (ids.length) onImported(ids);
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
    <div className="obs-import__backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="obs-import__panel" role="dialog">
        <div className="obs-import__header">
          <span className="obs-import__header-title"><Upload size={13} /> Importer depuis Obsidian</span>
          <button className="obs-import__close" onClick={onClose}><X size={14} /></button>
        </div>

        {!total ? (
          <div
            className={`obs-import__drop${dragging ? ' obs-import__drop--over' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
          >
            <FolderOpen size={36} className="obs-import__drop-icon" />
            <div className="obs-import__drop-title">Glisse tes fichiers <code>.md</code> ici</div>
            <div className="obs-import__drop-sub">ou clique pour sélectionner des fichiers</div>
            <div className="obs-import__drop-sub">Les notes sont importées avec leurs dossiers; les images et pièces jointes ne le sont pas encore.</div>
            {emptyError && <div className="obs-import__empty-error" role="alert">{emptyError}</div>}
            <button
              className="obs-import__folder-btn"
              onClick={e => { e.stopPropagation(); folderRef.current?.click(); }}
            >
              Sélectionner un dossier
            </button>

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
            <div className="obs-import__prog-bar">
              <div className="obs-import__prog-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="obs-import__counter">
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
            <button className="obs-import__btn" onClick={onClose}>Fermer</button>
          </div>
        )}
      </div>
    </div>
  );
}
