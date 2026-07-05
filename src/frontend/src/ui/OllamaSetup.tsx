import React, { useState, useRef, useEffect } from 'react';
import { CheckCircle, XCircle, AlertCircle, Loader, ChevronDown, ChevronUp } from 'lucide-react';
import './OllamaSetup.scss';

interface Model {
  id: string;
  name: string;
  badge: string;
  badgeColor: string;
  ram: string;
  size: string;
  desc: string;
  recommended?: boolean;
}

const MODELS: Model[] = [
  {
    id: 'llama3.2',
    name: 'Llama 3.2 · 3B',
    badge: '⭐ Recommandé',
    badgeColor: '#f9e2af',
    ram: '~3 GB RAM',
    size: '2.0 GB',
    desc: 'Meilleur équilibre vitesse / qualité pour un usage quotidien. Idéal pour commencer.',
    recommended: true,
  },
  {
    id: 'llama3.2:1b',
    name: 'Llama 3.2 · 1B',
    badge: '⚡ Très rapide',
    badgeColor: '#89dceb',
    ram: '~1.5 GB RAM',
    size: '1.3 GB',
    desc: 'Ultra-léger. Parfait si votre Mac a peu de RAM libre. Réponses basiques.',
  },
  {
    id: 'qwen2.5',
    name: 'Qwen 2.5 · 7B',
    badge: '🇫🇷 FR/EN',
    badgeColor: '#cba6f7',
    ram: '~6 GB RAM',
    size: '4.7 GB',
    desc: 'Multilingue par design. Excellent en français. Recommandé si vous écrivez principalement en FR.',
  },
  {
    id: 'mistral',
    name: 'Mistral · 7B',
    badge: '🧠 Raisonnement',
    badgeColor: '#89b4fa',
    ram: '~5 GB RAM',
    size: '4.1 GB',
    desc: 'Très fort en logique, code et analyse. Modèle français (Mistral AI).',
  },
  {
    id: 'gemma2:2b',
    name: 'Gemma 2 · 2B',
    badge: '⚡ Compact',
    badgeColor: '#a6e3a1',
    ram: '~2 GB RAM',
    size: '1.6 GB',
    desc: 'Modèle Google, surprenant pour sa taille. Bonne qualité dans peu d\'espace.',
  },
  {
    id: 'llama3.1:8b',
    name: 'Llama 3.1 · 8B',
    badge: '🏆 Qualité max',
    badgeColor: '#f38ba8',
    ram: '~8 GB RAM',
    size: '4.7 GB',
    desc: 'La meilleure qualité parmi les modèles locaux légers. Nécessite un Mac récent.',
  },
];

interface LogLine {
  kind: string;
  msg: string;
}

interface Props {
  onDone: () => void;
}

export default function OllamaSetup({ onDone }: Props) {
  const [selected, setSelected] = useState<string>('llama3.2');
  const [installing, setInstalling] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const handleInstall = async () => {
    setInstalling(true);
    setLogs([]);
    setDone(false);
    setError(false);
    setShowLogs(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const resp = await fetch('/api/ai/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selected }),
        signal: ctrl.signal,
      });

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done: rdone, value } = await reader.read();
        if (rdone) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') break;
          try {
            const event: LogLine = JSON.parse(payload);
            if (event.kind === 'done') {
              setDone(true);
            } else if (event.kind === 'error') {
              setError(true);
              setLogs(prev => [...prev, event]);
            } else {
              setLogs(prev => [...prev, event]);
            }
          } catch { /* skip */ }
        }
      }
    } catch (e: unknown) {
      if ((e as Error)?.name !== 'AbortError') {
        setError(true);
        setLogs(prev => [...prev, { kind: 'error', msg: `Erreur réseau : ${(e as Error).message}` }]);
      }
    } finally {
      setInstalling(false);
    }
  };

  const selectedModel = MODELS.find(m => m.id === selected)!;

  return (
    <div className="ollama-setup">
      {/* Header */}
      <div className="ollama-setup__hero">
        <div className="ollama-setup__logo">🦙</div>
        <h2 className="ollama-setup__title">Configurer l'IA locale</h2>
        <p className="ollama-setup__sub">
          Ollama fait tourner des modèles d'IA directement sur votre Mac, <strong>sans envoyer vos données</strong> sur internet.
        </p>
      </div>

      {!done ? (
        <>
          {/* Model picker */}
          <div className="ollama-setup__section-label">Choisissez un modèle</div>
          <div className="ollama-setup__models">
            {MODELS.map(m => (
              <button
                key={m.id}
                className={`ollama-setup__model-card${selected === m.id ? ' ollama-setup__model-card--selected' : ''}`}
                onClick={() => setSelected(m.id)}
                disabled={installing}
              >
                <div className="ollama-setup__model-top">
                  <span className="ollama-setup__model-name">{m.name}</span>
                  <span className="ollama-setup__model-badge" style={{ color: m.badgeColor }}>
                    {m.badge}
                  </span>
                </div>
                <div className="ollama-setup__model-meta">
                  <span>{m.ram}</span>
                  <span>·</span>
                  <span>{m.size}</span>
                </div>
                <div className="ollama-setup__model-desc">{m.desc}</div>
              </button>
            ))}
          </div>

          {/* Install button */}
          <div className="ollama-setup__action">
            <button
              className="ollama-setup__install-btn"
              onClick={handleInstall}
              disabled={installing}
            >
              {installing
                ? <><Loader size={15} className="ollama-setup__spin" /> Installation en cours…</>
                : <>🚀 Installer &amp; Démarrer · {selectedModel.name}</>
              }
            </button>
          </div>

          {/* Progress logs */}
          {showLogs && logs.length > 0 && (
            <div className="ollama-setup__logs-section">
              <button
                className="ollama-setup__logs-toggle"
                onClick={() => setShowLogs(v => !v)}
              >
                Détails {showLogs ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>
              <div className="ollama-setup__logs" ref={logRef}>
                {logs.map((l, i) => (
                  <div key={i} className={`ollama-setup__log ollama-setup__log--${l.kind}`}>
                    {l.kind === 'step' && <span className="ollama-setup__log-icon">›</span>}
                    {l.kind === 'success' && <CheckCircle size={11} />}
                    {l.kind === 'error' && <XCircle size={11} />}
                    {l.kind === 'warn' && <AlertCircle size={11} />}
                    <span>{l.msg}</span>
                  </div>
                ))}
                {installing && (
                  <div className="ollama-setup__log ollama-setup__log--loading">
                    <Loader size={11} className="ollama-setup__spin" />
                    <span>En cours…</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        /* Success screen */
        <div className="ollama-setup__success">
          <div className="ollama-setup__success-icon">✅</div>
          <div className="ollama-setup__success-title">Prêt à utiliser !</div>
          <div className="ollama-setup__success-sub">
            <strong>{selectedModel.name}</strong> est installé et le serveur est démarré.<br />
            <code>.env.local</code> a été mis à jour automatiquement.
          </div>
          <button className="ollama-setup__install-btn" onClick={onDone}>
            Ouvrir l'assistant IA →
          </button>
        </div>
      )}
    </div>
  );
}
