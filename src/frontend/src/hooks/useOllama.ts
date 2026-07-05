import { useState, useEffect, useCallback, useRef } from 'react';

export interface OllamaModel {
  name: string;
  size: number;
  modified: string;
}

export interface OllamaStatus {
  models: OllamaModel[];
  modelNames: string[];
  defaultModel: string;
  available: boolean | null;
  /** true when ollama is installed but being auto-started */
  starting: boolean;
  refresh: () => void;
}

export function useOllamaModels(): OllamaStatus {
  const [status, setStatus] = useState<Omit<OllamaStatus, 'refresh'>>({
    models: [],
    modelNames: [],
    defaultModel: 'llama3.2',
    available: null,
    starting: false,
  });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const refresh = useCallback(() => {
    fetch('/api/ai/models')
      .then(r => r.json())
      .then(data => {
        const raw = data.models ?? [];
        const models: OllamaModel[] = Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'object'
          ? raw
          : raw.map((n: string) => ({ name: n, size: 0, modified: '' }));
        const available = data.available ?? false;
        const starting = !available && (data.starting ?? false);
        setStatus({
          models,
          modelNames: models.map(m => m.name),
          defaultModel: data.default || 'llama3.2',
          available,
          starting,
        });
        if (available) {
          stopPoll();
        } else if (starting && !pollRef.current) {
          // Auto-poll every 2s until Ollama is up
          pollRef.current = setInterval(() => {
            fetch('/api/ai/models')
              .then(r => r.json())
              .then(d => {
                if (d.available) {
                  const r2 = d.models ?? [];
                  const m2: OllamaModel[] = Array.isArray(r2) && r2.length > 0 && typeof r2[0] === 'object'
                    ? r2
                    : r2.map((n: string) => ({ name: n, size: 0, modified: '' }));
                  setStatus({ models: m2, modelNames: m2.map(m => m.name), defaultModel: d.default || 'llama3.2', available: true, starting: false });
                  stopPoll();
                }
              })
              .catch(() => {});
          }, 2000);
        }
      })
      .catch(() => setStatus(s => ({ ...s, available: false, starting: false })));
  }, []);

  useEffect(() => {
    refresh();
    return stopPoll;
  }, [refresh]);

  return { ...status, refresh };
}

export async function streamOllamaChat(
  model: string,
  messages: { role: string; content: string }[],
  onChunk: (text: string) => void,
  endpoint = '/api/ai/chat',
  extraBody: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<void> {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, ...extraBody }),
    signal,
  });

  if (!resp.ok || !resp.body) throw new Error(`AI error ${resp.status}`);

  const reader = resp.body.getReader();
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
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        if (json.error) throw new Error(json.error);
        const text: string = json.message?.content ?? '';
        if (text) onChunk(text);
      } catch (e: unknown) {
        if (e instanceof Error && e.message !== 'Unexpected end of JSON input') throw e;
      }
    }
  }
}
