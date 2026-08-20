/**
 * Batch import from a browser bookmarks export (chantier #11). Chrome,
 * Firefox and Safari all export the same "Netscape Bookmark File Format"
 * (a plain HTML file of nested <DL>/<DT><A HREF="…">Title</A> entries) —
 * one parser covers every browser. Each bookmark is ingested through the
 * same /api/ingest/web pipeline "Add from link" uses, so imported pads get
 * real extracted content, not just a bare URL.
 *
 * Scope: dedup is within-batch only (skip repeated URLs in the same file) —
 * checking every bookmark against the account's full existing pad set would
 * need a new backend lookup; this matches the roadmap's explicit target
 * ("Add up to 10 links… create as cards") more than a full crawl-everything
 * import, and keeps failure blast radius small (network errors on one
 * bookmark don't block the rest — concurrency is capped so a few hundred
 * bookmarks don't fire a fetch storm at arbitrary external sites).
 */
import React, { useState, useRef } from 'react';
import { X, Upload, Bookmark, CheckCircle, AlertCircle, SkipForward } from 'lucide-react';
import './ObsidianImport.scss'; // shared modal chrome (backdrop/panel/drop-zone) — see class names below

interface ImportResult {
  title: string;
  url: string;
  id?: string;
  error?: string;
  skipped?: boolean;
}

interface Props {
  onClose: () => void;
  onImported: (ids: string[]) => void;
}

interface ParsedBookmark { title: string; url: string; }

function parseNetscapeBookmarks(html: string): ParsedBookmark[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const anchors = Array.from(doc.querySelectorAll('a[href]'));
  const out: ParsedBookmark[] = [];
  const seen = new Set<string>();
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    if (!href.startsWith('http://') && !href.startsWith('https://')) continue;
    // Canonical-ish key for within-batch dedup: strip trailing slash + hash.
    const key = href.replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: a.textContent?.trim() || href, url: href });
  }
  return out;
}

const CONCURRENCY = 3;

export default function BookmarksImport({ onClose, onImported }: Props) {
  const [results, setResults] = useState<ImportResult[]>([]);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const importOne = async (bm: ParsedBookmark): Promise<ImportResult> => {
    try {
      const ingestResp = await fetch('/api/ingest/web', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: bm.url }),
      });
      if (!ingestResp.ok) throw new Error(`Ingestion échouée (${ingestResp.status})`);
      const ing = await ingestResp.json();

      const createResp = await fetch('/api/pad/new', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pad_type: 'document', display_name: ing.title || bm.title, content: ing.markdown || '' }),
      });
      if (!createResp.ok) throw new Error('Création du pad échouée');
      const pad = await createResp.json();

      const thumb = ing.metadata?.thumbnail;
      if (thumb || bm.url) {
        await fetch(`/api/pad/${pad.id}/card-meta`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thumbnail_url: thumb || undefined, source_url: bm.url }),
        }).catch(() => {});
      }
      return { title: ing.title || bm.title, url: bm.url, id: pad.id };
    } catch (e) {
      return { title: bm.title, url: bm.url, error: e instanceof Error ? e.message : String(e) };
    }
  };

  const runImport = async (bookmarks: ParsedBookmark[]) => {
    if (!bookmarks.length) return;
    setTotal(bookmarks.length);
    setProgress(0);
    setDone(false);
    setResults([]);

    const ids: string[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < bookmarks.length) {
        const bm = bookmarks[cursor++];
        const result = await importOne(bm);
        if (result.id) ids.push(result.id);
        setResults(r => [...r, result]);
        setProgress(p => p + 1);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, bookmarks.length) }, worker));

    setDone(true);
    if (ids.length) onImported(ids);
  };

  const handleFile = async (file: File) => {
    const html = await file.text();
    const bookmarks = parseNetscapeBookmarks(html);
    runImport(bookmarks);
  };

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  const successCount = results.filter(r => r.id).length;
  const errorCount = results.filter(r => r.error).length;
  const pct = total ? Math.round((progress / total) * 100) : 0;

  return (
    <div className="obs-import__backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="obs-import__panel" role="dialog">
        <div className="obs-import__header">
          <span className="obs-import__header-title"><Bookmark size={13} /> Importer des favoris</span>
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
            <Upload size={36} className="obs-import__drop-icon" />
            <div className="obs-import__drop-title">Glisse ton export de favoris ici</div>
            <div className="obs-import__drop-sub">
              Chrome/Firefox/Safari : Favoris → Exporter les favoris (fichier .html)
            </div>
            <input ref={fileRef} type="file" accept=".html,.htm" style={{ display: 'none' }} onChange={handleFiles} />
          </div>
        ) : (
          <div className="obs-import__body">
            <div className="obs-import__prog-bar">
              <div className="obs-import__prog-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="obs-import__counter">
              {progress} / {total} favoris traités
            </div>
            <div className="obs-import__results">
              {results.map((r, i) => (
                <div key={i} className={`obs-import__result${r.error ? ' obs-import__result--err' : ''}`}>
                  {r.error
                    ? <AlertCircle size={12} className="obs-import__result-icon--err" />
                    : <CheckCircle size={12} className="obs-import__result-icon--ok" />}
                  <span className="obs-import__result-name">{r.title}</span>
                  {r.error && <span className="obs-import__result-err">{r.error}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {done && (
          <div className="obs-import__footer">
            <span className="obs-import__summary">
              {successCount} favori{successCount > 1 ? 's' : ''} importé{successCount > 1 ? 's' : ''} ✓
              {errorCount > 0 && <> · <SkipForward size={11} style={{ verticalAlign: 'middle' }} /> {errorCount} échec{errorCount > 1 ? 's' : ''}</>}
            </span>
            <button className="obs-import__btn" onClick={onClose}>Fermer</button>
          </div>
        )}
      </div>
    </div>
  );
}
