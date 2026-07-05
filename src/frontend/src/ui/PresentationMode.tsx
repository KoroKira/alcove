import React, { useState, useEffect, useCallback } from 'react';
import type { ExcalidrawImperativeAPI } from '@atyrode/excalidraw/types';
import './PresentationMode.scss';

interface Slide {
  id: string;
  label: string;
  elements: any[];
}

interface Props {
  excalidrawAPI: ExcalidrawImperativeAPI;
  onClose: () => void;
}

/* Group non-frame elements into clusters by proximity (simple grid bucketing) */
function clusterElements(elements: any[]): any[][] {
  if (!elements.length) return [];

  // Sort by x position to cluster left→right
  const sorted = [...elements].filter(el => !el.isDeleted && el.type !== 'frame');
  if (!sorted.length) return [];

  // Find bounding box
  const xs = sorted.map(el => el.x);
  const ys = sorted.map(el => el.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs.map((x, i) => x + (sorted[i].width || 0)));
  const totalW = maxX - minX;

  // If everything fits in one screen worth (~1600px) → single slide
  if (totalW < 2000) return [sorted];

  // Bucket into columns of ~1200px
  const BUCKET = 1400;
  const buckets = new Map<number, any[]>();
  for (const el of sorted) {
    const key = Math.floor((el.x - minX) / BUCKET);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(el);
  }
  return Array.from(buckets.values()).filter(b => b.length > 0);
}

function buildSlides(api: ExcalidrawImperativeAPI): Slide[] {
  const elements = api.getSceneElements().filter((el: any) => !el.isDeleted);
  const frames = elements.filter((el: any) => el.type === 'frame');

  if (frames.length > 0) {
    // Sort frames by x position (left→right)
    const sorted = [...frames].sort((a: any, b: any) => a.x - b.x);
    return sorted.map((frame: any, i: number) => ({
      id: frame.id,
      label: frame.name || `Slide ${i + 1}`,
      // Include the frame itself + all elements inside it
      elements: elements.filter((el: any) => el.frameId === frame.id || el.id === frame.id),
    }));
  }

  // No frames — cluster elements spatially
  const clusters = clusterElements(elements);
  if (clusters.length <= 1) {
    return [{ id: 'all', label: 'Vue complète', elements }];
  }
  return clusters.map((els, i) => ({
    id: `cluster-${i}`,
    label: `Slide ${i + 1}`,
    elements: els,
  }));
}

export default function PresentationMode({ excalidrawAPI, onClose }: Props) {
  const [slides] = useState<Slide[]>(() => buildSlides(excalidrawAPI));
  const [current, setCurrent] = useState(0);

  const goTo = useCallback((idx: number) => {
    if (idx < 0 || idx >= slides.length) return;
    const slide = slides[idx];
    setCurrent(idx);
    // Use all elements if slide has none (shouldn't happen)
    const targets = slide.elements.length ? slide.elements : excalidrawAPI.getSceneElements();
    excalidrawAPI.scrollToContent(targets, { fitToViewport: true });
  }, [slides, excalidrawAPI]);

  // Initial scroll
  useEffect(() => { if (slides.length) goTo(0); }, []); // eslint-disable-line

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't steal events from inputs
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ')
        goTo(Math.min(current + 1, slides.length - 1));
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
        goTo(Math.max(current - 1, 0));
      else if (e.key === 'Escape')
        onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [current, goTo, slides.length, onClose]);

  if (slides.length === 0) {
    return (
      <div className="pres-mode">
        <div className="pres-mode__empty">
          <p>Canvas vide.</p>
          <button onClick={onClose} className="pres-mode__close-btn">Fermer</button>
        </div>
      </div>
    );
  }

  const hasFrames = excalidrawAPI.getSceneElements().some((el: any) => el.type === 'frame' && !el.isDeleted);

  return (
    <div className="pres-mode">
      {/* Slide counter top-center */}
      <div className="pres-mode__counter-badge">
        {current + 1} / {slides.length}
        {!hasFrames && <span className="pres-mode__counter-hint"> (mode automatique)</span>}
      </div>

      {/* Controls overlay — bottom bar */}
      <div className="pres-mode__bar">
        <div className="pres-mode__thumbnails">
          {slides.map((s, i) => (
            <button
              key={s.id}
              className={`pres-mode__thumb${i === current ? ' pres-mode__thumb--active' : ''}`}
              onClick={() => goTo(i)}
            >
              <span className="pres-mode__thumb-num">{i + 1}</span>
              <span className="pres-mode__thumb-label">{s.label}</span>
            </button>
          ))}
        </div>

        <div className="pres-mode__nav">
          <button
            className="pres-mode__nav-btn"
            onClick={() => goTo(Math.max(current - 1, 0))}
            disabled={current === 0}
          >
            ‹
          </button>
          <button
            className="pres-mode__nav-btn"
            onClick={() => goTo(Math.min(current + 1, slides.length - 1))}
            disabled={current === slides.length - 1}
          >
            ›
          </button>
        </div>

        <button className="pres-mode__exit" onClick={onClose}>✕ Quitter</button>
      </div>

      {/* Keyboard hint */}
      <div className="pres-mode__hint-bar">
        ← → pour naviguer · Échap pour quitter
      </div>
    </div>
  );
}
