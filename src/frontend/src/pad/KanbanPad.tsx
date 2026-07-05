import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  Plus, X, GripVertical, Trash2, Bookmark, ChevronDown,
  Paperclip, Calendar,
} from 'lucide-react';
import { FieldValueRow, AttachmentList } from './FieldEditor';
import type { FieldDef, FieldValue, FieldType, Attachment, Priority } from './fieldTypes';
import { uid, PRIORITY_LABELS, PRIORITY_COLORS, FIELD_TYPE_LABELS } from './fieldTypes';
import './KanbanPad.scss';

/* ─── Data types ─── */

export interface KanbanCard {
  id: string;
  title: string;
  desc?: string;
  color?: string;
  priority?: Priority;
  dueDate?: string;
  labels?: string[];
  fields?: FieldValue[];
  attachments?: Attachment[];
}

export interface KanbanColumn {
  id: string;
  title: string;
  color?: string;
  cards: KanbanCard[];
}

export interface KanbanCardTemplate {
  id: string;
  name: string;
  card: Omit<KanbanCard, 'id'>;
}

export interface KanbanData {
  columns: KanbanColumn[];
  fieldSchema?: FieldDef[];
  cardTemplates?: KanbanCardTemplate[];
}

interface Props {
  padId: string;
  data: KanbanData;
  onDataChange: (data: KanbanData) => void;
}

/* ─── Constants ─── */

const CARD_COLORS = ['', '#f38ba8', '#fab387', '#f9e2af', '#a6e3a1', '#89dceb', '#89b4fa', '#cba6f7'];
const SAVE_DEBOUNCE = 600;
const PRIORITIES: Priority[] = ['none', 'low', 'medium', 'high', 'urgent'];

/* ─── Helpers ─── */

function formatDate(d: string) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
}

function isOverdue(d: string) {
  return d && new Date(d + 'T00:00:00') < new Date();
}

/* ─── Card modal ─── */

interface CardModalProps {
  card: KanbanCard;
  schema: FieldDef[];
  templates: KanbanCardTemplate[];
  onSave: (card: KanbanCard) => void;
  onDelete: () => void;
  onSaveAsTemplate: (name: string, card: KanbanCard) => void;
  onSchemaChange: (schema: FieldDef[]) => void;
  onClose: () => void;
}

function CardModal({ card, schema, templates, onSave, onDelete, onSaveAsTemplate, onSchemaChange, onClose }: CardModalProps) {
  const [draft, setDraft] = useState<KanbanCard>({ ...card });
  const [saveTplName, setSaveTplName] = useState('');
  const [showSaveTpl, setShowSaveTpl] = useState(false);
  // Inline add-field form
  const [addingField, setAddingField] = useState(false);
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldType, setNewFieldType] = useState<FieldType>('text');
  const [newFieldOptions, setNewFieldOptions] = useState('');

  const upd = (patch: Partial<KanbanCard>) => setDraft(d => ({ ...d, ...patch }));
  const handleSave = () => { onSave(draft); onClose(); };

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) handleSave();
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') handleSave(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [draft]);

  const commitNewField = () => {
    if (!newFieldName.trim()) return;
    const field: FieldDef = {
      id: uid(), name: newFieldName.trim(), type: newFieldType,
      options: newFieldType === 'select' ? newFieldOptions.split(',').map(s => s.trim()).filter(Boolean) : undefined,
    };
    onSchemaChange([...schema, field]);
    setNewFieldName(''); setNewFieldType('text'); setNewFieldOptions(''); setAddingField(false);
  };

  const overdue = draft.dueDate && isOverdue(draft.dueDate);

  return (
    <div className="card-modal__backdrop" onClick={handleBackdrop}>
      <div className="card-modal" onClick={e => e.stopPropagation()}>
        {/* Header: priority + close */}
        <div className="card-modal__header">
          <select
            className="card-modal__priority-sel"
            value={draft.priority ?? 'none'}
            onChange={e => upd({ priority: e.target.value as Priority })}
            style={{ borderLeftColor: PRIORITY_COLORS[draft.priority ?? 'none'] }}
          >
            {PRIORITIES.map(p => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
          </select>
          <button className="card-modal__close" onClick={handleSave}><X size={15} /></button>
        </div>

        {/* Title */}
        <textarea
          className="card-modal__title"
          value={draft.title}
          onChange={e => upd({ title: e.target.value })}
          placeholder="Titre de la carte"
          rows={2}
          autoFocus
        />

        {/* Color strip */}
        <div className="card-modal__colors">
          {CARD_COLORS.map(c => (
            <button
              key={c || 'none'}
              className={`card-modal__color-dot${draft.color === c ? ' card-modal__color-dot--active' : ''}`}
              style={{ background: c || 'var(--color-surface-high, #45475a)' }}
              onClick={() => upd({ color: c || undefined })}
            />
          ))}
        </div>

        {/* Description */}
        <div className="card-modal__section">
          <div className="card-modal__section-label">Description</div>
          <textarea
            className="card-modal__desc"
            value={draft.desc ?? ''}
            onChange={e => upd({ desc: e.target.value })}
            placeholder="Ajouter une description…"
            rows={3}
          />
        </div>

        {/* Due date */}
        <div className="card-modal__prop-row">
          <span className="card-modal__prop-label"><Calendar size={11} /> Échéance</span>
          <div className="card-modal__due-row">
            <input
              type="date"
              className={`card-modal__date-input${overdue ? ' card-modal__date-input--overdue' : ''}`}
              value={draft.dueDate ?? ''}
              onChange={e => upd({ dueDate: e.target.value || undefined })}
            />
            {draft.dueDate && (
              <button className="card-modal__date-clear" onClick={() => upd({ dueDate: undefined })}><X size={10} /></button>
            )}
          </div>
        </div>

        {/* ── Propriétés (champs custom + bouton ajouter) ── */}
        <div className="card-modal__section">
          <div className="card-modal__section-label">Propriétés</div>

          {/* Existing fields */}
          {schema.map(field => (
            <FieldValueRow
              key={field.id}
              field={field}
              values={draft.fields ?? []}
              onChange={fields => upd({ fields })}
            />
          ))}

          {/* Inline add field form */}
          {addingField ? (
            <div className="card-modal__add-field-form">
              <input
                autoFocus
                placeholder="Nom de la propriété"
                value={newFieldName}
                onChange={e => setNewFieldName(e.target.value)}
                className="card-modal__field-input"
                onKeyDown={e => { if (e.key === 'Enter') commitNewField(); if (e.key === 'Escape') setAddingField(false); }}
              />
              <select value={newFieldType} onChange={e => setNewFieldType(e.target.value as FieldType)} className="card-modal__field-type">
                {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map(t => (
                  <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>
                ))}
              </select>
              {newFieldType === 'select' && (
                <input
                  placeholder="Options séparées par virgule"
                  value={newFieldOptions}
                  onChange={e => setNewFieldOptions(e.target.value)}
                  className="card-modal__field-input"
                />
              )}
              <div style={{ display: 'flex', gap: 5 }}>
                <button className="card-modal__tpl-btn" onClick={commitNewField}>Ajouter</button>
                <button className="card-modal__action-btn" onClick={() => setAddingField(false)}>Annuler</button>
              </div>
            </div>
          ) : (
            <button className="card-modal__add-prop-btn" onClick={() => setAddingField(true)}>
              <Plus size={12} /> Ajouter une propriété
            </button>
          )}
        </div>

        {/* Attachments */}
        <div className="card-modal__section">
          <div className="card-modal__section-label"><Paperclip size={12} /> Pièces jointes</div>
          <AttachmentList
            attachments={draft.attachments ?? []}
            onChange={attachments => upd({ attachments })}
          />
        </div>

        {/* Footer */}
        <div className="card-modal__footer">
          <div className="card-modal__footer-left">
            {showSaveTpl ? (
              <div className="card-modal__save-tpl">
                <input
                  autoFocus placeholder="Nom du modèle" value={saveTplName}
                  onChange={e => setSaveTplName(e.target.value)}
                  className="card-modal__tpl-input"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && saveTplName.trim()) { onSaveAsTemplate(saveTplName.trim(), draft); setSaveTplName(''); setShowSaveTpl(false); }
                    if (e.key === 'Escape') setShowSaveTpl(false);
                  }}
                />
                <button className="card-modal__tpl-btn"
                  onClick={() => { if (saveTplName.trim()) { onSaveAsTemplate(saveTplName.trim(), draft); setSaveTplName(''); setShowSaveTpl(false); } }}>
                  Enregistrer
                </button>
              </div>
            ) : (
              <button className="card-modal__action-btn" onClick={() => setShowSaveTpl(true)}>
                <Bookmark size={12} /> Enregistrer comme modèle
              </button>
            )}
          </div>
          <button className="card-modal__delete-btn" onClick={() => { onDelete(); onClose(); }}>
            <Trash2 size={12} /> Supprimer
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Card component (compact view) ─── */

function Card({
  card, colId, onEdit, onDelete, onDragStart, onDragEnd, schema,
}: {
  card: KanbanCard;
  colId: string;
  onEdit: () => void;
  onDelete: () => void;
  onDragStart: (cardId: string, fromColId: string) => void;
  onDragEnd: () => void;
  schema: FieldDef[];
}) {
  const priority = card.priority ?? 'none';
  const priorityColor = PRIORITY_COLORS[priority];
  const overdue = card.dueDate && isOverdue(card.dueDate);

  return (
    <div
      className="kanban__card"
      style={{
        borderLeftColor: card.color || (priority !== 'none' ? priorityColor : 'transparent'),
      }}
      draggable
      onDragStart={e => { e.stopPropagation(); onDragStart(card.id, colId); }}
      onDragEnd={onDragEnd}
      onClick={onEdit}
    >
      <div className="kanban__card-top">
        <GripVertical size={12} className="kanban__card-grip" onClick={e => e.stopPropagation()} />
        <span className="kanban__card-title">{card.title}</span>
        <button
          className="kanban__card-del"
          onClick={e => { e.stopPropagation(); onDelete(); }}
          title="Supprimer"
        >
          <X size={11} />
        </button>
      </div>

      {/* Meta row: due date, attachment count, desc indicator */}
      {(card.dueDate || (card.attachments?.length ?? 0) > 0 || card.desc) && (
        <div className="kanban__card-meta">
          {card.dueDate && (
            <span className={`kanban__card-due${overdue ? ' kanban__card-due--overdue' : ''}`}>
              <Calendar size={10} /> {formatDate(card.dueDate)}
            </span>
          )}
          {(card.attachments?.length ?? 0) > 0 && (
            <span className="kanban__card-att"><Paperclip size={10} /> {card.attachments!.length}</span>
          )}
        </div>
      )}

      {/* Custom field previews (first 2 with values) */}
      {schema.filter(f => {
        const v = card.fields?.find(fv => fv.fieldId === f.id)?.value;
        return v !== null && v !== undefined && v !== '';
      }).slice(0, 2).map(f => {
        const v = card.fields?.find(fv => fv.fieldId === f.id)?.value;
        return (
          <div key={f.id} className="kanban__card-field">
            <span className="kanban__card-field-name">{f.name}</span>
            <span className="kanban__card-field-val">
              {f.type === 'checkbox' ? (v ? '✓' : '✗') : String(v)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Column component ─── */

function Column({
  col, schema, templates, onUpdate, onDelete, onAddCard, onAddFromTemplate,
  onUpdateCard, onDeleteCard,
  onDragStart, onDragEnd, onDrop,
  dragOver, onDragOver, onDragLeave,
  onOpenCard,
}: {
  col: KanbanColumn;
  schema: FieldDef[];
  templates: KanbanCardTemplate[];
  onUpdate: (c: KanbanColumn) => void;
  onDelete: () => void;
  onAddCard: () => void;
  onAddFromTemplate: (tpl: KanbanCardTemplate) => void;
  onUpdateCard: (card: KanbanCard) => void;
  onDeleteCard: (cardId: string) => void;
  onDragStart: (cardId: string, fromColId: string) => void;
  onDragEnd: () => void;
  onDrop: (toColId: string) => void;
  dragOver: boolean;
  onDragOver: (colId: string) => void;
  onDragLeave: () => void;
  onOpenCard: (card: KanbanCard) => void;
}) {
  const [editTitle, setEditTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(col.title);
  const [showTplMenu, setShowTplMenu] = useState(false);

  const commitTitle = () => {
    if (titleDraft.trim()) onUpdate({ ...col, title: titleDraft.trim() });
    else setTitleDraft(col.title);
    setEditTitle(false);
  };

  return (
    <div
      className={`kanban__column${dragOver ? ' kanban__column--drag-over' : ''}`}
      onDragOver={e => { e.preventDefault(); onDragOver(col.id); }}
      onDragLeave={onDragLeave}
      onDrop={e => { e.preventDefault(); onDrop(col.id); }}
    >
      <div className="kanban__col-header">
        {editTitle ? (
          <input
            autoFocus
            className="kanban__col-title kanban__inline-input"
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={e => { if (e.key === 'Enter') commitTitle(); if (e.key === 'Escape') { setTitleDraft(col.title); setEditTitle(false); } }}
          />
        ) : (
          <span className="kanban__col-title" onDoubleClick={() => setEditTitle(true)}>{col.title}</span>
        )}
        <span className="kanban__col-count">{col.cards.length}</span>
        <button className="kanban__col-del" onClick={onDelete} title="Supprimer">
          <Trash2 size={12} />
        </button>
      </div>

      <div className="kanban__cards">
        {col.cards.map(card => (
          <Card
            key={card.id}
            card={card}
            colId={col.id}
            schema={schema}
            onEdit={() => onOpenCard(card)}
            onDelete={() => onDeleteCard(card.id)}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
      </div>

      <div className="kanban__add-row">
        <button className="kanban__add-card" onClick={onAddCard}>
          <Plus size={13} /> Ajouter
        </button>
        {templates.length > 0 && (
          <div className="kanban__tpl-wrap">
            <button
              className="kanban__tpl-btn"
              onClick={() => setShowTplMenu(v => !v)}
              title="Depuis un modèle"
            >
              <Bookmark size={12} /> <ChevronDown size={10} />
            </button>
            {showTplMenu && (
              <div className="kanban__tpl-menu">
                {templates.map(tpl => (
                  <button
                    key={tpl.id}
                    className="kanban__tpl-item"
                    onClick={() => { onAddFromTemplate(tpl); setShowTplMenu(false); }}
                  >
                    {tpl.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Main KanbanPad ─── */

export default function KanbanPad({ padId, data, onDataChange }: Props) {
  const [columns, setColumns] = useState<KanbanColumn[]>(data.columns ?? []);
  const [schema, setSchema] = useState<FieldDef[]>(data.fieldSchema ?? []);
  const [templates, setTemplates] = useState<KanbanCardTemplate[]>(data.cardTemplates ?? []);
  const [openCard, setOpenCard] = useState<KanbanCard | null>(null);
  const [openCardColId, setOpenCardColId] = useState<string | null>(null);
  const [dragCard, setDragCard] = useState<{ cardId: string; fromColId: string } | null>(null);
  const [dragOverColId, setDragOverColId] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useCallback((cols: KanbanColumn[], sc: FieldDef[], tpls: KanbanCardTemplate[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const d: KanbanData = { columns: cols, fieldSchema: sc, cardTemplates: tpls };
      onDataChange(d);
      fetch(`/api/pad/${padId}/data`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: d }),
      }).catch(console.error);
    }, SAVE_DEBOUNCE);
  }, [padId, onDataChange]);

  const update = (cols: KanbanColumn[], sc = schema, tpls = templates) => {
    setColumns(cols); save(cols, sc, tpls);
  };

  const updateSchema = (sc: FieldDef[]) => { setSchema(sc); save(columns, sc, templates); };
  const updateTemplates = (tpls: KanbanCardTemplate[]) => { setTemplates(tpls); save(columns, schema, tpls); };

  const addColumn = () => {
    const col: KanbanColumn = { id: uid(), title: 'Nouvelle colonne', cards: [] };
    update([...columns, col]);
  };

  const updateColumn = (col: KanbanColumn) => update(columns.map(c => c.id === col.id ? col : c));
  const deleteColumn = (colId: string) => update(columns.filter(c => c.id !== colId));

  const addCard = (colId: string) => {
    const card: KanbanCard = { id: uid(), title: 'Nouvelle carte', priority: 'none', fields: [], attachments: [] };
    update(columns.map(c => c.id === colId ? { ...c, cards: [...c.cards, card] } : c));
    setOpenCard(card);
    setOpenCardColId(colId);
  };

  const addFromTemplate = (colId: string, tpl: KanbanCardTemplate) => {
    const card: KanbanCard = { ...tpl.card, id: uid() };
    update(columns.map(c => c.id === colId ? { ...c, cards: [...c.cards, card] } : c));
  };

  const updateCard = (colId: string, updated: KanbanCard) => {
    const next = columns.map(c =>
      c.id === colId ? { ...c, cards: c.cards.map(k => k.id === updated.id ? updated : k) } : c
    );
    setOpenCard(updated);
    update(next);
  };

  const deleteCard = (colId: string, cardId: string) => {
    update(columns.map(c => c.id === colId ? { ...c, cards: c.cards.filter(k => k.id !== cardId) } : c));
  };

  const handleDrop = (toColId: string) => {
    if (!dragCard) return;
    const { cardId, fromColId } = dragCard;
    if (fromColId === toColId) { setDragCard(null); setDragOverColId(null); return; }
    let moved: KanbanCard | undefined;
    const next = columns
      .map(c => {
        if (c.id === fromColId) { moved = c.cards.find(k => k.id === cardId); return { ...c, cards: c.cards.filter(k => k.id !== cardId) }; }
        return c;
      })
      .map(c => c.id === toColId && moved ? { ...c, cards: [...c.cards, moved!] } : c);
    setDragCard(null); setDragOverColId(null);
    update(next);
  };

  const saveAsTemplate = (name: string, card: KanbanCard) => {
    const { id, ...rest } = card;
    const tpl: KanbanCardTemplate = { id: uid(), name, card: rest };
    updateTemplates([...templates, tpl]);
  };

  return (
    <div className="kanban">
      <div className="kanban__main">
        {/* Board */}
        <div className="kanban__board">
          {columns.map(col => (
            <Column
              key={col.id}
              col={col}
              schema={schema}
              templates={templates}
              onUpdate={updateColumn}
              onDelete={() => deleteColumn(col.id)}
              onAddCard={() => addCard(col.id)}
              onAddFromTemplate={tpl => addFromTemplate(col.id, tpl)}
              onUpdateCard={card => updateCard(col.id, card)}
              onDeleteCard={cardId => deleteCard(col.id, cardId)}
              onDragStart={(cardId, fromColId) => setDragCard({ cardId, fromColId })}
              onDragEnd={() => { setDragCard(null); setDragOverColId(null); }}
              onDrop={handleDrop}
              dragOver={dragOverColId === col.id}
              onDragOver={setDragOverColId}
              onDragLeave={() => setDragOverColId(null)}
              onOpenCard={card => { setOpenCard(card); setOpenCardColId(col.id); }}
            />
          ))}

          <button className="kanban__add-col" onClick={addColumn}>
            <Plus size={16} /> Ajouter une colonne
          </button>
        </div>
      </div>

      {/* Card modal */}
      {openCard && openCardColId && (
        <CardModal
          card={openCard}
          schema={schema}
          templates={templates}
          onSave={updated => updateCard(openCardColId, updated)}
          onDelete={() => { deleteCard(openCardColId, openCard.id); setOpenCard(null); setOpenCardColId(null); }}
          onSaveAsTemplate={saveAsTemplate}
          onSchemaChange={updateSchema}
          onClose={() => { setOpenCard(null); setOpenCardColId(null); }}
        />
      )}
    </div>
  );
}
