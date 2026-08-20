/**
 * Compact persona picker for chat surfaces (chantier #17). Shows the active
 * persona's name as a button; clicking opens a small menu to switch, create,
 * rename, or delete personas. Backed by lib/personas.ts (localStorage).
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Plus, Check, Pencil, Trash2, User } from 'lucide-react';
import {
  Persona, listPersonas, createPersona, updatePersona, deletePersona,
  getActivePersonaId, setActivePersonaId,
} from '../lib/personas';
import './PersonaPicker.scss';

interface Props {
  /** Called whenever the active persona changes (including to null). */
  onChange?: (persona: Persona | null) => void;
}

export default function PersonaPicker({ onChange }: Props) {
  const { t } = useTranslation();
  const [personas, setPersonas] = useState<Persona[]>(() => listPersonas());
  const [activeId, setActiveId] = useState<string | null>(() => getActivePersonaId());
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Persona | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftInstructions, setDraftInstructions] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) { setOpen(false); setEditing(null); }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const active = personas.find(p => p.id === activeId) ?? null;

  const select = useCallback((id: string | null) => {
    setActiveId(id);
    setActivePersonaId(id);
    onChange?.(personas.find(p => p.id === id) ?? null);
    setOpen(false);
  }, [personas, onChange]);

  const startCreate = () => { setEditing({ id: '', name: '', instructions: '' }); setDraftName(''); setDraftInstructions(''); };
  const startEdit = (p: Persona) => { setEditing(p); setDraftName(p.name); setDraftInstructions(p.instructions); };

  const saveDraft = () => {
    if (!draftName.trim()) return;
    if (editing && editing.id) {
      updatePersona(editing.id, { name: draftName, instructions: draftInstructions });
      setPersonas(listPersonas());
    } else {
      const created = createPersona(draftName, draftInstructions);
      setPersonas(listPersonas());
      select(created.id);
    }
    setEditing(null);
  };

  const removePersona = (id: string) => {
    deletePersona(id);
    setPersonas(listPersonas());
    if (activeId === id) { setActiveId(null); onChange?.(null); }
  };

  return (
    <div className="persona-picker" ref={rootRef}>
      <button
        className={`persona-picker__trigger${active ? ' persona-picker__trigger--active' : ''}`}
        onClick={() => { setOpen(v => !v); setEditing(null); }}
        title={t('ai.personaTitle', { defaultValue: 'Persona' })}
      >
        <User size={12} />
        <span>{active?.name ?? t('ai.personaNone', { defaultValue: 'Assistant' })}</span>
        <ChevronDown size={11} />
      </button>

      {open && (
        <div className="persona-picker__menu">
          {editing ? (
            <div className="persona-picker__editor">
              <input
                className="persona-picker__editor-name"
                placeholder={t('ai.personaNamePlaceholder', { defaultValue: 'Nom (ex : Rédacteur concis)' })}
                value={draftName}
                onChange={e => setDraftName(e.target.value)}
                maxLength={40}
                autoFocus
              />
              <textarea
                className="persona-picker__editor-instructions"
                placeholder={t('ai.personaInstructionsPlaceholder', { defaultValue: 'Instructions : comment l\'assistant doit se comporter…' })}
                value={draftInstructions}
                onChange={e => setDraftInstructions(e.target.value)}
                rows={4}
                maxLength={4000}
              />
              <div className="persona-picker__editor-actions">
                <button onClick={() => setEditing(null)}>{t('ai.personaCancel', { defaultValue: 'Annuler' })}</button>
                <button className="primary" onClick={saveDraft} disabled={!draftName.trim()}>
                  {t('ai.personaSave', { defaultValue: 'Enregistrer' })}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div
                className={`persona-picker__item${!activeId ? ' active' : ''}`}
                onClick={() => select(null)}
              >
                {!activeId && <Check size={12} />}
                <span>{t('ai.personaNone', { defaultValue: 'Assistant' })}</span>
              </div>
              {personas.map(p => (
                <div key={p.id} className={`persona-picker__item${p.id === activeId ? ' active' : ''}`}>
                  <div className="persona-picker__item-main" onClick={() => select(p.id)}>
                    {p.id === activeId && <Check size={12} />}
                    <span>{p.name}</span>
                  </div>
                  <button className="persona-picker__item-action" onClick={() => startEdit(p)} title={t('ai.personaEdit', { defaultValue: 'Modifier' })}>
                    <Pencil size={11} />
                  </button>
                  <button className="persona-picker__item-action persona-picker__item-action--danger" onClick={() => removePersona(p.id)} title={t('ai.personaDelete', { defaultValue: 'Supprimer' })}>
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
              <button className="persona-picker__add" onClick={startCreate}>
                <Plus size={12} /> {t('ai.personaAdd', { defaultValue: 'Ajouter une persona' })}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
