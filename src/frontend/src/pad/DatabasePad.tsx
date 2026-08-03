import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, Trash2, Table2, Columns3, X } from 'lucide-react';
import './DatabasePad.scss';

export interface DbColumn { id: string; name: string; }
export interface DbRow { id: string; cells: Record<string, string>; }
export interface DatabaseData { columns: DbColumn[]; rows: DbRow[]; groupBy?: string; }

interface Props {
  padId: string;
  data: DatabaseData;
  onDataChange: (d: DatabaseData) => void;
}

const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

export default function DatabasePad({ padId, data, onDataChange }: Props) {
  const [view, setView] = useState<'table' | 'board'>('table');
  const [local, setLocal] = useState<DatabaseData>(data);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset local state when switching to a different database pad.
  useEffect(() => { setLocal(data); /* eslint-disable-next-line */ }, [padId]);

  const commit = useCallback((next: DatabaseData) => {
    setLocal(next);
    onDataChange(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch(`/api/pad/${padId}/data`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      }).catch(() => {});
    }, 400);
  }, [padId, onDataChange]);

  /* ── mutations ── */
  const setCell = (rowId: string, colId: string, value: string) =>
    commit({ ...local, rows: local.rows.map(r => r.id === rowId ? { ...r, cells: { ...r.cells, [colId]: value } } : r) });
  const renameCol = (colId: string, name: string) =>
    commit({ ...local, columns: local.columns.map(c => c.id === colId ? { ...c, name } : c) });
  const addColumn = () => {
    const id = uid('c');
    commit({
      ...local,
      columns: [...local.columns, { id, name: 'Colonne' }],
      rows: local.rows.map(r => ({ ...r, cells: { ...r.cells, [id]: '' } })),
    });
  };
  const deleteColumn = (colId: string) => {
    if (local.columns.length <= 1) return;
    const columns = local.columns.filter(c => c.id !== colId);
    commit({
      ...local,
      columns,
      groupBy: local.groupBy === colId ? columns[0]?.id : local.groupBy,
      rows: local.rows.map(r => { const { [colId]: _drop, ...rest } = r.cells; return { ...r, cells: rest }; }),
    });
  };
  const addRow = () => {
    const cells: Record<string, string> = {};
    local.columns.forEach(c => { cells[c.id] = ''; });
    commit({ ...local, rows: [...local.rows, { id: uid('r'), cells }] });
  };
  const deleteRow = (rowId: string) => commit({ ...local, rows: local.rows.filter(r => r.id !== rowId) });
  const setGroupBy = (colId: string) => commit({ ...local, groupBy: colId });

  const groupCol = local.groupBy && local.columns.find(c => c.id === local.groupBy)
    ? local.groupBy : local.columns[0]?.id;

  // Distinct group values (in first-seen order), with an explicit empty bucket.
  const groups = (() => {
    const seen: string[] = [];
    local.rows.forEach(r => {
      const v = (r.cells[groupCol!] || '').trim();
      if (!seen.includes(v)) seen.push(v);
    });
    if (!seen.includes('')) seen.push('');
    return seen;
  })();

  const titleCol = local.columns[0]?.id;

  return (
    <div className="dbpad">
      <div className="dbpad__toolbar">
        <div className="dbpad__views">
          <button className={`dbpad__view-btn${view === 'table' ? ' active' : ''}`} onClick={() => setView('table')}>
            <Table2 size={13} /> Table
          </button>
          <button className={`dbpad__view-btn${view === 'board' ? ' active' : ''}`} onClick={() => setView('board')}>
            <Columns3 size={13} /> Board
          </button>
        </div>
        {view === 'board' && (
          <label className="dbpad__groupby">
            Grouper par
            <select value={groupCol} onChange={e => setGroupBy(e.target.value)}>
              {local.columns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <div className="dbpad__spacer" />
        <button className="dbpad__add" onClick={addRow}><Plus size={13} /> Ligne</button>
      </div>

      {view === 'table' ? (
        <div className="dbpad__table-wrap">
          <table className="dbpad__table">
            <thead>
              <tr>
                <th className="dbpad__th-num">#</th>
                {local.columns.map(col => (
                  <th key={col.id}>
                    <div className="dbpad__col-head">
                      <input
                        className="dbpad__col-name"
                        value={col.name}
                        onChange={e => renameCol(col.id, e.target.value)}
                      />
                      {local.columns.length > 1 && (
                        <button className="dbpad__col-del" title="Supprimer la colonne" onClick={() => deleteColumn(col.id)}>
                          <X size={11} />
                        </button>
                      )}
                    </div>
                  </th>
                ))}
                <th className="dbpad__th-add">
                  <button className="dbpad__add-col" title="Ajouter une colonne" onClick={addColumn}><Plus size={13} /></button>
                </th>
              </tr>
            </thead>
            <tbody>
              {local.rows.map((row, i) => (
                <tr key={row.id}>
                  <td className="dbpad__td-num">
                    <span>{i + 1}</span>
                    <button className="dbpad__row-del" title="Supprimer la ligne" onClick={() => deleteRow(row.id)}>
                      <Trash2 size={12} />
                    </button>
                  </td>
                  {local.columns.map(col => (
                    <td key={col.id}>
                      <input
                        className="dbpad__cell"
                        value={row.cells[col.id] ?? ''}
                        onChange={e => setCell(row.id, col.id, e.target.value)}
                      />
                    </td>
                  ))}
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
          <button className="dbpad__add-row" onClick={addRow}><Plus size={14} /> Nouvelle ligne</button>
        </div>
      ) : (
        <div className="dbpad__board">
          {groups.map(g => {
            const rows = local.rows.filter(r => (r.cells[groupCol!] || '').trim() === g);
            return (
              <div key={g || '__empty'} className="dbpad__board-col">
                <div className="dbpad__board-col-head">
                  {g || <span className="dbpad__board-empty-label">Sans valeur</span>}
                  <span className="dbpad__board-count">{rows.length}</span>
                </div>
                <div className="dbpad__board-cards">
                  {rows.map(row => (
                    <div key={row.id} className="dbpad__card">
                      <div className="dbpad__card-title">{row.cells[titleCol!] || <em>Sans titre</em>}</div>
                      {local.columns.filter(c => c.id !== titleCol && c.id !== groupCol).map(c => (
                        row.cells[c.id] ? (
                          <div key={c.id} className="dbpad__card-field">
                            <span className="dbpad__card-field-label">{c.name}</span> {row.cells[c.id]}
                          </div>
                        ) : null
                      ))}
                      <select
                        className="dbpad__card-move"
                        value={g}
                        onChange={e => setCell(row.id, groupCol!, e.target.value)}
                      >
                        {groups.map(gv => <option key={gv || '__e'} value={gv}>{gv || 'Sans valeur'}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
