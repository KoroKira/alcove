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

import { getOllamaUrl, streamLocalOllamaChat, oneShotLocalOllama } from '../hooks/useOllama';

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
  // Imported pages occasionally contain a gigantic unbroken URL/base64 token.
  // Keep it out of nomic's context window and retry once with a shorter input
  // when Ollama reports a transient 5xx instead of losing the whole pad.
  const inputs = Array.from(new Set([text.slice(0, 6000), text.slice(0, 3000)]));
  let lastStatus = 0;
  for (const prompt of inputs) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await fetch(`${url}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt }),
      });
      lastStatus = resp.status;
      if (resp.ok) {
        const j = await resp.json();
        if (Array.isArray(j.embedding)) return j.embedding as number[];
        throw new Error('Ollama embed returned no vector');
      }
      if (resp.status < 500 && resp.status !== 429) break;
    }
  }
  throw new Error(`Ollama embed failed (${lastStatus || 'network'})`);
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


// ── Agentic RAG chat ────────────────────────────────────────────────────────
//
// Single-shot ragChat above misses relevant material whenever a question wraps
// several angles at once ("compare X and Y and what was the outcome") — one
// embedding of the whole sentence ends up close to nothing in particular. The
// flow below decomposes the question into a handful of focused sub-queries,
// runs the retrieval per sub-query, then unions and dedups the hits. The
// answer is produced with numbered sources so the model's [[N]] citations can
// be turned into clickable chips in the UI (into a Sources drawer that shows
// the exact excerpt and, for video-transcript chunks, a ▶ MM:SS anchor).
//
// Runs entirely in the browser — every LLM call goes to the local Ollama, the
// server only serves the KNN math. Nothing here needs a server-side model.

/** Enumerated source, ready to render as a numbered card + citation chip. */
export interface AgenticSource {
  n: number;
  pad_id: string;
  pad_name: string;
  chunk_text: string;
  score: number;
  /** Populated for chunks whose head is a [MM:SS] or [H:MM:SS] transcript
   * anchor, so the UI can render a ▶ pill that opens the pad at that beat. */
  timestamp_seconds: number | null;
  timestamp_label: string | null;
}

/** Callback bundle for agenticRagChat. Every non-required callback is a
 * silent no-op if omitted, so the same helper works for both the RAG panel
 * (which wants everything) and future callers that just need the answer. */
/** A named step in the agentic pipeline's reasoning trace (chantier #18) —
 * shown as a collapsible "Thought" strip in the UI, mirroring Recall's named
 * tool-call trace ("Getting knowledge base stats ✓", "Listing tags ✓")
 * instead of raw sub-query text. `detail` is a short human-readable result
 * summary shown once the step completes. */
export interface AgenticStep {
  id: string;
  label: string;
  detail?: string;
  status: 'pending' | 'done';
}

export interface AgenticCallbacks {
  onSubqueries?: (items: string[]) => void;
  onSteps?: (steps: AgenticStep[]) => void;
  onSources?: (sources: AgenticSource[]) => void;
  onChunk: (text: string) => void;
  onFollowups?: (items: string[]) => void;
}

const TIMESTAMP_RE = /\[(\d{1,2}(?::\d{2}){1,2})\]/;

function extractTimestamp(chunkText: string): { seconds: number | null; label: string | null } {
  // Scoped to the head so a stray timestamp deep inside a long chunk doesn't
  // hijack the citation.
  const m = chunkText.slice(0, 200).match(TIMESTAMP_RE);
  if (!m) return { seconds: null, label: null };
  const parts = m[1].split(':').map(p => parseInt(p, 10));
  if (parts.some(n => Number.isNaN(n))) return { seconds: null, label: null };
  const seconds = parts.length === 2
    ? parts[0] * 60 + parts[1]
    : parts[0] * 3600 + parts[1] * 60 + parts[2];
  return { seconds, label: m[1] };
}

function tolerantJson<T = unknown>(raw: string): T | null {
  // Some models wrap JSON in prose or <think> blocks — strip both and locate
  // the outermost { ... } before parsing.
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(stripped.slice(start, end + 1)) as T; }
  catch { return null; }
}

async function fanoutSubqueries(
  chatModel: string, question: string, lang: 'fr' | 'en', signal?: AbortSignal,
): Promise<string[]> {
  const prompt = lang === 'fr'
    ? `Décompose cette question en 2 à 5 sous-requêtes courtes et distinctes à utiliser pour une recherche sémantique dans les notes de l'utilisateur. Chaque sous-requête cible un angle différent (définitions, exemples, causes, conséquences, comparaisons…) mais reste en rapport direct avec la question originale. Formule chacune comme une phrase indépendante, pas comme une continuation.\n\nQuestion originale : ${question}\n\nRéponds STRICTEMENT en JSON, aucun texte hors du JSON :\n{"queries": ["...", "..."]}`
    : `Break the question below into 2 to 5 short, distinct sub-queries to be used for semantic search over the user's notes. Each sub-query targets a different angle (definitions, concrete examples, causes, consequences, comparisons…) while staying directly related to the original question. Phrase each as a standalone sentence, not a continuation.\n\nOriginal question: ${question}\n\nReply STRICTLY as JSON, no text outside the JSON:\n{"queries": ["...", "..."]}`;
  let queries: string[] = [];
  try {
    const raw = await oneShotLocalOllama(
      chatModel,
      [{ role: 'user', content: prompt }],
      { format: 'json', timeoutMs: 30000 },
    );
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const parsed = tolerantJson<{ queries: unknown }>(raw);
    if (parsed && Array.isArray(parsed.queries)) {
      queries = parsed.queries
        .filter((q): q is string => typeof q === 'string')
        .map(q => q.trim())
        .filter(Boolean);
    }
  } catch {
    // Fanout failure degrades gracefully to "just the original question".
  }
  // Always run the original question too, dedup case-insensitively, cap at 6.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of [question, ...queries]) {
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out.slice(0, 6);
}

async function followupQuestions(
  chatModel: string, question: string, answer: string, lang: 'fr' | 'en',
): Promise<string[]> {
  const prompt = lang === 'fr'
    ? `Question posée et réponse déjà donnée ci-dessous. Propose EXACTEMENT 3 questions de suivi courtes (≤ 12 mots), pertinentes, sans redondance entre elles ni avec la question originale.\n\nQuestion : ${question}\nRéponse : ${answer.slice(0, 2000)}\n\nRéponds STRICTEMENT en JSON : {"followups": ["…", "…", "…"]}`
    : `The question and its answer are below. Propose EXACTLY 3 short, relevant, non-redundant follow-up questions (≤ 12 words each).\n\nQuestion: ${question}\nAnswer: ${answer.slice(0, 2000)}\n\nReply STRICTLY as JSON: {"followups": ["…", "…", "…"]}`;
  try {
    const raw = await oneShotLocalOllama(
      chatModel,
      [{ role: 'user', content: prompt }],
      { format: 'json', timeoutMs: 30000 },
    );
    const parsed = tolerantJson<{ followups: unknown }>(raw);
    if (!parsed || !Array.isArray(parsed.followups)) return [];
    return parsed.followups
      .filter((q): q is string => typeof q === 'string')
      .map(q => q.trim())
      .filter(Boolean)
      .slice(0, 3);
  } catch {
    return [];
  }
}

/** Cap on chunks kept AFTER dedup across sub-queries. Prompt scales roughly
 * linearly with this — 8 chunks × ~1600 chars ≈ 13k chars, which fits a 12k
 * token context without pushing the answer against num_predict. */
const AGENTIC_MAX_SOURCES = 8;

export async function agenticRagChat(
  chatModel: string,
  question: string,
  callbacks: AgenticCallbacks,
  opts: {
    topKPerSubquery?: number; lang?: 'fr' | 'en'; embedModel?: string; signal?: AbortSignal;
    /** Active persona's system-prompt addendum (chantier #17) — appended
     * after the memory preamble, before the citation/answering rules. */
    personaInstructions?: string;
  } = {},
): Promise<void> {
  const { topKPerSubquery = 5, lang = 'fr', embedModel = EMBED_MODEL_DEFAULT, signal, personaInstructions } = opts;

  const steps: AgenticStep[] = [
    { id: 'fanout', label: lang === 'fr' ? 'Décomposition de la question' : 'Decomposing the question', status: 'pending' },
    { id: 'retrieval', label: lang === 'fr' ? 'Recherche sémantique' : 'Semantic search', status: 'pending' },
  ];
  callbacks.onSteps?.(steps);

  // 1. Fanout ---------------------------------------------------------------
  const queries = await fanoutSubqueries(chatModel, question, lang, signal);
  callbacks.onSubqueries?.(queries);
  steps[0] = {
    ...steps[0], status: 'done',
    detail: lang === 'fr' ? `${queries.length} sous-requêtes` : `${queries.length} sub-queries`,
  };
  callbacks.onSteps?.([...steps]);

  // 2. Retrieve per sub-query in parallel, union+dedup by (pad_id, chunk_text).
  // Chunk index isn't exposed by /rag/knn today so we key on the text — for a
  // single owner that's unique in practice (same text under two different
  // indexes is a duplicate we'd want to drop anyway).
  const perQuery = await Promise.all(queries.map(async (q) => {
    try {
      const vec = await embedText(q, embedModel);
      const r = await fetch('/api/ai/rag/knn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ query_embedding: vec, top_k: topKPerSubquery }),
        signal,
      });
      if (!r.ok) return [] as RagMatch[];
      return (await r.json()).results as RagMatch[] || [];
    } catch { return [] as RagMatch[]; }
  }));

  const best = new Map<string, { score: number; match: RagMatch }>();
  for (const matches of perQuery) {
    for (const m of matches) {
      const key = `${m.pad_id}::${m.chunk_text.slice(0, 100)}`;
      const cur = best.get(key);
      if (!cur || m.score > cur.score) best.set(key, { score: m.score, match: m });
    }
  }
  const selected = Array.from(best.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, AGENTIC_MAX_SOURCES);

  const sources: AgenticSource[] = selected.map(({ score, match }, i) => {
    const { seconds, label } = extractTimestamp(match.chunk_text);
    return {
      n: i + 1,
      pad_id: match.pad_id,
      pad_name: match.pad_name,
      chunk_text: match.chunk_text,
      score,
      timestamp_seconds: seconds,
      timestamp_label: label,
    };
  });
  callbacks.onSources?.(sources);
  steps[1] = {
    ...steps[1], status: 'done',
    detail: lang === 'fr' ? `${sources.length} sources trouvées` : `${sources.length} sources found`,
  };
  callbacks.onSteps?.([...steps]);

  // 3. Memory preamble (best-effort)
  const { fetchChatPreamble } = await import('../hooks/useOllama');
  let memPrefix = '';
  try { memPrefix = (await fetchChatPreamble()).system; } catch { /* offline preamble is fine */ }
  if (memPrefix) memPrefix = memPrefix.trim() + '\n\n';
  if (personaInstructions?.trim()) {
    memPrefix += `Instructions de la persona active :\n${personaInstructions.trim().slice(0, 2000)}\n\n`;
  }

  // 4. Build the enumerated-sources prompt.
  let system: string;
  if (sources.length) {
    const context = sources
      .map(s => {
        // Truncate very long excerpts in the prompt itself — the drawer still
        // shows the full 500-char version to the user.
        const excerpt = s.chunk_text.length > 1200
          ? s.chunk_text.slice(0, 1200).trimEnd() + '…'
          : s.chunk_text;
        return `[${s.n}] « ${s.pad_name} »\n${excerpt}`;
      })
      .join('\n\n---\n\n');
    system = lang === 'fr'
      ? `${memPrefix}Tu es l'assistant personnel de l'utilisateur. Tu réponds aux questions en te basant EXCLUSIVEMENT sur les extraits de notes numérotés ci-dessous. Si les extraits ne contiennent pas la réponse, dis-le franchement plutôt que d'inventer.\n\nRÈGLE DE CITATION : chaque fois que tu utilises une information issue d'un extrait, marque-le immédiatement par [[N]] où N est le numéro entre crochets de la source. Exemple : « Le taux de conversion a doublé en 2024 [[2]]. » Plusieurs sources : [[1]][[3]]. Ne mets JAMAIS un [[N]] pour une source qui n'est pas listée.\n\nSOURCES NUMÉROTÉES :\n\n${context}\n\nRéponds en français, précis et concis, structure en paragraphes ou puces selon la question.`
      : `${memPrefix}You are the user's personal assistant. Answer using ONLY the numbered note excerpts below. If they don't contain the answer, say so plainly instead of guessing.\n\nCITATION RULE: every time you use information from an excerpt, immediately mark it with [[N]] where N is the bracketed source number. Example: "Conversion doubled in 2024 [[2]]." Multiple sources: [[1]][[3]]. NEVER emit a [[N]] for a source that isn't listed.\n\nNUMBERED SOURCES:\n\n${context}\n\nAnswer in English, precise and concise, structured in paragraphs or bullets as fits the question.`;
  } else {
    system = lang === 'fr'
      ? `${memPrefix}Tu es un assistant. Aucune note pertinente n'a été trouvée pour cette question — indique-le à l'utilisateur et propose de reformuler ou d'indexer davantage de notes.`
      : `${memPrefix}You are an assistant. No relevant notes were found for this question — say so and suggest rephrasing or indexing more notes.`;
  }

  // 5. Stream the answer, accumulating for the follow-up call below.
  const answerParts: string[] = [];
  await streamLocalOllamaChat(
    chatModel,
    [{ role: 'system', content: system }, { role: 'user', content: question }],
    (tok) => { answerParts.push(tok); callbacks.onChunk(tok); },
    signal,
  );

  // 6. Follow-up questions — best-effort, silent no-op on failure.
  if (callbacks.onFollowups) {
    const answer = answerParts.join('').trim();
    if (answer && !signal?.aborted) {
      const followups = await followupQuestions(chatModel, question, answer, lang);
      if (followups.length) callbacks.onFollowups(followups);
    }
  }
}
