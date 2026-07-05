import React, { useState, useEffect, useCallback } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { NonDeleted, ExcalidrawEmbeddableElement } from '@atyrode/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@atyrode/excalidraw/types';
import './MarkdownViewer.scss';

interface MarkdownViewerProps {
  element: NonDeleted<ExcalidrawEmbeddableElement>;
  excalidrawAPI?: ExcalidrawImperativeAPI;
}

const toRawUrl = (url: string): string => {
  // Convert github.com blob URLs to raw.githubusercontent.com
  return url
    .replace('https://github.com/', 'https://raw.githubusercontent.com/')
    .replace('/blob/', '/');
};

const saveSource = (element: NonDeleted<ExcalidrawEmbeddableElement>, excalidrawAPI: ExcalidrawImperativeAPI | undefined, source: string) => {
  if (!excalidrawAPI) return;
  const elements = excalidrawAPI.getSceneElementsIncludingDeleted().map(el =>
    el.id === element.id ? { ...el, customData: { ...el.customData, markdownSource: source } } : el
  );
  excalidrawAPI.updateScene({ elements } as any);
};

export const MarkdownViewer: React.FC<MarkdownViewerProps> = ({ element, excalidrawAPI }) => {
  const [source, setSource] = useState<string>(element.customData?.markdownSource || '');
  const [html, setHtml] = useState<string>('');
  const [editing, setEditing] = useState(!element.customData?.markdownSource);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const render = useCallback(async (src: string) => {
    if (!src.trim()) { setHtml(''); return; }
    setLoading(true);
    setError(null);
    try {
      let content = src;
      if (src.startsWith('http')) {
        const res = await fetch(toRawUrl(src));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        content = await res.text();
      }
      const rawHtml = await marked.parse(content);
      setHtml(DOMPurify.sanitize(rawHtml));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!editing && source) render(source);
  }, [editing, source, render]);

  const handleApply = () => {
    saveSource(element, excalidrawAPI, source);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="md-viewer md-viewer--edit">
        <textarea
          className="md-viewer__input"
          value={source}
          onChange={e => setSource(e.target.value)}
          placeholder="Colle du markdown ou une URL (GitHub, raw…)"
          autoFocus
        />
        <div className="md-viewer__toolbar">
          <button className="md-viewer__btn md-viewer__btn--primary" onClick={handleApply}>Afficher</button>
          {element.customData?.markdownSource && (
            <button className="md-viewer__btn" onClick={() => setEditing(false)}>Annuler</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="md-viewer md-viewer--render">
      {loading && <div className="md-viewer__loading">Chargement…</div>}
      {error && <div className="md-viewer__error">Erreur : {error}</div>}
      {!loading && !error && (
        <div
          className="md-viewer__content"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      <button className="md-viewer__edit-btn" onClick={() => setEditing(true)} title="Modifier la source">✏️</button>
    </div>
  );
};

export default MarkdownViewer;
