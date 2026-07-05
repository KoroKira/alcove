import React, { useCallback, useRef, useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import type { Tab } from '../hooks/usePadTabs';
import DocumentPad from '../pad/DocumentPad';
import './SplitDocPanel.scss';

interface Props {
  tabs: Tab[];
  docTabId: string;
  onChangeDoc: (id: string) => void;
  onClose: () => void;
}

const SplitDocPanel: React.FC<Props> = ({ tabs, docTabId, onChangeDoc, onClose }) => {
  const [width, setWidth] = useState(400);
  const [pickerOpen, setPickerOpen] = useState(false);
  const dragStartX = useRef<number | null>(null);
  const dragStartW = useRef<number>(400);

  const docTabs = tabs.filter(t => t.padType === 'document');
  const currentTab = tabs.find(t => t.id === docTabId);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStartX.current = e.clientX;
    dragStartW.current = width;
    const onMove = (ev: MouseEvent) => {
      const delta = dragStartX.current! - ev.clientX;
      setWidth(Math.max(280, Math.min(900, dragStartW.current + delta)));
    };
    const onUp = () => {
      dragStartX.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [width]);

  return (
    <div className="split-panel" style={{ width }}>
      <div className="split-panel__resize" onMouseDown={onMouseDown} />
      <div className="split-panel__header">
        <button
          className="split-panel__tab-btn"
          onClick={() => setPickerOpen(v => !v)}
        >
          <span className="split-panel__tab-title">{currentTab?.title || 'Document'}</span>
          <ChevronDown size={12} />
        </button>
        {pickerOpen && (
          <div className="split-panel__picker">
            {docTabs.map(t => (
              <button
                key={t.id}
                className={`split-panel__picker-item${t.id === docTabId ? ' split-panel__picker-item--active' : ''}`}
                onClick={() => { onChangeDoc(t.id); setPickerOpen(false); }}
              >
                {t.title}
              </button>
            ))}
            {docTabs.length === 0 && (
              <span className="split-panel__picker-empty">Aucun document</span>
            )}
          </div>
        )}
        <button className="split-panel__close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="split-panel__body">
        <DocumentPad
          padId={docTabId}
          theme={currentTab?.theme || 'dark'}
          tabs={tabs}
        />
      </div>
    </div>
  );
};

export default SplitDocPanel;
