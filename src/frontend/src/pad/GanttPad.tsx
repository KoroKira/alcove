import React, { useState, useRef, useCallback, useMemo } from 'react';
import { Plus, Trash2, Flag, Bookmark, X, ChevronDown } from 'lucide-react';
import { FieldValueRow, AttachmentList } from './FieldEditor';
import type { FieldDef, FieldValue, FieldType, Attachment, Priority } from './fieldTypes';
import { uid, PRIORITY_LABELS, PRIORITY_COLORS, FIELD_TYPE_LABELS } from './fieldTypes';
import { snapshotDomPad } from '../lib/thumbnailSnapshot';
import './GanttPad.scss';

/* ─── Types ─── */

export interface GanttTask {
  id: string;
  name: string;
  start: string;
  end: string;
  progress: number;
  color?: string;
  milestone?: boolean;
  priority?: Priority;
  assignee?: string;
  dependencies?: string[];
  fields?: FieldValue[];
  attachments?: Attachment[];
  desc?: string;
}

export interface GanttTaskTemplate {
  id: string;
  name: string;
  task: Omit<GanttTask, 'id' | 'start' | 'end'>;
}

export interface GanttData {
  tasks: GanttTask[];
  fieldSchema?: FieldDef[];
  taskTemplates?: GanttTaskTemplate[];
  updated_at?: string;
}

interface Props {
  padId: string;
  data: GanttData;
  onDataChange: (data: GanttData) => void;
}

/* ─── Utils ─── */

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => {
  const dt = new Date(d + 'T00:00:00');
  dt.setDate(dt.getDate() + n);
  return dt.toISOString().slice(0, 10);
};
const parseDate = (d: string) => new Date(d + 'T00:00:00').getTime();
const daysBetween = (a: string, b: string) => Math.round((parseDate(b) - parseDate(a)) / 86400000);

const TASK_COLORS = ['#89b4fa', '#cba6f7', '#a6e3a1', '#f9e2af', '#fab387', '#f38ba8', '#89dceb'];
const SAVE_DEBOUNCE = 600;
const ROW_H = 42;
const DAY_W = 28;
const HEADER_H = 56;
const PRIORITIES: Priority[] = ['none', 'low', 'medium', 'high', 'urgent'];

/* ─── Gantt SVG chart ─── */

function GanttChart({ tasks, viewStart, viewDays, selectedId, onSelect }: {
  tasks: GanttTask[];
  viewStart: string;
  viewDays: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const svgW = viewDays * DAY_W;
  const svgH = HEADER_H + tasks.length * ROW_H;

  const months: { label: string; x: number; w: number }[] = [];
  let cur = new Date(viewStart + 'T00:00:00');
  const endStr = addDays(viewStart, viewDays);

  while (cur.toISOString().slice(0, 10) < endStr) {
    const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    const clippedEnd = monthEnd.toISOString().slice(0, 10) < endStr ? monthEnd : new Date(endStr + 'T00:00:00');
    const offsetDays = daysBetween(viewStart, cur.toISOString().slice(0, 10));
    const widthDays = Math.ceil((clippedEnd.getTime() - cur.getTime()) / 86400000);
    months.push({
      label: cur.toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' }),
      x: offsetDays * DAY_W,
      w: widthDays * DAY_W,
    });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }

  const todayOffset = daysBetween(viewStart, today());

  return (
    <svg width={svgW} height={svgH} className="gantt__svg">
      <defs>
        <pattern id="day-grid" x="0" y={HEADER_H} width={DAY_W} height={ROW_H} patternUnits="userSpaceOnUse">
          <line x1={DAY_W} y1="0" x2={DAY_W} y2={ROW_H} stroke="rgba(69,71,90,0.4)" strokeWidth="1" />
        </pattern>
        <marker id="arrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
          <path d="M0,0 L0,6 L6,3 z" fill="rgba(137,180,250,0.6)" />
        </marker>
      </defs>

      <rect width={svgW} height={svgH} fill="var(--color-surface-lowest, #1e1e2e)" />
      <rect y={HEADER_H} width={svgW} height={svgH - HEADER_H} fill="url(#day-grid)" />

      {tasks.map((_, i) => (
        <rect key={i} x={0} y={HEADER_H + i * ROW_H} width={svgW} height={ROW_H}
          fill={i % 2 === 0 ? 'rgba(49,50,68,0.35)' : 'transparent'} />
      ))}

      {months.map((m, i) => (
        <g key={i}>
          <rect x={m.x} y={0} width={m.w} height={HEADER_H}
            fill={i % 2 === 0 ? 'var(--color-surface-mid, #313244)' : 'var(--color-surface-high, #45475a)'} />
          <line x1={m.x} y1={0} x2={m.x} y2={HEADER_H} stroke="var(--color-surface-high, #45475a)" strokeWidth="1" />
          <text x={m.x + m.w / 2} y={HEADER_H / 2 + 5} fill="var(--color-on-surface-low, #a6adc8)"
            fontSize="11" fontWeight="600" textAnchor="middle" fontFamily="inherit">
            {m.label}
          </text>
        </g>
      ))}

      {todayOffset >= 0 && todayOffset <= viewDays && (
        <line x1={todayOffset * DAY_W} y1={0} x2={todayOffset * DAY_W} y2={svgH}
          stroke="#f38ba8" strokeWidth="1.5" strokeDasharray="4 3" />
      )}

      {tasks.map((task, ti) =>
        (task.dependencies ?? []).map(depId => {
          const di = tasks.findIndex(t => t.id === depId);
          if (di < 0) return null;
          const dep = tasks[di];
          const x1 = daysBetween(viewStart, dep.end) * DAY_W;
          const y1 = HEADER_H + di * ROW_H + ROW_H / 2;
          const x2 = daysBetween(viewStart, task.start) * DAY_W;
          const y2 = HEADER_H + ti * ROW_H + ROW_H / 2;
          return (
            <path key={`${depId}-${task.id}`}
              d={`M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`}
              stroke="rgba(137,180,250,0.5)" strokeWidth="1.5" fill="none" markerEnd="url(#arrow)" />
          );
        })
      )}

      {tasks.map((task, i) => {
        const barX = daysBetween(viewStart, task.start) * DAY_W;
        const barW = Math.max(daysBetween(task.start, task.end) * DAY_W, DAY_W);
        const barY = HEADER_H + i * ROW_H + 9;
        const barH = ROW_H - 18;
        const color = task.color || TASK_COLORS[i % TASK_COLORS.length];
        const isSelected = task.id === selectedId;

        if (task.milestone) {
          const cx = (daysBetween(viewStart, task.start) + 0.5) * DAY_W;
          const cy = HEADER_H + i * ROW_H + ROW_H / 2;
          return (
            <g key={task.id} onClick={() => onSelect(task.id)} style={{ cursor: 'pointer' }}>
              <polygon points={`${cx},${cy - 10} ${cx + 10},${cy} ${cx},${cy + 10} ${cx - 10},${cy}`}
                fill={color} opacity={isSelected ? 1 : 0.85}
                stroke={isSelected ? 'white' : 'none'} strokeWidth="2" />
            </g>
          );
        }

        return (
          <g key={task.id} onClick={() => onSelect(task.id)} style={{ cursor: 'pointer' }}>
            {isSelected && (
              <rect x={barX - 2} y={barY - 2} width={barW + 4} height={barH + 4}
                rx={7} fill="none" stroke="white" strokeWidth="1.5" opacity={0.6} />
            )}
            <rect x={barX} y={barY} width={barW} height={barH} rx={5} fill={color} opacity={0.2} />
            <rect x={barX} y={barY} width={Math.max(barW * (task.progress / 100), task.progress > 0 ? 8 : 0)}
              height={barH} rx={5} fill={color} opacity={0.85} />
            <rect x={barX} y={barY} width={barW} height={barH} rx={5}
              fill="none" stroke={color} strokeWidth={isSelected ? 2 : 1.5} />
            {barW > 40 && (
              <text x={barX + 7} y={barY + barH / 2 + 4} fill="white" fontSize="10" fontWeight="600" fontFamily="inherit">
                {task.progress}%
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* ─── Task detail panel ─── */

interface TaskPanelProps {
  task: GanttTask;
  schema: FieldDef[];
  allTasks: GanttTask[];
  templates: GanttTaskTemplate[];
  onUpdate: (t: GanttTask) => void;
  onDelete: () => void;
  onSaveAsTemplate: (name: string, task: GanttTask) => void;
  onSchemaChange: (s: FieldDef[]) => void;
  onClose: () => void;
}

function TaskPanel({ task, schema, allTasks, templates, onUpdate, onDelete, onSaveAsTemplate, onSchemaChange, onClose }: TaskPanelProps) {
  const [draft, setDraft] = useState<GanttTask>({ ...task });
  const [showSaveTpl, setShowSaveTpl] = useState(false);
  const [tplName, setTplName] = useState('');
  const [addingField, setAddingField] = useState(false);
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldType, setNewFieldType] = useState<FieldType>('text');
  const [newFieldOptions, setNewFieldOptions] = useState('');

  const upd = (patch: Partial<GanttTask>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onUpdate(next);
  };

  const saveTpl = () => {
    if (!tplName.trim()) return;
    onSaveAsTemplate(tplName.trim(), draft);
    setTplName(''); setShowSaveTpl(false);
  };

  const commitNewField = () => {
    if (!newFieldName.trim()) return;
    const field: FieldDef = {
      id: uid(), name: newFieldName.trim(), type: newFieldType,
      options: newFieldType === 'select' ? newFieldOptions.split(',').map(s => s.trim()).filter(Boolean) : undefined,
    };
    onSchemaChange([...schema, field]);
    setNewFieldName(''); setNewFieldType('text'); setNewFieldOptions(''); setAddingField(false);
  };

  const otherTasks = allTasks.filter(t => t.id !== task.id);

  return (
    <div className="gantt__detail">
      <div className="gantt__detail-header">
        <span className="gantt__detail-label">Détail</span>
        <button className="gantt__detail-close" onClick={onClose}><X size={14} /></button>
      </div>

      <div className="gantt__detail-body">
        {/* Name */}
        <input
          className="gantt__detail-title"
          value={draft.name}
          onChange={e => upd({ name: e.target.value })}
          placeholder="Nom de la tâche"
        />

        {/* Milestone toggle */}
        <label className="gantt__detail-field">
          <span className="gantt__detail-field-label">Type</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label className="gantt__milestone-toggle">
              <input type="checkbox" checked={!!draft.milestone} onChange={e => upd({ milestone: e.target.checked })} />
              <Flag size={12} /> Jalon
            </label>
          </div>
        </label>

        {/* Dates */}
        {!draft.milestone && (
          <>
            <label className="gantt__detail-field">
              <span className="gantt__detail-field-label">Début</span>
              <input type="date" className="gantt__date-input"
                value={draft.start} onChange={e => upd({ start: e.target.value })} />
            </label>
            <label className="gantt__detail-field">
              <span className="gantt__detail-field-label">Fin</span>
              <input type="date" className="gantt__date-input"
                value={draft.end} onChange={e => upd({ end: e.target.value })} />
            </label>
            <label className="gantt__detail-field">
              <span className="gantt__detail-field-label">Avancement</span>
              <div className="gantt__detail-progress">
                <input type="range" min={0} max={100} step={5}
                  value={draft.progress} onChange={e => upd({ progress: Number(e.target.value) })}
                  className="gantt__progress-range" />
                <span className="gantt__progress-label">{draft.progress}%</span>
              </div>
            </label>
          </>
        )}
        {draft.milestone && (
          <label className="gantt__detail-field">
            <span className="gantt__detail-field-label">Date</span>
            <input type="date" className="gantt__date-input"
              value={draft.start} onChange={e => upd({ start: e.target.value, end: e.target.value })} />
          </label>
        )}

        {/* Priority */}
        <label className="gantt__detail-field">
          <span className="gantt__detail-field-label">Priorité</span>
          <select className="gantt__detail-sel"
            value={draft.priority ?? 'none'}
            onChange={e => upd({ priority: e.target.value as Priority })}
            style={{ borderLeftColor: PRIORITY_COLORS[draft.priority ?? 'none'] }}>
            {PRIORITIES.map(p => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
          </select>
        </label>

        {/* Assignee */}
        <label className="gantt__detail-field">
          <span className="gantt__detail-field-label">Assigné à</span>
          <input className="gantt__detail-input" value={draft.assignee ?? ''}
            onChange={e => upd({ assignee: e.target.value || undefined })}
            placeholder="Nom…" />
        </label>

        {/* Color */}
        <label className="gantt__detail-field">
          <span className="gantt__detail-field-label">Couleur</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {TASK_COLORS.map(c => (
              <button key={c}
                style={{ background: c, width: 18, height: 18, border: draft.color === c ? '2px solid white' : '2px solid transparent', borderRadius: '50%', cursor: 'pointer', padding: 0 }}
                onClick={() => upd({ color: c })} />
            ))}
            <button
              style={{ background: 'var(--color-surface-high,#45475a)', width: 18, height: 18, border: !draft.color ? '2px solid white' : '2px solid transparent', borderRadius: '50%', cursor: 'pointer', padding: 0, fontSize: 10, color: 'var(--color-on-surface-low,#a6adc8)' }}
              onClick={() => upd({ color: undefined })}>
              ✕
            </button>
          </div>
        </label>

        {/* Dependencies */}
        {otherTasks.length > 0 && (
          <div className="gantt__detail-field gantt__detail-field--col">
            <span className="gantt__detail-field-label">Dépendances</span>
            <div className="gantt__detail-deps">
              {otherTasks.map(t => (
                <label key={t.id} className="gantt__detail-dep">
                  <input type="checkbox"
                    checked={(draft.dependencies ?? []).includes(t.id)}
                    onChange={e => {
                      const deps = draft.dependencies ?? [];
                      upd({ dependencies: e.target.checked ? [...deps, t.id] : deps.filter(d => d !== t.id) });
                    }} />
                  {t.name}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Description */}
        <div className="gantt__detail-field gantt__detail-field--col">
          <span className="gantt__detail-field-label">Description</span>
          <textarea className="gantt__detail-textarea"
            value={draft.desc ?? ''}
            onChange={e => upd({ desc: e.target.value || undefined })}
            placeholder="Notes…" rows={3} />
        </div>

        {/* Custom fields + inline add */}
        <div className="gantt__detail-field gantt__detail-field--col">
          <span className="gantt__detail-field-label">Propriétés</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {schema.map(field => (
              <FieldValueRow key={field.id} field={field}
                values={draft.fields ?? []}
                onChange={fields => upd({ fields })} />
            ))}
            {addingField ? (
              <div className="gantt__add-field-form">
                <input autoFocus placeholder="Nom de la propriété"
                  value={newFieldName} onChange={e => setNewFieldName(e.target.value)}
                  className="gantt__detail-input"
                  onKeyDown={e => { if (e.key === 'Enter') commitNewField(); if (e.key === 'Escape') setAddingField(false); }} />
                <select value={newFieldType} onChange={e => setNewFieldType(e.target.value as FieldType)}
                  className="gantt__detail-sel" style={{ borderLeft: 'none' }}>
                  {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map(t => (
                    <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>
                  ))}
                </select>
                {newFieldType === 'select' && (
                  <input placeholder="Options, séparées par virgule"
                    value={newFieldOptions} onChange={e => setNewFieldOptions(e.target.value)}
                    className="gantt__detail-input" />
                )}
                <div style={{ display: 'flex', gap: 5 }}>
                  <button className="gantt__btn" style={{ fontSize: 11, padding: '3px 8px' }} onClick={commitNewField}>Ajouter</button>
                  <button className="gantt__btn gantt__btn--ghost" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => setAddingField(false)}>Annuler</button>
                </div>
              </div>
            ) : (
              <button className="gantt__add-prop-btn" onClick={() => setAddingField(true)}>
                <Plus size={11} /> Ajouter une propriété
              </button>
            )}
          </div>
        </div>

        {/* Attachments */}
        <div className="gantt__detail-field gantt__detail-field--col">
          <span className="gantt__detail-field-label">Pièces jointes</span>
          <AttachmentList
            attachments={draft.attachments ?? []}
            onChange={attachments => upd({ attachments })} />
        </div>
      </div>

      {/* Footer */}
      <div className="gantt__detail-footer">
        {showSaveTpl ? (
          <div style={{ display: 'flex', gap: 5, flex: 1 }}>
            <input autoFocus placeholder="Nom du modèle" value={tplName}
              onChange={e => setTplName(e.target.value)} className="gantt__detail-input"
              style={{ flex: 1 }}
              onKeyDown={e => { if (e.key === 'Enter') saveTpl(); if (e.key === 'Escape') setShowSaveTpl(false); }} />
            <button className="gantt__btn gantt__btn--ghost" onClick={saveTpl}>OK</button>
          </div>
        ) : (
          <button className="gantt__btn gantt__btn--ghost" onClick={() => setShowSaveTpl(true)}>
            <Bookmark size={11} /> Modèle
          </button>
        )}
        <button className="gantt__del-btn" onClick={onDelete}>
          <Trash2 size={12} /> Supprimer
        </button>
      </div>
    </div>
  );
}

/* ─── Main GanttPad ─── */

export default function GanttPad({ padId, data, onDataChange }: Props) {
  const [tasks, setTasks] = useState<GanttTask[]>(data.tasks ?? []);
  const [schema, setSchema] = useState<FieldDef[]>(data.fieldSchema ?? []);
  const [templates, setTemplates] = useState<GanttTaskTemplate[]>(data.taskTemplates ?? []);
  const [viewOffset, setViewOffset] = useState(-7);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showTplMenu, setShowTplMenu] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUpdatedAt = useRef<string | null>(data.updated_at ?? null);
  const [conflict, setConflict] = useState(false);
  const boardRef = useRef<HTMLDivElement | null>(null);

  const save = useCallback((t: GanttTask[], sc: FieldDef[], tpls: GanttTaskTemplate[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const d: GanttData = { tasks: t, fieldSchema: sc, taskTemplates: tpls };
      onDataChange(d);
      try {
        const res = await fetch(`/api/pad/${padId}/data`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: d, expected_updated_at: lastUpdatedAt.current }),
        });
        if (res.status === 409) { setConflict(true); return; }
        if (res.ok) {
          const j = await res.json().catch(() => null);
          if (j?.updated_at) lastUpdatedAt.current = j.updated_at;
          setConflict(false);
          if (boardRef.current) void snapshotDomPad(padId, boardRef.current);
        }
      } catch (e) { console.error(e); }
    }, SAVE_DEBOUNCE);
  }, [padId, onDataChange]);

  const update = (t: GanttTask[], sc = schema, tpls = templates) => { setTasks(t); save(t, sc, tpls); };
  const updateSchema = (sc: FieldDef[]) => { setSchema(sc); save(tasks, sc, templates); };
  const updateTemplates = (tpls: GanttTaskTemplate[]) => { setTemplates(tpls); save(tasks, schema, tpls); };

  const addTask = () => {
    const t: GanttTask = {
      id: uid(), name: 'Nouvelle tâche',
      start: addDays(today(), viewOffset + 7),
      end: addDays(today(), viewOffset + 14),
      progress: 0, priority: 'none', fields: [], attachments: [],
    };
    update([...tasks, t]);
    setSelectedId(t.id);
  };

  const addMilestone = () => {
    const d = addDays(today(), viewOffset + 14);
    const t: GanttTask = {
      id: uid(), name: 'Jalon', start: d, end: d,
      progress: 0, milestone: true, priority: 'none', fields: [], attachments: [],
    };
    update([...tasks, t]);
    setSelectedId(t.id);
  };

  const addFromTemplate = (tpl: GanttTaskTemplate) => {
    const d = addDays(today(), viewOffset + 7);
    const t: GanttTask = {
      ...tpl.task, id: uid(), start: d, end: addDays(d, 7),
    };
    update([...tasks, t]);
    setSelectedId(t.id);
  };

  const saveAsTemplate = (name: string, task: GanttTask) => {
    const { id, start, end, ...rest } = task;
    const tpl: GanttTaskTemplate = { id: uid(), name, task: rest };
    updateTemplates([...templates, tpl]);
  };

  const selectedTask = tasks.find(t => t.id === selectedId) ?? null;
  const viewStart = addDays(today(), viewOffset);
  const viewDays = 90;

  return (
    <div className="gantt" ref={boardRef}>
      {conflict && (
        <div style={{ background: '#f5a623', color: '#000', padding: '8px 12px', fontSize: 13, textAlign: 'center' }}>
          ⚠️ Ce planning a été modifié sur un autre appareil. Recharge la page pour repartir de la version serveur.
        </div>
      )}
      {/* Toolbar */}
      <div className="gantt__toolbar">
        <div className="gantt__toolbar-left">
          <button className="gantt__btn" onClick={addTask}><Plus size={13} /> Tâche</button>
          <button className="gantt__btn gantt__btn--ghost" onClick={addMilestone}><Flag size={12} /> Jalon</button>
          {templates.length > 0 && (
            <div style={{ position: 'relative' }}>
              <button className="gantt__btn gantt__btn--ghost"
                onClick={() => setShowTplMenu(v => !v)}>
                <Bookmark size={12} /> Modèles <ChevronDown size={10} />
              </button>
              {showTplMenu && (
                <div className="gantt__tpl-menu">
                  {templates.map(tpl => (
                    <button key={tpl.id} className="gantt__tpl-item"
                      onClick={() => { addFromTemplate(tpl); setShowTplMenu(false); }}>
                      {tpl.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="gantt__toolbar-nav">
          <button className="gantt__nav-btn" onClick={() => setViewOffset(v => v - 30)}>‹‹ -30j</button>
          <button className="gantt__nav-btn" onClick={() => setViewOffset(0)}>Aujourd'hui</button>
          <button className="gantt__nav-btn" onClick={() => setViewOffset(v => v + 30)}>+30j ››</button>
        </div>
      </div>

      {/* Main layout */}
      <div className="gantt__body">
        {/* Left: task list */}
        <div className="gantt__labels">
          <div className="gantt__labels-header">Tâches</div>
          {tasks.map(task => (
            <div
              key={task.id}
              className={`gantt__row${selectedId === task.id ? ' gantt__row--selected' : ''}`}
              onClick={() => setSelectedId(task.id === selectedId ? null : task.id)}
            >
              <div className="gantt__row-info">
                {task.milestone && <Flag size={11} className="gantt__milestone-icon" />}
                <span className="gantt__row-name-text">{task.name}</span>
                {task.priority && task.priority !== 'none' && (
                  <span className="gantt__row-priority"
                    style={{ background: PRIORITY_COLORS[task.priority] + '33', color: PRIORITY_COLORS[task.priority] }}>
                    {PRIORITY_LABELS[task.priority]}
                  </span>
                )}
              </div>
              <div className="gantt__row-dates-compact">
                <span>{task.start}</span>
                {!task.milestone && <><span>→</span><span>{task.end}</span></>}
              </div>
            </div>
          ))}
          {tasks.length === 0 && (
            <div className="gantt__empty">Cliquez "+ Tâche" pour commencer</div>
          )}
        </div>

        {/* Center: chart */}
        <div className="gantt__chart-scroll">
          <GanttChart
            tasks={tasks}
            viewStart={viewStart}
            viewDays={viewDays}
            selectedId={selectedId}
            onSelect={id => setSelectedId(id === selectedId ? null : id)}
          />
        </div>

        {/* Right: task detail panel */}
        {selectedTask && (
          <TaskPanel
            task={selectedTask}
            schema={schema}
            allTasks={tasks}
            templates={templates}
            onUpdate={updated => update(tasks.map(t => t.id === updated.id ? updated : t))}
            onDelete={() => {
              update(tasks.filter(t => t.id !== selectedTask.id));
              setSelectedId(null);
            }}
            onSaveAsTemplate={saveAsTemplate}
            onSchemaChange={updateSchema}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}
