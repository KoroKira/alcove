import React, { useState, useEffect, useRef, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import { Play, X, FileCode2 } from 'lucide-react';
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
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedPdfUrl = useRef<string | null>(null);

  // Load saved source from backend
  useEffect(() => {
    fetch(`/api/pad/${padId}`)
      .then(r => r.json())
      .then(d => {
        if (d?.source) setSource(d.source);
      })
      .catch(() => {});
  }, [padId]);

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

  // Auto-compile with debounce
  const handleChange = (val: string | undefined) => {
    const src = val ?? '';
    setSource(src);
    // Persist to backend
    fetch(`/api/pad/${padId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { source: src } }),
    }).catch(() => {});
    if (autoCompile) {
      if (autoTimer.current) clearTimeout(autoTimer.current);
      autoTimer.current = setTimeout(() => compile(src), 1200);
    }
  };

  const monacoTheme = globalThemeDark ? 'vs-dark' : 'light';
  const statusLabel = status === 'compiling' ? 'Compilation…' : status === 'ok' ? '✓ Compilé' : status === 'err' ? '✗ Erreur' : '';
  const statusMod = status === 'ok' ? '--ok' : status === 'err' ? '--err' : '--compiling';

  return (
    <div className="latex-pad">
      {/* Toolbar */}
      <div className="latex-pad__toolbar">
        <div className="latex-pad__toolbar-left">
          <span className="latex-pad__title">LaTeX</span>
          <button
            className="latex-pad__compile-btn"
            onClick={() => compile(source)}
            disabled={status === 'compiling'}
          >
            <Play size={12} /> Compiler
          </button>
          <label className="latex-pad__auto-label">
            <input type="checkbox" checked={autoCompile} onChange={e => setAutoCompile(e.target.checked)} />
            Auto
          </label>
        </div>
        <div className="latex-pad__toolbar-right">
          {status !== 'idle' && (
            <span className={`latex-pad__status latex-pad__status${statusMod}`}>{statusLabel}</span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="latex-pad__body">
        {/* Editor */}
        <div className="latex-pad__editor">
          <Editor
            value={source}
            onChange={handleChange}
            language="latex"
            theme={monacoTheme}
            options={{
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

        {/* PDF preview */}
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

          {/* Error log */}
          {logOpen && log && (
            <div className="latex-pad__log">
              <div className="latex-pad__log-header">
                <span>Log de compilation</span>
                <button className="latex-pad__log-close" onClick={() => setLogOpen(false)}><X size={13} /></button>
              </div>
              <div className="latex-pad__log-body">{log}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
