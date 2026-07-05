import React, { useState, useEffect, useRef } from 'react';
import { X, Zap } from 'lucide-react';
import './QuickCapture.scss';

interface Props {
  scratchPadId: string | null;
  onClose: () => void;
}

export default function QuickCapture({ scratchPadId, onClose }: Props) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const save = async () => {
    if (!text.trim()) { onClose(); return; }
    setStatus('saving');
    try {
      if (scratchPadId) {
        const res = await fetch(`/api/pad/${scratchPadId}`);
        const data = await res.json();
        const current: string = data?.data?.content || '';
        const stamp = new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        const appended = current
          ? `${current}\n\n---\n*${stamp}*\n\n${text.trim()}`
          : `*${stamp}*\n\n${text.trim()}`;
        await fetch(`/api/pad/${scratchPadId}/doc`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: appended, format: 'markdown' }),
        });
      }
      setStatus('saved');
      setTimeout(onClose, 600);
    } catch {
      setStatus('idle');
    }
  };

  return (
    <div className="qc__backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="qc__panel" role="dialog" aria-modal>
        <div className="qc__header">
          <span className="qc__header-title"><Zap size={13} /> Capture rapide</span>
          <button className="qc__close" onClick={onClose} aria-label="Fermer"><X size={14} /></button>
        </div>
        <textarea
          ref={textareaRef}
          className="qc__textarea"
          placeholder="Écris ta note… (Cmd+Entrée pour sauvegarder)"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } }}
          rows={5}
        />
        <div className="qc__footer">
          <span className="qc__hint">
            {scratchPadId ? 'Ajouté au pad Scratch' : 'Aucun pad Scratch trouvé'}
          </span>
          <button
            className={`qc__save-btn${status === 'saved' ? ' qc__save-btn--ok' : ''}`}
            onClick={save}
            disabled={status === 'saving' || !scratchPadId}
          >
            {status === 'saving' ? '…' : status === 'saved' ? '✓ Sauvegardé' : 'Sauvegarder'}
          </button>
        </div>
      </div>
    </div>
  );
}
