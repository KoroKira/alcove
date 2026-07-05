/**
 * Reusable field components: schema editor + value editor
 */
import React, { useState } from 'react';
import { Plus, Trash2, ChevronDown, GripVertical, ExternalLink } from 'lucide-react';
import type { FieldDef, FieldValue, FieldType, Attachment } from './fieldTypes';
import { uid, FIELD_TYPE_LABELS, getFieldValue, setFieldValue } from './fieldTypes';
import './FieldEditor.scss';

/* ── Schema editor (board-level: add/remove/rename fields) ── */

interface SchemaEditorProps {
  schema: FieldDef[];
  onChange: (schema: FieldDef[]) => void;
}

export function SchemaEditor({ schema, onChange }: SchemaEditorProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ name: string; type: FieldType; options: string }>({
    name: '', type: 'text', options: '',
  });

  const addField = () => {
    if (!draft.name.trim()) return;
    const field: FieldDef = {
      id: uid(),
      name: draft.name.trim(),
      type: draft.type,
      options: draft.type === 'select' ? draft.options.split(',').map(s => s.trim()).filter(Boolean) : undefined,
    };
    onChange([...schema, field]);
    setDraft({ name: '', type: 'text', options: '' });
    setAdding(false);
  };

  const removeField = (id: string) => onChange(schema.filter(f => f.id !== id));

  const renameField = (id: string, name: string) =>
    onChange(schema.map(f => f.id === id ? { ...f, name } : f));

  return (
    <div className="schema-editor">
      <div className="schema-editor__list">
        {schema.map(field => (
          <div key={field.id} className="schema-editor__row">
            <GripVertical size={12} className="schema-editor__grip" />
            <input
              className="schema-editor__name"
              value={field.name}
              onChange={e => renameField(field.id, e.target.value)}
            />
            <span className="schema-editor__type">{FIELD_TYPE_LABELS[field.type]}</span>
            <button className="schema-editor__del" onClick={() => removeField(field.id)}>
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>

      {adding ? (
        <div className="schema-editor__add-form">
          <input
            autoFocus
            placeholder="Nom du champ"
            value={draft.name}
            onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
            className="schema-editor__input"
            onKeyDown={e => { if (e.key === 'Enter') addField(); if (e.key === 'Escape') setAdding(false); }}
          />
          <select
            value={draft.type}
            onChange={e => setDraft(d => ({ ...d, type: e.target.value as FieldType }))}
            className="schema-editor__type-sel"
          >
            {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map(t => (
              <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>
            ))}
          </select>
          {draft.type === 'select' && (
            <input
              placeholder="Options (séparées par virgule)"
              value={draft.options}
              onChange={e => setDraft(d => ({ ...d, options: e.target.value }))}
              className="schema-editor__input"
            />
          )}
          <div className="schema-editor__add-actions">
            <button className="schema-editor__btn schema-editor__btn--primary" onClick={addField}>
              Ajouter
            </button>
            <button className="schema-editor__btn" onClick={() => setAdding(false)}>
              Annuler
            </button>
          </div>
        </div>
      ) : (
        <button className="schema-editor__new" onClick={() => setAdding(true)}>
          <Plus size={12} /> Nouveau champ
        </button>
      )}
    </div>
  );
}

/* ── Field value row (single field display + edit) ── */

interface FieldValueRowProps {
  field: FieldDef;
  values: FieldValue[];
  onChange: (values: FieldValue[]) => void;
}

export function FieldValueRow({ field, values, onChange }: FieldValueRowProps) {
  const val = getFieldValue(values, field.id);
  const set = (v: string | number | boolean | null) =>
    onChange(setFieldValue(values, field.id, v));

  let input: React.ReactNode;

  switch (field.type) {
    case 'text':
      input = (
        <input
          className="field-val__input"
          value={(val as string) ?? ''}
          placeholder="—"
          onChange={e => set(e.target.value)}
        />
      );
      break;
    case 'number':
      input = (
        <input
          className="field-val__input field-val__input--num"
          type="number"
          value={(val as number) ?? ''}
          placeholder="—"
          onChange={e => set(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
      break;
    case 'date':
      input = (
        <input
          className="field-val__input field-val__input--date"
          type="date"
          value={(val as string) ?? ''}
          onChange={e => set(e.target.value || null)}
        />
      );
      break;
    case 'checkbox':
      input = (
        <input
          type="checkbox"
          className="field-val__checkbox"
          checked={!!val}
          onChange={e => set(e.target.checked)}
        />
      );
      break;
    case 'select':
      input = (
        <select
          className="field-val__select"
          value={(val as string) ?? ''}
          onChange={e => set(e.target.value || null)}
        >
          <option value="">—</option>
          {(field.options ?? []).map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      );
      break;
    case 'url':
      input = (
        <div className="field-val__url-row">
          <input
            className="field-val__input"
            value={(val as string) ?? ''}
            placeholder="https://…"
            onChange={e => set(e.target.value || null)}
          />
          {val && (
            <a href={val as string} target="_blank" rel="noreferrer" className="field-val__url-open">
              <ExternalLink size={12} />
            </a>
          )}
        </div>
      );
      break;
  }

  return (
    <div className="field-val__row">
      <span className="field-val__label">{field.name}</span>
      <div className="field-val__control">{input}</div>
    </div>
  );
}

/* ── Attachment list ── */

interface AttachmentListProps {
  attachments: Attachment[];
  onChange: (a: Attachment[]) => void;
}

export function AttachmentList({ attachments, onChange }: AttachmentListProps) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');

  const add = () => {
    if (!url.trim()) return;
    const att: Attachment = { id: uid(), name: name.trim() || url, url: url.trim() };
    onChange([...attachments, att]);
    setUrl(''); setName(''); setAdding(false);
  };

  return (
    <div className="attach-list">
      {attachments.map(a => (
        <div key={a.id} className="attach-list__item">
          <a href={a.url} target="_blank" rel="noreferrer" className="attach-list__link">
            <ExternalLink size={11} /> {a.name}
          </a>
          <button className="attach-list__del" onClick={() => onChange(attachments.filter(x => x.id !== a.id))}>
            <Trash2 size={11} />
          </button>
        </div>
      ))}

      {adding ? (
        <div className="attach-list__form">
          <input autoFocus placeholder="URL" value={url} onChange={e => setUrl(e.target.value)}
            className="attach-list__input" onKeyDown={e => { if (e.key === 'Enter') add(); if (e.key === 'Escape') setAdding(false); }} />
          <input placeholder="Nom (optionnel)" value={name} onChange={e => setName(e.target.value)}
            className="attach-list__input" onKeyDown={e => { if (e.key === 'Enter') add(); }} />
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="schema-editor__btn schema-editor__btn--primary" onClick={add}>Ajouter</button>
            <button className="schema-editor__btn" onClick={() => setAdding(false)}>Annuler</button>
          </div>
        </div>
      ) : (
        <button className="attach-list__new" onClick={() => setAdding(true)}>
          <Plus size={11} /> Ajouter un lien
        </button>
      )}
    </div>
  );
}
