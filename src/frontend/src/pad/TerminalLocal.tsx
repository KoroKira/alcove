import React, { useEffect, useState } from 'react';
import { useAppConfig } from '../hooks/useAppConfig';

export const TerminalLocal: React.FC = () => {
  const { config } = useAppConfig();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  const ttydUrl = config?.ttydUrl?.trim() ?? '';

  useEffect(() => {
    setReady(false);
    setError(false);
  }, [ttydUrl]);

  if (!ttydUrl) return (
    <div role="status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--ap-text2)', fontFamily: 'var(--ap-font-mono)', fontSize: 13 }}>
      Terminal désactivé : aucune URL de terminal n’est configurée.
    </div>
  );

  if (error) return (
    <div role="alert" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--ap-red)', fontFamily: 'var(--ap-font-mono)', fontSize: 13, flexDirection: 'column', gap: 8 }}>
      <div>Impossible de charger le terminal configuré.</div>
      <div style={{ color: 'var(--ap-text2)', fontSize: 11 }}>Vérifie la configuration du service et son accès depuis ce navigateur.</div>
    </div>
  );

  return (
    <>
      {!ready && <div role="status" style={{ padding: 12, color: 'var(--ap-text2)' }}>Chargement du terminal…</div>}
      <iframe
        src={ttydUrl}
        style={{ width: '100%', height: ready ? '100%' : '0', border: 'none' }}
        onLoad={() => setReady(true)}
        onError={() => setError(true)}
        allow="clipboard-read; clipboard-write"
        title="Terminal configuré"
      />
    </>
  );
};

export default TerminalLocal;
