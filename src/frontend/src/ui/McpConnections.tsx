import React, { useEffect, useId, useRef, useState } from 'react';
import './McpConnections.scss';

interface McpKey {
  public_id: string;
  name: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
}

async function checkResponse(response: Response, fallback: string) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : fallback);
  return body;
}

export default function McpConnections() {
  const id = useId();
  const [endpoint, setEndpoint] = useState('');
  const [oauthReady, setOauthReady] = useState(false);
  const [keys, setKeys] = useState<McpKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [name, setName] = useState('');
  const [allowWrite, setAllowWrite] = useState(false);
  const [expiresDays, setExpiresDays] = useState('90');
  const [token, setToken] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const tokenRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const cancelRevokeRef = useRef<HTMLButtonElement>(null);
  const connectionsTitleRef = useRef<HTMLHeadingElement>(null);
  const revokeButtons = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setReady(false);
    setError('');
    Promise.all([
      fetch('/api/mcp/connection', { signal: controller.signal }).then(r => checkResponse(r, 'Connexion MCP indisponible.')),
      fetch('/api/mcp/keys', { signal: controller.signal }).then(r => checkResponse(r, 'Chargement des connexions impossible.')),
    ]).then(([connection, result]) => {
      if (controller.signal.aborted) return;
      setEndpoint(connection.endpoint);
      setOauthReady(connection.oauth?.enabled === true);
      setKeys(Array.isArray(result.keys) ? result.keys : []);
      setReady(true);
      if (loadAttempt > 0) window.setTimeout(() => nameRef.current?.focus(), 0);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [loadAttempt]);

  useEffect(() => {
    if (confirmRevoke) cancelRevokeRef.current?.focus();
  }, [confirmRevoke]);

  const cancelRevoke = () => {
    const publicId = confirmRevoke;
    setConfirmRevoke(null);
    window.setTimeout(() => { if (publicId) revokeButtons.current.get(publicId)?.focus(); }, 0);
  };

  const acknowledgeToken = () => {
    setToken('');
    setVisible(false);
    setMessage('La clé ne sera plus affichée. Cette connexion reste révocable ci-dessous.');
    window.setTimeout(() => nameRef.current?.focus(), 0);
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(`${label} copiée.`);
      setError('');
    } catch {
      setError('Copie automatique indisponible. Sélectionnez le champ puis copiez-le au clavier.');
    }
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await checkResponse(await fetch('/api/mcp/keys', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), allow_write: allowWrite, expires_days: Number(expiresDays) }),
      }), 'Création impossible. Réessayez.');
      setToken(result.token); setVisible(false);
      setKeys(previous => [result.key, ...previous]);
      setName(''); setAllowWrite(false);
      setMessage('Connexion créée. Copiez la clé avant de fermer cette fenêtre.');
      window.setTimeout(() => tokenRef.current?.focus(), 0);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Création impossible.'); }
    finally { setBusy(false); }
  };

  const revoke = async (key: McpKey) => {
    setBusy(true); setError(''); setMessage('');
    try {
      await checkResponse(await fetch(`/api/mcp/keys/${encodeURIComponent(key.public_id)}/revoke`, { method: 'POST' }), 'Révocation impossible.');
      setKeys(previous => previous.map(row => row.public_id === key.public_id ? { ...row, revoked_at: new Date().toISOString() } : row));
      connectionsTitleRef.current?.focus();
      setConfirmRevoke(null); setMessage(`La connexion « ${key.name} » est révoquée.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Révocation impossible.'); }
    finally { setBusy(false); }
  };

  return <section className="mcp-connections" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Connecter un assistant à Alcove</h3>
    <p>Votre assistant pourra retrouver vos pads. Chaque connexion reste révocable depuis cet écran.</p>
    {loading ? <p role="status">Chargement des connexions…</p> : !ready ? <button type="button" onClick={() => setLoadAttempt(attempt => attempt + 1)}>Recharger les connexions</button> : <>
      {endpoint && <>
        <label htmlFor={`${id}-endpoint`}>URL du serveur MCP</label>
        <div className="mcp-connections__row">
          <input id={`${id}-endpoint`} value={endpoint} readOnly />
          <button type="button" onClick={() => void copy(endpoint, 'URL')}>Copier l’URL</button>
        </div>
        <p>{oauthReady ? 'ChatGPT et Codex : choisissez OAuth pour vous connecter avec votre compte Alcove.' : 'Codex et Hermes : utilisez une clé personnelle ci-dessous.'} <a href="https://github.com/KoroKira/alcove/blob/main/docs/MCP.md" target="_blank" rel="noreferrer">Guide de connexion MCP (nouvel onglet)</a></p>
      </>}
      <form onSubmit={create}>
        <fieldset disabled={busy || Boolean(token)}>
          <legend>Nouvelle clé personnelle</legend>
          <label htmlFor={`${id}-name`}>Nom de la connexion</label>
          <input ref={nameRef} id={`${id}-name`} value={name} onChange={e => setName(e.target.value)} maxLength={120} required placeholder="Ex. Codex personnel" />
          <label htmlFor={`${id}-expiry`}>Durée de validité</label>
          <select id={`${id}-expiry`} value={expiresDays} onChange={e => setExpiresDays(e.target.value)}>
            <option value="7">7 jours</option><option value="30">30 jours</option><option value="90">90 jours</option><option value="365">1 an</option>
          </select>
          <p>Lecture de vos pads incluse. Aucune suppression ni modification des pads existants par le MCP.</p>
          <label className="mcp-connections__checkbox"><input type="checkbox" checked={allowWrite} onChange={e => setAllowWrite(e.target.checked)} />Autoriser aussi la création de nouvelles notes</label>
          <button type="submit" disabled={!name.trim() || busy || Boolean(token)}>{busy ? 'En cours…' : 'Créer la clé'}</button>
        </fieldset>
      </form>
      {token && <div className="mcp-connections__secret">
        <label htmlFor={`${id}-token`}>Clé personnelle — affichée une seule fois</label>
        <input ref={tokenRef} id={`${id}-token`} type={visible ? 'text' : 'password'} value={token} readOnly autoComplete="off" spellCheck={false} />
        <div className="mcp-connections__row">
          <button type="button" aria-pressed={visible} onClick={() => setVisible(value => !value)}>{visible ? 'Masquer la clé' : 'Afficher la clé'}</button>
          <button type="button" onClick={() => void copy(token, 'Clé')}>Copier la clé</button>
          <button type="button" onClick={acknowledgeToken}>J’ai enregistré la clé</button>
        </div>
        <p>Conservez-la dans votre gestionnaire de mots de passe. Ne la collez pas dans une conversation ni dans un dépôt Git.</p>
      </div>}
      <h4 ref={connectionsTitleRef} tabIndex={-1}>Vos connexions</h4>
      {keys.length === 0 && <p>Aucune clé personnelle.</p>}
      <ul>{keys.map(key => <li key={key.public_id}>
        <strong>{key.name}</strong> — {key.scopes.includes('write') ? 'Lecture et création' : 'Lecture seule'}
        <span> {key.revoked_at ? 'Révoquée' : key.expires_at ? `Expire le ${new Date(key.expires_at).toLocaleDateString()}` : 'Sans expiration'}</span>
        {!key.revoked_at && (confirmRevoke === key.public_id ? <div className="mcp-connections__row" role="group" aria-label={`Révoquer ${key.name}`} onKeyDown={event => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault(); event.stopPropagation(); cancelRevoke();
          }
        }}>
          <span>L’assistant perdra cet accès.</span>
          <button type="button" disabled={busy} onClick={() => void revoke(key)}>Confirmer la révocation de {key.name}</button>
          <button ref={cancelRevokeRef} type="button" disabled={busy} onClick={cancelRevoke}>Annuler</button>
        </div> : <button ref={button => {
          if (button) revokeButtons.current.set(key.public_id, button);
          else revokeButtons.current.delete(key.public_id);
        }} type="button" disabled={busy} onClick={() => setConfirmRevoke(key.public_id)}>Révoquer {key.name}</button>)}
      </li>)}</ul>
    </>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status" aria-live="polite">{message}</p>}
  </section>;
}
