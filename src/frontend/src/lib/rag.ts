/**
 * Client-side RAG (Phase 3C).
 *
 * The server never touches Ollama anymore; the browser does:
 *   • chunk text (same algorithm as the retired Python `chunk_text`)
 *   • embed each chunk via localhost Ollama /api/embeddings
 *   • POST the chunks + embeddings to /api/ai/rag/index-chunks
 *
 * For search: embed the query locally, POST to /api/ai/rag/knn, get back the
 * top-k matches. `ragChat` chains the KNN → prompt → streaming completion.
 */

import { getOllamaUrl, streamLocalOllamaChat } from '../hooks/useOllama';

export const EMBED_MODEL_DEFAULT = 'nomic-embed-text';
const CHUNK_SIZE = 400;      // words
const CHUNK_OVERLAP = 60;

/** Mirror of the retired Python `chunk_text` — word-based sliding window. */
export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const chunks: string[] = [];
  const step = Math.max(1, size - overlap);
  for (let i = 0; i < words.length; i += step) {
    const chunk = words.slice(i, i + size).join(' ');
    if (chunk.trim()) chunks.push(chunk);
  }
  return chunks;
}

/** Embed a single text via the local Ollama instance. Throws on non-2xx. */
export async function embedText(text: string, model = EMBED_MODEL_DEFAULT): Promise<number[]> {
  const url = getOllamaUrl();
  const resp = await fetch(`${url}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!resp.ok) throw new Error(`Ollama embed failed (${resp.status})`);
  const j = await resp.json();
  const vec = j.embedding;
  if (!Array.isArray(vec)) throw new Error('Ollama embed returned no vector');
  return vec as number[];
}


// ── Indexing ────────────────────────────────────────────────────────────────

export interface IndexProgress {
  padId: string;
  displayName: string;
  chunks: number;
  status: 'chunking' | 'embedding' | 'storing' | 'done' | 'error';
  error?: string;
}

/** Index a single pad end-to-end (fetch text → chunk → embed → store). */
export async function indexPad(
  padId: string,
  onProgress?: (p: IndexProgress) => void,
  model = EMBED_MODEL_DEFAULT,
): Promise<number> {
  const meta = await fetch(`/api/ai/rag/indexable-text/${padId}`, { credentials: 'include' })
    .then(r => { if (!r.ok) throw new Error(`indexable-text ${r.status}`); return r.json(); });
  const displayName = meta.display_name || '';

  onProgress?.({ padId, displayName, chunks: 0, status: 'chunking' });
  const chunks = chunkText(meta.text || '');
  if (!chunks.length) {
    // Empty text — tell the server to drop any existing embeddings for this pad.
    await fetch('/api/ai/rag/index-chunks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ pad_id: padId, chunks: [] }),
    });
    onProgress?.({ padId, displayName, chunks: 0, status: 'done' });
    return 0;
  }

  onProgress?.({ padId, displayName, chunks: chunks.length, status: 'embedding' });
  const payload: { index: number; text: string; embedding: number[] }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const vec = await embedText(chunks[i], model);
    payload.push({ index: i, text: chunks[i], embedding: vec });
  }

  onProgress?.({ padId, displayName, chunks: chunks.length, status: 'storing' });
  const resp = await fetch('/api/ai/rag/index-chunks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ pad_id: padId, chunks: payload }),
  });
  if (!resp.ok) throw new Error(`index-chunks ${resp.status}`);
  onProgress?.({ padId, displayName, chunks: chunks.length, status: 'done' });
  return chunks.length;
}


/** Reindex every pad the user owns. Server returns the pad list + extracted
 * text in one call so we avoid N+1 round-trips on /rag/indexable-text/{id}. */
export async function indexAll(
  onProgress?: (p: IndexProgress & { current: number; total: number }) => void,
  model = EMBED_MODEL_DEFAULT,
): Promise<{ pads: number; totalChunks: number }> {
  const list = await fetch('/api/ai/rag/indexable-list', { credentials: 'include' })
    .then(r => { if (!r.ok) throw new Error(`indexable-list ${r.status}`); return r.json(); });
  const pads: { pad_id: string; display_name: string; text: string }[] = list.pads || [];
  const total = pads.length;

  let done = 0;
  let indexedPads = 0;
  let totalChunks = 0;

  for (const p of pads) {
    onProgress?.({
      padId: p.pad_id, displayName: p.display_name, chunks: 0,
      status: 'chunking', current: done, total,
    });
    const chunks = chunkText(p.text || '');
    if (!chunks.length) {
      await fetch('/api/ai/rag/index-chunks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ pad_id: p.pad_id, chunks: [] }),
      });
      done += 1;
      onProgress?.({
        padId: p.pad_id, displayName: p.display_name, chunks: 0,
        status: 'done', current: done, total,
      });
      continue;
    }

    onProgress?.({
      padId: p.pad_id, displayName: p.display_name, chunks: chunks.length,
      status: 'embedding', current: done, total,
    });
    try {
      const payload: { index: number; text: string; embedding: number[] }[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const vec = await embedText(chunks[i], model);
        payload.push({ index: i, text: chunks[i], embedding: vec });
      }
      const resp = await fetch('/api/ai/rag/index-chunks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ pad_id: p.pad_id, chunks: payload }),
      });
      if (!resp.ok) throw new Error(`index-chunks ${resp.status}`);
      indexedPads += 1;
      totalChunks += chunks.length;
      done += 1;
      onProgress?.({
        padId: p.pad_id, displayName: p.display_name, chunks: chunks.length,
        status: 'done', current: done, total,
      });
    } catch (e) {
      done += 1;
      onProgress?.({
        padId: p.pad_id, displayName: p.display_name, chunks: chunks.length,
        status: 'error', error: e instanceof Error ? e.message : String(e),
        current: done, total,
      });
    }
  }
  return { pads: indexedPads, totalChunks };
}


// ── Search + RAG chat ───────────────────────────────────────────────────────

export interface RagMatch {
  score: number;
  pad_id: string;
  pad_name: string;
  chunk_text: string;
}

/** Semantic search: embed the query, KNN-rank on server, return matches. */
export async function searchRag(
  query: string, topK = 5, model = EMBED_MODEL_DEFAULT,
): Promise<RagMatch[]> {
  const q = await embedText(query, model);
  const r = await fetch('/api/ai/rag/knn', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ query_embedding: q, top_k: topK }),
  });
  if (!r.ok) throw new Error(`rag/knn ${r.status}`);
  const j = await r.json();
  return j.results || [];
}


/** RAG-augmented chat: embed the question, retrieve chunks, ask Ollama with
 * the context stitched into the system prompt, stream the completion.
 *
 * `onSources` fires once (with the retrieved matches) before streaming starts,
 * so the UI can render the citation strip before the first token lands.
 */
export async function ragChat(
  chatModel: string,
  question: string,
  onSources: (sources: RagMatch[]) => void,
  onChunk: (text: string) => void,
  opts: { topK?: number; lang?: 'fr' | 'en'; embedModel?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const { topK = 5, lang = 'fr', embedModel = EMBED_MODEL_DEFAULT, signal } = opts;

  // 1. Retrieve context
  const q = await embedText(question, embedModel);
  const knn = await fetch('/api/ai/rag/knn', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ query_embedding: q, top_k: topK }),
    signal,
  });
  if (!knn.ok) throw new Error(`rag/knn ${knn.status}`);
  const matches: RagMatch[] = (await knn.json()).results || [];
  onSources(matches);

  // 2. Pull the agent memory preamble (same helper the plain chat uses)
  const { fetchChatPreamble } = await import('../hooks/useOllama');
  let memPrefix = '';
  try { memPrefix = (await fetchChatPreamble()).system; } catch { /* preamble is best-effort */ }
  if (memPrefix) memPrefix = memPrefix.trim() + '\n\n';

  // 3. Build the system prompt in the same shape the old server route used
  let system: string;
  if (matches.length) {
    const context = matches.map(m => `[${m.pad_name}]\n${m.chunk_text}`).join('\n\n---\n\n');
    system = lang === 'fr'
      ? `${memPrefix}Tu es un assistant qui répond aux questions en te basant sur les notes de l'utilisateur.\n`
        + `Voici les extraits pertinents de ses notes :\n\n${context}\n\n`
        + `Réponds en français, de façon concise et précise. Cite les noms des notes sources entre crochets quand tu les utilises.`
      : `${memPrefix}You are an assistant that answers questions based on the user's notes.\n`
        + `Here are the relevant excerpts:\n\n${context}\n\n`
        + `Answer concisely. Cite source note names in brackets when you use them.`;
  } else {
    system = lang === 'fr'
      ? `${memPrefix}Tu es un assistant. Aucune note pertinente n'a été trouvée pour cette question.`
      : `${memPrefix}You are an assistant. No relevant notes were found for this question.`;
  }

  // 4. Stream the completion
  await streamLocalOllamaChat(
    chatModel,
    [
      { role: 'system', content: system },
      { role: 'user', content: question },
    ],
    onChunk,
    signal,
  );
}
