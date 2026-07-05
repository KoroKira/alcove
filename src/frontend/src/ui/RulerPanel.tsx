import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { ExcalidrawImperativeAPI, AppState } from '@atyrode/excalidraw/types';
import type { ExcalidrawElement } from '@atyrode/excalidraw/element/types';
import './RulerPanel.scss';

const DEFAULT_PX_PER_CM = 37.795275591; // 96 DPI standard

interface Bounds {
  x: number; y: number; w: number; h: number;
}

const getBounds = (elements: readonly ExcalidrawElement[]): Bounds | null => {
  const visible = elements.filter(el => !el.isDeleted);
  if (!visible.length) return null;
  const xs = visible.flatMap(e => [e.x, e.x + (e.width ?? 0)]);
  const ys = visible.flatMap(e => [e.y, e.y + (e.height ?? 0)]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};

const px2cm = (px: number, pxPerCm: number) => (px / pxPerCm).toFixed(2);
const cm2px = (cm: number, pxPerCm: number) => cm * pxPerCm;

interface Props {
  excalidrawAPI: ExcalidrawImperativeAPI;
}

const RulerPanel: React.FC<Props> = ({ excalidrawAPI }) => {
  const [pxPerCm, setPxPerCm] = useState(DEFAULT_PX_PER_CM);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [wInput, setWInput] = useState('');
  const [hInput, setHInput] = useState('');
  const [editingDpi, setEditingDpi] = useState(false);
  const [dpiInput, setDpiInput] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const lastAppState = useRef<AppState | null>(null);

  const refresh = useCallback((elements: readonly ExcalidrawElement[], appState: AppState) => {
    const ids = Object.keys(appState.selectedElementIds ?? {});
    setSelectedIds(ids);
    if (!ids.length) { setBounds(null); return; }
    const sel = elements.filter(e => ids.includes(e.id) && !e.isDeleted);
    const b = getBounds(sel);
    setBounds(b);
    if (b) {
      setWInput(px2cm(b.w, pxPerCm));
      setHInput(px2cm(b.h, pxPerCm));
    }
    lastAppState.current = appState;
  }, [pxPerCm]);

  useEffect(() => {
    const unsub = excalidrawAPI.onChange((elements, appState) => {
      refresh(elements, appState);
    });
    return () => unsub();
  }, [excalidrawAPI, refresh]);

  if (!bounds || !selectedIds.length) return null;

  const applySize = (newWcm: string, newHcm: string) => {
    const wCm = parseFloat(newWcm);
    const hCm = parseFloat(newHcm);
    if (isNaN(wCm) || isNaN(hCm) || wCm <= 0 || hCm <= 0) return;
    const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
    const sel = elements.filter(e => selectedIds.includes(e.id) && !e.isDeleted);
    if (!sel.length || !bounds) return;

    const scaleW = cm2px(wCm, pxPerCm) / bounds.w;
    const scaleH = cm2px(hCm, pxPerCm) / bounds.h;

    const updated = elements.map(el => {
      if (!selectedIds.includes(el.id) || el.isDeleted) return el;
      const dx = el.x - bounds.x;
      const dy = el.y - bounds.y;
      return {
        ...el,
        x: bounds.x + dx * scaleW,
        y: bounds.y + dy * scaleH,
        width: (el.width ?? 0) * scaleW,
        height: (el.height ?? 0) * scaleH,
        version: (el.version ?? 0) + 1,
        versionNonce: Math.floor(Math.random() * 1e9),
        updated: Date.now(),
      };
    });
    excalidrawAPI.updateScene({ elements: updated as any });
  };

  const handleDpiApply = () => {
    const v = parseFloat(dpiInput);
    if (!isNaN(v) && v > 0) setPxPerCm(v / 2.54);
    setEditingDpi(false);
  };

  const dpi = Math.round(pxPerCm * 2.54);

  return (
    <div className="ruler-panel">
      <div className="ruler-panel__title">
        Mesures
        <button
          className="ruler-panel__dpi-btn"
          title={`Résolution : ${dpi} DPI`}
          onClick={() => { setEditingDpi(v => !v); setDpiInput(String(dpi)); }}
        >
          {dpi} DPI
        </button>
      </div>
      {editingDpi && (
        <div className="ruler-panel__row">
          <input
            className="ruler-panel__input"
            value={dpiInput}
            onChange={e => setDpiInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleDpiApply()}
            placeholder="DPI"
            autoFocus
          />
          <button className="ruler-panel__apply" onClick={handleDpiApply}>OK</button>
        </div>
      )}
      <div className="ruler-panel__row">
        <label className="ruler-panel__label">L</label>
        <input
          className="ruler-panel__input"
          value={wInput}
          onChange={e => setWInput(e.target.value)}
          onBlur={() => applySize(wInput, hInput)}
          onKeyDown={e => e.key === 'Enter' && applySize(wInput, hInput)}
        />
        <span className="ruler-panel__unit">cm</span>
      </div>
      <div className="ruler-panel__row">
        <label className="ruler-panel__label">H</label>
        <input
          className="ruler-panel__input"
          value={hInput}
          onChange={e => setHInput(e.target.value)}
          onBlur={() => applySize(wInput, hInput)}
          onKeyDown={e => e.key === 'Enter' && applySize(wInput, hInput)}
        />
        <span className="ruler-panel__unit">cm</span>
      </div>
      <div className="ruler-panel__info">
        {px2cm(bounds.w, pxPerCm)} × {px2cm(bounds.h, pxPerCm)} cm
      </div>
    </div>
  );
};

export default RulerPanel;
