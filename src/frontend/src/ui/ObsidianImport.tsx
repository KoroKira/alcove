import React, { useState, useRef } from 'react';
import { X, Upload, FolderOpen, CheckCircle, AlertCircle } from 'lucide-react';
import './ObsidianImport.scss';

interface ImportResult {
  name: string;
  id?: string;
  error?: string;
}

interface Props {
  onClose: () => void;
  onImported: (ids: string[]) => void;
}

export default function ObsidianImport({ onClose, onImported }: Props) {
  const [results, setResults] = useState<ImportResult[]>([]);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const runImport = async (files: File[]) => {
    const mdFiles = files.filter(f => f.name.endsWith('.md'));
    if (!mdFiles.length) return;

    setTotal(mdFiles.length);
    setProgress(0);
    setDone(false);
    setResults([]);

    const ids: string[] = [];

    for (const file of mdFiles) {
      const name = file.name.replace(/\.md$/, '');
      try {
        const content = await file.text();
        const createRes = await fetch('/api/pad/new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pad_type: 'document', display_name: name }),
        });
        if (!createRes.ok) throw new Error('Création échouée');
        const pad = await createRes.json();
        await fetch(`/api/pad/${pad.id}/doc`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, format: 'markdown' }),
        });
        ids.push(pad.id);
        setResults(r => [...r, { name, id: pad.id }]);
      } catch (e) {
        setResults(r => [...r, { name, error: String(e) }]);
      }
      setProgress(p => p + 1);
    }

    setDone(true);
    if (ids.length) onImported(ids);
  };

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) runImport(Array.from(e.target.files));
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
            <button className="obs-import__btn" onClick={onClose}>Fermer</button>
          </div>
        )}
      </div>
    </div>
  );
}
