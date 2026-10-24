import React, { useState, useEffect, useRef, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import { Play, X, FileCode2 } from 'lucide-react';
import { useRetryOnReconnect } from '../hooks/useRetryOnReconnect';
import { retryStructuredSaveAfterMetadataChange } from '../lib/metadataConflict';
import { advanceStructuredPadDraftVersion, clearStructuredPadDraft, fetchAndSnapshotStructuredPadVersion, hasStructuredPadDraft, isStructuredPadDraftStale, readStructuredPadDraftRecord, removeStructuredPadDraft, writeStructuredPadDraft } from '../lib/structuredPadDraft';
import { enqueueSerializedSave } from '../lib/saveQueue';
import './LatexPad.scss';

const DEFAULT_SOURCE = `\\documentclass[12pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{geometry}
\\geometry{margin=2.5cm}

\\title{Mon document}
\\author{Auteur}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
Bienvenue dans l'éditeur \\LaTeX{} intégré à Alcove.

\\section{Mathématiques}
\\[
  E = mc^2 \\qquad
  \\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
\\]

\\end{document}
`;

interface LatexData { source: string; }

function readServerLatexData(value: unknown): { data: LatexData; updatedAt: string | null } {
  const response = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const body = response.data && typeof response.data === 'object'
    ? response.data as Record<string, unknown>
    : response;
  const source = typeof body.source === 'string'
    ? body.source
    : typeof body.content === 'string'
      ? body.content
      : DEFAULT_SOURCE;
  const updatedAt = typeof response.updated_at === 'string'
    ? response.updated_at
    : typeof body.updated_at === 'string'
      ? body.updated_at
      : null;
  return { data: { source }, updatedAt };
}

interface Props {
  padId: string;
  globalThemeDark?: boolean;
}

export default function LatexPad({ padId, globalThemeDark = true }: Props) {
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'compiling' | 'ok' | 'err'>('idle');
  const [autoCompile, setAutoCompile] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [conflict, setConflict] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftAvailable, setDraftAvailable] = useState(false);
  const [draftStorageError, setDraftStorageError] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<LatexData | null>(null);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const savedPdfUrl = useRef<string | null>(null);
  const padIdRef = useRef(padId);
  const sourceRef = useRef(DEFAULT_SOURCE);
  const lastUpdatedAt = useRef<string | null>(null);
  const persistedData = useRef<LatexData>({ source: DEFAULT_SOURCE });

  padIdRef.current = padId;

  const loadPad = useCallback(async () => {
    setLoaded(false);
    setLoadError(null);
    setSaveError(null);
    setSaveState('idle');
    setConflict(false);
    setPendingDraft(null);
    try {
      const response = await fetch(`/api/pad/${encodeURIComponent(padId)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rawData = await response.json();
      if (padIdRef.current !== padId) return;

      const { data: serverData, updatedAt: serverUpdatedAt } = readServerLatexData(rawData);
      const draft = readStructuredPadDraftRecord<LatexData>(padId);
      lastUpdatedAt.current = serverUpdatedAt;
      persistedData.current = serverData;
      setDraftAvailable(Boolean(draft));
      setDraftStorageError(false);

      if (draft && isStructuredPadDraftStale(draft, serverUpdatedAt)) {
        sourceRef.current = serverData.source;
        setSource(serverData.source);
        setPendingDraft(draft.data);
        setConflict(true);
      } else if (draft) {
        sourceRef.current = draft.data.source;
        setSource(draft.data.source);
        setPendingDraft(draft.data);
        setDraftRestored(true);
      } else {
        sourceRef.current = serverData.source;
        setSource(serverData.source);
        setDraftRestored(false);
      }
      setLoaded(true);
    } catch (error) {
      if (padIdRef.current === padId) {
        setLoadError(error instanceof Error ? error.message : 'Erreur réseau');
      }
    }
  }, [padId]);

  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (autoTimer.current) clearTimeout(autoTimer.current);
    setSource(DEFAULT_SOURCE);
    sourceRef.current = DEFAULT_SOURCE;
    setDraftRestored(false);
    setDraftAvailable(false);
    setDraftStorageError(false);
    setLoaded(false);
    void loadPad();
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (autoTimer.current) clearTimeout(autoTimer.current);
    };
  }, [padId, loadPad]);

  const save = useCallback((src: string, immediate = false, allowConflict = false) => {
    if (!loaded || (conflict && !allowConflict)) return;
    const savePadId = padId;
    const payload: LatexData = { source: src };
    const stored = writeStructuredPadDraft(savePadId, payload, lastUpdatedAt.current);
    setDraftAvailable(hasStructuredPadDraft(savePadId));
    setDraftStorageError(!stored);
    setSaveError(null);
    setSaveState('saving');
    setDraftRestored(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void enqueueSerializedSave(saveQueue, async () => {
        if (padIdRef.current !== savePadId) return;
        try {
          let response = await fetch(`/api/pad/${encodeURIComponent(savePadId)}/data`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: payload, expected_updated_at: lastUpdatedAt.current }),
          });
          if (response.status === 409 && padIdRef.current === savePadId) {
            response = await retryStructuredSaveAfterMetadataChange(savePadId, persistedData.current, payload) ?? response;
          }
          if (response.status === 409) {
            if (padIdRef.current === savePadId) {
              setPendingDraft(readStructuredPadDraftRecord<LatexData>(savePadId)?.data ?? payload);
              setConflict(true);
              setSaveError(null);
              setSaveState('idle');
            }
            return;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const result = await response.json().catch(() => null) as { updated_at?: unknown } | null;
          if (typeof result?.updated_at === 'string') {
            if (padIdRef.current === savePadId) lastUpdatedAt.current = result.updated_at;
            advanceStructuredPadDraftVersion(savePadId, payload, result.updated_at);
          }
          clearStructuredPadDraft(savePadId, payload);
          if (padIdRef.current !== savePadId) return;
          persistedData.current = payload;
          setDraftAvailable(hasStructuredPadDraft(savePadId));
          setDraftStorageError(false);
          setSaveError(null);
          setSaveState(sourceRef.current === payload.source ? 'saved' : 'saving');
        } catch (error) {
          if (padIdRef.current !== savePadId) return;
          setDraftAvailable(hasStructuredPadDraft(savePadId));
          setSaveError(error instanceof Error ? error.message : 'Erreur réseau');
          setSaveState('idle');
        }
      });
    }, immediate ? 0 : 500);
  }, [conflict, loaded, padId]);

  useRetryOnReconnect(Boolean(saveError) && !conflict, () => save(source, true));

  const useServerVersion = async () => {
    try {
      const response = await fetch(`/api/pad/${encodeURIComponent(padId)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rawData = await response.json();
      if (padIdRef.current !== padId) return;
      const { data: serverData, updatedAt } = readServerLatexData(rawData);
      lastUpdatedAt.current = updatedAt;
      persistedData.current = serverData;
      sourceRef.current = serverData.source;
      setSource(serverData.source);
      removeStructuredPadDraft(padId);
      setDraftAvailable(false);
      setDraftStorageError(false);
      setPendingDraft(null);
      setConflict(false);
      setSaveError(null);
      setDraftRestored(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Impossible de relire la version serveur.');
    }
  };

  const keepLocalDraft = async () => {
    const localDraft = pendingDraft ?? readStructuredPadDraftRecord<LatexData>(padId)?.data;
    if (!localDraft) return;
    try {
      const updatedAt = await fetchAndSnapshotStructuredPadVersion(padId);
      if (padIdRef.current !== padId) return;
      lastUpdatedAt.current = updatedAt;
      setConflict(false);
      setSaveError(null);
      setPendingDraft(null);
      sourceRef.current = localDraft.source;
      setSource(localDraft.source);
      save(localDraft.source, true, true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Impossible de protéger la version serveur.');
    }
  };

  const compile = useCallback(async (src: string) => {
    setStatus('compiling');
    try {
      const res = await fetch('/api/latex/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: src }),
      });
      const data = await res.json();
      if (data.success && data.pdf) {
        const bytes = Uint8Array.from(atob(data.pdf), c => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'application/pdf' });
        if (savedPdfUrl.current) URL.revokeObjectURL(savedPdfUrl.current);
        const url = URL.createObjectURL(blob);
        savedPdfUrl.current = url;
        setPdfUrl(url);
        setLog(data.log ?? null);
        setLogOpen(false);
        setStatus('ok');
      } else {
        setLog(data.log ?? 'Erreur de compilation inconnue.');
        setLogOpen(true);
        setStatus('err');
      }
    } catch {
      setLog('Impossible de contacter le serveur.');
      setLogOpen(true);
      setStatus('err');
    }
  }, []);

  useEffect(() => () => {
    if (savedPdfUrl.current) URL.revokeObjectURL(savedPdfUrl.current);
  }, []);

  const handleChange = (val: string | undefined) => {
    const next = val ?? '';
    sourceRef.current = next;
    setSource(next);
    setPendingDraft(null);
    save(next);
    if (autoCompile) {
      if (autoTimer.current) clearTimeout(autoTimer.current);
      autoTimer.current = setTimeout(() => compile(next), 1200);
    }
  };

  const monacoTheme = globalThemeDark ? 'vs-dark' : 'light';
  const statusLabel = status === 'compiling' ? 'Compilation…' : status === 'ok' ? '✓ Compilé' : status === 'err' ? '✗ Erreur' : '';
  const statusMod = status === 'ok' ? '--ok' : status === 'err' ? '--err' : '--compiling';

  return (
    <div className="latex-pad">
      <div className="latex-pad__toolbar">
        <div className="latex-pad__toolbar-left">
          <span className="latex-pad__title">LaTeX</span>
          <button className="latex-pad__compile-btn" onClick={() => compile(source)} disabled={!loaded || status === 'compiling' || conflict}>
            <Play size={12} /> Compiler
          </button>
          <label className="latex-pad__auto-label">
            <input type="checkbox" checked={autoCompile} onChange={e => setAutoCompile(e.target.checked)} />
            Auto
          </label>
        </div>
        <div className="latex-pad__toolbar-right">
          {status !== 'idle' && (
            <span className={`latex-pad__status latex-pad__status${statusMod}`} role="status" aria-live="polite">{statusLabel}</span>
          )}
          {saveState !== 'idle' && <span role="status" aria-live="polite">{saveState === 'saving' ? 'Enregistrement…' : 'Enregistré'}</span>}
        </div>
      </div>

      {loadError && <div role="alert" className="latex-pad__save-alert">Impossible de charger ce document ({loadError}). <button type="button" onClick={() => void loadPad()}>Réessayer</button></div>}
      {draftRestored && !conflict && <div role="status" className="latex-pad__save-alert">Brouillon local récupéré. <button type="button" onClick={() => save(source, true)}>Enregistrer maintenant</button></div>}
      {saveError && !conflict && <div role="alert" className="latex-pad__save-alert">Échec de sauvegarde ({saveError}). {draftAvailable ? 'Brouillon conservé sur cet appareil.' : draftStorageError ? 'Impossible de conserver une copie locale.' : ''} <button type="button" onClick={() => save(source, true)}>Réessayer</button></div>}
      {conflict && <div role="alert" className="latex-pad__save-alert">
        Ce pad a changé depuis la création du brouillon local. La version serveur est protégée avant tout remplacement.
        {saveError && <span>{saveError}</span>}
        <button type="button" onClick={() => void keepLocalDraft()}>Garder le brouillon local</button>
        <button type="button" onClick={() => void useServerVersion()}>Utiliser la version serveur</button>
      </div>}
      {!loaded && !loadError && <div role="status" className="latex-pad__save-alert">Chargement du document…</div>}

      <div className="latex-pad__body">
        <div className="latex-pad__editor">
          <Editor
            value={source}
            onChange={handleChange}
            language="latex"
            theme={monacoTheme}
            options={{
              ariaLabel: 'Code source LaTeX',
              readOnly: !loaded || conflict,
              fontSize: 13,
              minimap: { enabled: false },
              wordWrap: 'on',
              lineNumbers: 'on',
              padding: { top: 12 },
              scrollBeyondLastLine: false,
              fontLigatures: true,
            }}
          />
        </div>

        <div className="latex-pad__preview">
          {pdfUrl ? (
            <iframe className="latex-pad__pdf-frame" src={pdfUrl} title="Aperçu PDF" />
          ) : (
            <div className="latex-pad__placeholder">
              <FileCode2 size={40} />
              <span>Clique sur <strong>Compiler</strong> pour générer le PDF</span>
              <span style={{ fontSize: 11, opacity: 0.6 }}>Nécessite pdflatex (MacTeX / TeX Live)</span>
            </div>
          )}

          {logOpen && log && (
            <div className="latex-pad__log">
              <div className="latex-pad__log-header">
                <span>Log de compilation</span>
                <button className="latex-pad__log-close" type="button" aria-label="Fermer le journal de compilation" onClick={() => setLogOpen(false)}><X size={13} /></button>
              </div>
              <div className="latex-pad__log-body">{log}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
