import { useState, useEffect, useCallback, useRef } from 'react';

// Client-side Ollama URL. Ollama is expected to run on each user's own device;
// the Alcove server never touches it. Override for special setups by setting
// `localStorage.setItem('alcove_ollama_url', 'http://...')`.
// Explicit 127.0.0.1 (not "localhost") to avoid IPv6-first resolution stalls
// on macOS where Ollama binds v4-only.
export function getOllamaUrl(): string {
  try {
    const override = localStorage.getItem('alcove_ollama_url');
    if (override && override.trim()) return override.trim().replace(/\/$/, '');
  } catch { /* SSR / privacy mode — fall through */ }
  // Same-origin proxy: works from every device, avoids mixed-content/PNA and
  // lets the homelab operator choose the inference machine server-side.
  return '/api/ai/ollama';
}

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
  /** Kept for API compat; the browser can no longer auto-start Ollama, so
   * this is always false now. */
  starting: boolean;
  refresh: () => void;
}

/**
 * Poll the user's local Ollama for its installed models. Runs entirely in the
 * browser — no server round-trip — so it works even when the Alcove server
 * has no Ollama of its own (the normal self-host setup).
 *
 * `defaultModel` is fetched once from the server's preamble endpoint so admin
 * config (OLLAMA_DEFAULT_MODEL) still drives the initial pick.
 */
export function useOllamaModels(): OllamaStatus {
  const [status, setStatus] = useState<Omit<OllamaStatus, 'refresh'>>({
    models: [],
    modelNames: [],
    defaultModel: 'llama3.2',
    available: null,
    starting: false,
  });
  const defaultRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    // Fetch server-side default model once — cheap, and it lets admins pick
    // the preferred model from an env var without touching client code.
    if (defaultRef.current === null) {
      try {
        const r = await fetch('/api/ai/chat/preamble');
        if (r.ok) {
          const j = await r.json();
          defaultRef.current = j.default_model || 'llama3.2';
        } else {
          defaultRef.current = 'llama3.2';
        }
      } catch {
        defaultRef.current = 'llama3.2';
      }
    }

    try {
      const url = getOllamaUrl();
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 3000);
      const resp = await fetch(`${url}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timeoutId);
      if (!resp.ok) throw new Error(`Ollama /api/tags returned ${resp.status}`);
      const raw = (await resp.json()).models ?? [];
      const models: OllamaModel[] = raw.map((m: { name: string; size?: number; modified_at?: string }) => ({
        name: m.name,
        size: m.size ?? 0,
        modified: m.modified_at ?? '',
      }));
      setStatus({
        models,
        modelNames: models.map(m => m.name),
        defaultModel: defaultRef.current || 'llama3.2',
        available: true,
        starting: false,
      });
    } catch {
      setStatus(s => ({
        ...s,
        available: false,
        starting: false,
        defaultModel: defaultRef.current || 'llama3.2',
      }));
    }
  }, []);

  useEffect(() => {
    refresh();
    // Re-check every 30s so the UI unlocks automatically when the user starts
    // Ollama on their machine after the app was already loaded.
    const id = setInterval(refresh, 30000);
    return () => clearInterval(id);
  }, [refresh]);

  return { ...status, refresh };
}

/**
 * Stream a chat completion from the user's local Ollama, directly from the
 * browser. `messages` is passed through as-is to Ollama's /api/chat — the
 * caller is responsible for prepending the system-prompt preamble fetched
 * from `/api/ai/chat/preamble`.
 */
export async function streamLocalOllamaChat(
  model: string,
  messages: { role: string; content: string }[],
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = getOllamaUrl();
  const resp = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });

  if (!resp.ok || !resp.body) {
    throw new Error(`Ollama chat failed (${resp.status}) — check that Ollama is running on this device and that OLLAMA_ORIGINS allows this origin.`);
  }

  // Ollama streams NDJSON — one JSON object per line, no `data:` prefix.
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
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const json = JSON.parse(trimmed);
        if (json.error) throw new Error(json.error);
        const text: string = json.message?.content ?? '';
        if (text) onChunk(text);
        if (json.done) return;
      } catch (e: unknown) {
        if (e instanceof SyntaxError) continue; // partial line, wait for more
        throw e;
      }
    }
  }
}



/**
 * Fetch the merged system prompt (BASE + agent-memory pads) from the server.
 * The caller is expected to concatenate the user's own custom_prompt on top
 * before sending it as a system message to Ollama.
 */
export async function fetchChatPreamble(): Promise<{ system: string; defaultModel: string }> {
  const r = await fetch('/api/ai/chat/preamble');
  if (!r.ok) throw new Error(`Preamble fetch failed (${r.status})`);
  const j = await r.json();
  return { system: j.system || '', defaultModel: j.default_model || 'llama3.2' };
}


/**
 * One-shot (non-streaming) chat completion against local Ollama. Returns the
 * full assistant `content` string. Used by pad AI actions that don't need
 * incremental UI updates (tags, title, JSON extraction, single-diagram gen).
 *
 * `format` maps to Ollama's structured-output flag: pass `'json'` to force
 * strict JSON, else omit for free-form text.
 */
export async function oneShotLocalOllama(
  model: string,
  messages: { role: string; content: string }[],
  opts: { format?: 'json'; timeoutMs?: number } = {},
): Promise<string> {
  const url = getOllamaUrl();
  const ctrl = new AbortController();
  const timeoutId = opts.timeoutMs ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : null;
  try {
    const resp = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, ...(opts.format ? { format: opts.format } : {}) }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`Ollama one-shot failed (${resp.status})`);
    const j = await resp.json();
    return (j.message?.content ?? '') as string;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
