import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Trash2, Download, CheckCircle, XCircle, AlertCircle, Loader, RefreshCw } from 'lucide-react';
import type { OllamaModel } from '../hooks/useOllama';
import './ModelManager.scss';

/* ───────────────── Catalogue ───────────────── */

interface CatalogEntry {
  id: string;
  name: string;
  params: string;
  category: string;
  badge: string;
  badgeColor: string;
  ram: string;
  dlSize: string;
  desc: string;
}

const CATALOG: CatalogEntry[] = [
  /* ─── Distillés (vedettes) ─── */
  {
    id: 'deepseek-r1:1.5b', name: 'DeepSeek-R1', params: '1.5B',
    category: 'distillé', badge: '🧠 Distillé', badgeColor: '#cba6f7',
    ram: '~1.5 GB', dlSize: '1.1 GB',
    desc: 'Distillé du modèle R1 671B de DeepSeek. Raisonnement chaîne-de-pensée exceptionnel pour 1.5B params.',
  },
  {
    id: 'deepseek-r1:7b', name: 'DeepSeek-R1', params: '7B',
    category: 'distillé', badge: '🧠 Distillé', badgeColor: '#cba6f7',
    ram: '~5 GB', dlSize: '4.7 GB',
    desc: 'Distillé sur architecture Qwen. Bat GPT-4o sur plusieurs benchmarks de raisonnement.',
  },
  {
    id: 'deepseek-r1:8b', name: 'DeepSeek-R1', params: '8B',
    category: 'distillé', badge: '🧠 Distillé', badgeColor: '#cba6f7',
    ram: '~6 GB', dlSize: '4.9 GB',
    desc: 'Distillé sur Llama 3.1. Excellente alternative open-weight avec raisonnement avancé.',
  },
  {
    id: 'phi4', name: 'Phi 4', params: '14B',
    category: 'distillé', badge: '🔬 Microsoft', badgeColor: '#89b4fa',
    ram: '~10 GB', dlSize: '9.1 GB',
    desc: 'Modèle Microsoft entraîné sur des données synthétiques de qualité. Surclasse bien des 70B sur les benchmarks académiques.',
  },
  {
    id: 'phi4-mini', name: 'Phi 4 Mini', params: '3.8B',
    category: 'distillé', badge: '🔬 Microsoft', badgeColor: '#89b4fa',
    ram: '~3 GB', dlSize: '2.5 GB',
    desc: 'Version compacte de Phi 4. Qualité remarquable pour sa taille — idéal pour des Macs avec 8 GB de RAM.',
  },

  /* ─── Ultra-légers ─── */
  {
    id: 'gemma3:1b', name: 'Gemma 3', params: '1B',
    category: 'léger', badge: '⚡ Ultra-léger', badgeColor: '#89dceb',
    ram: '~1 GB', dlSize: '815 MB',
    desc: 'Le plus petit modèle utilisable. Google Gemma 3. Pour les Macs très contraints en RAM.',
  },
  {
    id: 'llama3.2:1b', name: 'Llama 3.2', params: '1B',
    category: 'léger', badge: '⚡ Ultra-léger', badgeColor: '#89dceb',
    ram: '~1.5 GB', dlSize: '1.3 GB',
    desc: 'Meta Llama 3.2 ultra-compact. Réponses basiques rapides.',
  },
  {
    id: 'gemma3:4b', name: 'Gemma 3', params: '4B',
    category: 'léger', badge: '⚡ Compact', badgeColor: '#a6e3a1',
    ram: '~3 GB', dlSize: '2.5 GB',
    desc: 'Gemma 3 compact. Très bon pour sa taille, multimodal (images) sur certains front-ends.',
  },
  {
    id: 'gemma2:2b', name: 'Gemma 2', params: '2B',
    category: 'léger', badge: '⚡ Compact', badgeColor: '#a6e3a1',
    ram: '~2 GB', dlSize: '1.6 GB',
    desc: 'Gemma 2 de Google. Surprenant pour sa taille, bonne qualité de génération.',
  },

  /* ─── Équilibrés ─── */
  {
    id: 'llama3.2', name: 'Llama 3.2', params: '3B',
    category: 'équilibré', badge: '⭐ Recommandé', badgeColor: '#f9e2af',
    ram: '~3 GB', dlSize: '2.0 GB',
    desc: 'Meilleur point d\'entrée. Vitesse et qualité bien balancées pour usage quotidien.',
  },
  {
    id: 'qwen2.5:3b', name: 'Qwen 2.5', params: '3B',
    category: 'équilibré', badge: '🇫🇷 FR/EN', badgeColor: '#cba6f7',
    ram: '~2.5 GB', dlSize: '2.0 GB',
    desc: 'Alibaba Qwen 2.5, multilingue natif. Très bon en français et dans de nombreuses langues.',
  },
  {
    id: 'mistral', name: 'Mistral', params: '7B',
    category: 'équilibré', badge: '🇫🇷 Mistral AI', badgeColor: '#f9e2af',
    ram: '~5 GB', dlSize: '4.1 GB',
    desc: 'Modèle phare de Mistral AI (français). Fort en raisonnement et logique, fenêtre contextuelle importante.',
  },
  {
    id: 'qwen2.5', name: 'Qwen 2.5', params: '7B',
    category: 'équilibré', badge: '🇫🇷 FR/EN', badgeColor: '#cba6f7',
    ram: '~6 GB', dlSize: '4.7 GB',
    desc: 'Meilleur modèle multilingue de cette gamme. Recommandé si vous travaillez principalement en français.',
  },
  {
    id: 'llama3.1:8b', name: 'Llama 3.1', params: '8B',
    category: 'équilibré', badge: '🏆 Performant', badgeColor: '#f38ba8',
    ram: '~7 GB', dlSize: '4.7 GB',
    desc: 'Meta Llama 3.1 — la meilleure qualité dans la gamme 8B. Contexte 128k tokens.',
  },

  /* ─── Code ─── */
  {
    id: 'qwen2.5-coder:7b', name: 'Qwen 2.5 Coder', params: '7B',
    category: 'code', badge: '💻 Code', badgeColor: '#a6e3a1',
    ram: '~6 GB', dlSize: '4.7 GB',
    desc: 'Spécialisé code. Completion, debug, refactoring sur >80 langages. Parmi les meilleurs locaux pour le code.',
  },
  {
    id: 'qwen2.5-coder:1.5b', name: 'Qwen 2.5 Coder', params: '1.5B',
    category: 'code', badge: '💻 Code léger', badgeColor: '#a6e3a1',
    ram: '~1.5 GB', dlSize: '1.0 GB',
    desc: 'Version compacte du Coder. Utile pour la complétion de code rapide sur machine contrainte.',
  },

  /* ─── Puissants ─── */
  {
    id: 'gemma3:12b', name: 'Gemma 3', params: '12B',
    category: 'puissant', badge: '🏆 Haut de gamme', badgeColor: '#f38ba8',
    ram: '~10 GB', dlSize: '8.1 GB',
    desc: 'Gemma 3 12B de Google. Nécessite 16+ GB de RAM. Qualité très élevée avec support multimodal.',
  },
  {
    id: 'mistral-small', name: 'Mistral Small', params: '22B',
    category: 'puissant', badge: '🏆 Expert', badgeColor: '#f38ba8',
    ram: '~14 GB', dlSize: '12 GB',
    desc: 'Le "petit" de Mistral AI reste un modèle très puissant. Nécessite 16-32 GB de RAM.',
  },
];

const CATEGORIES: { id: string; label: string }[] = [
  { id: 'all', label: 'Tous' },
  { id: 'distillé', label: '🧠 Distillés' },
  { id: 'léger', label: '⚡ Légers' },
  { id: 'équilibré', label: '⭐ Équilibrés' },
  { id: 'code', label: '💻 Code' },
  { id: 'puissant', label: '🏆 Puissants' },
];

/* ───────────────── Utils ───────────────── */

function fmtBytes(b: number): string {
  if (!b) return '?';
  const gb = b / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(b / 1e6).toFixed(0)} MB`;
}

interface LogLine { kind: string; msg: string }

/* ───────────────── Component ───────────────── */

interface Props {
  installedModels: OllamaModel[];
  onModelsChanged: () => void;
  onRefresh: () => void;
}

export default function ModelManager({ installedModels, onModelsChanged, onRefresh }: Props) {
  const [tab, setTab] = useState<'installed' | 'catalog'>('installed');
  const [catFilter, setCatFilter] = useState('all');
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullLogs, setPullLogs] = useState<LogLine[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [pullLogs]);

  const installedNames = installedModels.map(m => m.name);

  const handleDelete = async (name: string) => {
    if (!confirm(`Supprimer le modèle "${name}" ?`)) return;
    setDeleting(name);
    setDeleteError(null);
    try {
      const resp = await fetch('/api/ai/models', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setDeleteError(data.detail ?? `Erreur ${resp.status}`);
        return;
      }
      const data = await resp.json();
      if (!data.ok) {
        setDeleteError('Ollama a refusé la suppression.');
        return;
      }
      onRefresh();
    } catch (e: unknown) {
      setDeleteError((e as Error).message ?? 'Erreur réseau');
    } finally {
      setDeleting(null);
    }
  };

  const handlePull = useCallback(async (modelId: string) => {
    setPulling(modelId);
    setPullLogs([]);

    try {
      const resp = await fetch('/api/ai/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelId }),
      });

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') break;
          try {
            const evt: LogLine = JSON.parse(payload);
            if (evt.kind === 'done') {
              onRefresh();
            } else {
              setPullLogs(prev => {
                // Replace last log if same prefix (progress update)
                const last = prev[prev.length - 1];
                if (last && last.kind === evt.kind && last.kind === 'log') {
                  return [...prev.slice(0, -1), evt];
                }
                return [...prev, evt];
              });
            }
          } catch { /* skip */ }
        }
      }
    } finally {
      setPulling(null);
    }
  }, [onModelsChanged]);

  const visibleCatalog = catFilter === 'all'
    ? CATALOG
    : CATALOG.filter(m => m.category === catFilter);

  return (
    <div className="model-mgr">
      {/* Tab bar */}
      <div className="model-mgr__tabs">
        <button
          className={`model-mgr__tab${tab === 'installed' ? ' model-mgr__tab--active' : ''}`}
          onClick={() => setTab('installed')}
        >
          Installés ({installedModels.length})
        </button>
        <button
          className={`model-mgr__tab${tab === 'catalog' ? ' model-mgr__tab--active' : ''}`}
          onClick={() => setTab('catalog')}
        >
          Catalogue
        </button>
      </div>

      {/* ── Installed tab ── */}
      {tab === 'installed' && (
        <div className="model-mgr__installed">
          {deleteError && (
            <div className="model-mgr__error">
              <XCircle size={12} /> {deleteError}
            </div>
          )}
          {installedModels.length === 0 ? (
            <div className="model-mgr__empty">Aucun modèle installé</div>
          ) : (
            installedModels.map(m => (
              <div key={m.name} className="model-mgr__installed-row">
                <div className="model-mgr__installed-info">
                  <span className="model-mgr__installed-name">{m.name}</span>
                  <span className="model-mgr__installed-size">{fmtBytes(m.size)}</span>
                </div>
                <button
                  className="model-mgr__delete-btn"
                  onClick={() => handleDelete(m.name)}
                  disabled={deleting === m.name}
                  title="Supprimer ce modèle"
                >
                  {deleting === m.name
                    ? <Loader size={13} className="model-mgr__spin" />
                    : <Trash2 size={13} />
                  }
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── Catalog tab ── */}
      {tab === 'catalog' && (
        <div className="model-mgr__catalog">
          {/* Category filters */}
          <div className="model-mgr__filters">
            {CATEGORIES.map(c => (
              <button
                key={c.id}
                className={`model-mgr__filter${catFilter === c.id ? ' model-mgr__filter--active' : ''}`}
                onClick={() => setCatFilter(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>

          {/* Model cards */}
          <div className="model-mgr__entries">
            {visibleCatalog.map(m => {
              const installed = installedNames.includes(m.id);
              const isPulling = pulling === m.id;
              return (
                <div key={m.id} className={`model-mgr__entry${installed ? ' model-mgr__entry--installed' : ''}`}>
                  <div className="model-mgr__entry-top">
                    <div className="model-mgr__entry-title">
                      <span className="model-mgr__entry-name">{m.name}</span>
                      <span className="model-mgr__entry-params">{m.params}</span>
                    </div>
                    <span className="model-mgr__entry-badge" style={{ color: m.badgeColor }}>
                      {m.badge}
                    </span>
                  </div>
                  <div className="model-mgr__entry-meta">
                    <span>{m.ram} RAM</span>
                    <span>·</span>
                    <span>{m.dlSize} à télécharger</span>
                  </div>
                  <div className="model-mgr__entry-desc">{m.desc}</div>
                  <div className="model-mgr__entry-actions">
                    {installed ? (
                      <span className="model-mgr__installed-chip">
                        <CheckCircle size={11} /> Installé
                      </span>
                    ) : (
                      <button
                        className="model-mgr__pull-btn"
                        onClick={() => handlePull(m.id)}
                        disabled={pulling !== null}
                      >
                        {isPulling
                          ? <><Loader size={11} className="model-mgr__spin" /> Téléchargement…</>
                          : <><Download size={11} /> Installer</>
                        }
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pull progress */}
          {pullLogs.length > 0 && (
            <div className="model-mgr__pull-log" ref={logRef}>
              {pullLogs.map((l, i) => (
                <div key={i} className={`model-mgr__pull-line model-mgr__pull-line--${l.kind}`}>
                  {l.kind === 'success' && <CheckCircle size={10} />}
                  {l.kind === 'error' && <XCircle size={10} />}
                  {l.kind === 'warn' && <AlertCircle size={10} />}
                  <span>{l.msg}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
