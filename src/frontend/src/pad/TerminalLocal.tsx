import React, { useEffect, useState } from 'react';
import { useAppConfig } from '../hooks/useAppConfig';

export const TerminalLocal: React.FC = () => {
  const { config } = useAppConfig();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  const ttydUrl = (config as any)?.ttydUrl || 'http://localhost:7681';

  useEffect(() => {
    fetch(ttydUrl, { mode: 'no-cors' })
      .then(() => setReady(true))
      .catch(() => setError(true));
  }, [ttydUrl]);

  if (error) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--ap-red)', fontFamily: 'var(--ap-font-mono)', fontSize: 13, flexDirection: 'column', gap: 8 }}>
      <div>ttyd non disponible sur {ttydUrl}</div>
      <div style={{ color: 'var(--ap-text2)', fontSize: 11 }}>Vérifie que <code>brew services start ttyd</code> tourne</div>
    </div>
  );

  return (
    <iframe
      src={ttydUrl}
      style={{ width: '100%', height: '100%', border: 'none', display: ready ? 'block' : 'none' }}
      onLoad={() => setReady(true)}
      allow="clipboard-read; clipboard-write"
      title="Terminal local"
    />
  );
};

export default TerminalLocal;
