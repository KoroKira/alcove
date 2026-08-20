/**
 * Client-side AI prompt library.
 *
 * Phase 3B: since the self-host server no longer runs Ollama, every generation
 * that used to live at /api/ai/* moves here — the browser assembles the prompt
 * and talks to its own local Ollama directly. Prompts are duplicated from the
 * old backend routes and kept in French unless the caller passes lang='en'.
 *
 * Each exported function returns a typed value ready for the caller (a parsed
 * array of tags, a Mermaid code block, a synthesised Markdown note, …), so
 * call sites stay small and don't need to know about Ollama's response shape.
 */

import { streamLocalOllamaChat, oneShotLocalOllama } from '../hooks/useOllama';

type Lang = 'fr' | 'en';

/** Strip DeepSeek/R1-style `<think>…</think>` blocks from a raw completion. */
function stripThink(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** Pull the first JSON array out of a tolerant model reply. Returns [] on miss. */
function extractJsonArray(raw: string): unknown[] {
  const cleaned = stripThink(raw);
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']') + 1;
  if (start < 0 || end <= start) return [];
  try { return JSON.parse(cleaned.slice(start, end)); } catch { return []; }
}

/** Pull the first JSON object out of a tolerant model reply. Returns {} on miss. */
function extractJsonObject(raw: string): Record<string, unknown> {
  const cleaned = stripThink(raw);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}') + 1;
  if (start < 0 || end <= start) return {};
  try { return JSON.parse(cleaned.slice(start, end)); } catch { return {}; }
}


// ── Summarize (streaming) ───────────────────────────────────────────────────

export async function summarize(
  model: string, content: string, lang: Lang,
  onChunk: (text: string) => void, signal?: AbortSignal,
): Promise<void> {
  const langInstr = lang === 'fr' ? 'in French' : 'in English';
  const prompt =
    `Summarize the following document concisely ${langInstr}, `
    + `in 3-5 bullet points. Do not add any preamble.\n\n${content.slice(0, 8000)}`;
  await streamLocalOllamaChat(model, [{ role: 'user', content: prompt }], onChunk, signal);
}


// ── Suggest tags (one-shot, JSON array) ────────────────────────────────────

export async function suggestTags(
  model: string, content: string, title: string, lang: Lang,
): Promise<string[]> {
  const langInstr = lang === 'fr' ? 'in French' : 'in English';
  const prompt =
    `Given the document titled "${title}" with content below, `
    + `suggest 3 to 5 short lowercase tags ${langInstr} (single words or hyphenated). `
    + `Reply ONLY with a JSON array of strings, nothing else.\n\n${content.slice(0, 4000)}`;
  const raw = await oneShotLocalOllama(model, [{ role: 'user', content: prompt }], { timeoutMs: 30_000 });
  const arr = extractJsonArray(raw);
  return arr.filter((t): t is string => typeof t === 'string').map(t => t.toLowerCase().trim());
}


// ── Suggest title (one-shot, single line) ──────────────────────────────────

export async function suggestTitle(
  model: string, content: string, lang: Lang,
): Promise<string> {
  const langInstr = lang === 'fr' ? 'en français' : 'in English';
  const prompt =
    `Propose un titre court (3 à 6 mots, ${langInstr}) pour le document ci-dessous. `
    + `Réponds UNIQUEMENT avec le titre, sans guillemets, sans ponctuation finale, sans préambule.\n\n`
    + content.slice(0, 4000);
  const raw = await oneShotLocalOllama(model, [{ role: 'user', content: prompt }], { timeoutMs: 30_000 });
  const cleaned = stripThink(raw).replace(/^["'\s]+|["'\s]+$/g, '').split('\n')[0]?.slice(0, 80) ?? '';
  return cleaned;
}


// ── Extract info (one-shot, Markdown + URL list) ───────────────────────────

export async function extractInfo(
  model: string, content: string, lang: Lang,
): Promise<{ info: string; urls: string[] }> {
  // Deterministic URL scrape (same as the old backend did before calling Ollama)
  const urls = Array.from(new Set(
    Array.from(content.matchAll(/https?:\/\/[^\s)\]<>"']+/g), m => m[0])
  )).slice(0, 15);

  const prompt = lang === 'fr'
    ? `À partir du texte ci-dessous (souvent une description de vidéo), extrais en français :\n`
      + `- **Intervenants** : personnes / invités / auteurs cités\n`
      + `- **Thème** : le sujet principal en une phrase\n`
      + `- **Points clés** : 3 à 5 puces\n`
      + `Réponds en Markdown avec ces sections. Sois concis. N'invente rien : si une info manque, écris « — ».\n\n`
      + content.slice(0, 6000)
    : `From the text below (often a video description), extract:\n`
      + `- **People**: speakers / guests / authors mentioned\n`
      + `- **Theme**: the main topic in one sentence\n`
      + `- **Key points**: 3 to 5 bullets\n`
      + `Reply in Markdown with these sections. Be concise. Do not invent: use "—" if missing.\n\n`
      + content.slice(0, 6000);

  let info = '';
  try {
    const raw = await oneShotLocalOllama(model, [{ role: 'user', content: prompt }], { timeoutMs: 60_000 });
    info = stripThink(raw);
  } catch { /* keep info empty */ }

  if (urls.length) {
    info += '\n\n**Sources / liens**\n\n' + urls.map(u => `- ${u}`).join('\n');
  }
  return { info, urls };
}


// ── Suggest links to other pads (one-shot, JSON array) ─────────────────────

export async function suggestLinks(
  model: string, content: string, padTitles: string[], lang: Lang,
): Promise<string[]> {
  const list = padTitles.slice(0, 100).map(t => `- ${t}`).join('\n');
  const prompt = lang === 'fr'
    ? `Voici une liste de notes disponibles :\n${list}\n\n`
      + `Voici le contenu d'une note :\n${content.slice(0, 3000)}\n\n`
      + `Identifie les notes de la liste qui sont pertinentes à citer dans cette note sous forme de liens [[NomDeLaNote]]. `
      + `Réponds UNIQUEMENT avec un tableau JSON de strings, ex: ["NomNote1", "NomNote2"]. `
      + `Maximum 5 suggestions. Si aucune n'est pertinente, retourne [].`
    : `Here is a list of available notes:\n${list}\n\n`
      + `Here is a note's content:\n${content.slice(0, 3000)}\n\n`
      + `Identify notes from the list that are relevant to cite in this note as [[NoteName]] links. `
      + `Reply ONLY with a JSON array of strings, e.g. ["Note1", "Note2"]. `
      + `Max 5 suggestions. If none are relevant, return [].`;
  const raw = await oneShotLocalOllama(model, [{ role: 'user', content: prompt }], { timeoutMs: 60_000 });
  const arr = extractJsonArray(raw)
    .filter((s): s is string => typeof s === 'string')
    .filter(s => padTitles.includes(s));
  return arr.slice(0, 5);
}


// ── Generate flashcards (one-shot, Q:/A: block) ────────────────────────────

export async function generateFlashcards(
  model: string, content: string, lang: Lang,
): Promise<string> {
  const prompt = lang === 'fr'
    ? `Voici le contenu d'une note :\n\n${content.slice(0, 4000)}\n\n`
      + `Génère entre 3 et 8 flashcards pédagogiques sous ce format EXACT `
      + `(respecte bien les préfixes Q: et A: en début de ligne) :\n\n`
      + `Q: [question claire et concise]\n`
      + `A: [réponse courte et précise]\n\n`
      + `Génère uniquement les paires Q:/A:, sans introduction ni commentaire.`
    : `Here is a note's content:\n\n${content.slice(0, 4000)}\n\n`
      + `Generate between 3 and 8 educational flashcards in this EXACT format `
      + `(keep Q: and A: at the start of each line):\n\n`
      + `Q: [clear, concise question]\n`
      + `A: [short, precise answer]\n\n`
      + `Output only the Q:/A: pairs, no intro or commentary.`;
  const raw = await oneShotLocalOllama(model, [{ role: 'user', content: prompt }], { timeoutMs: 120_000 });
  const cleaned = stripThink(raw).trim();
  if (cleaned.includes('Q:') && cleaned.includes('A:')) return cleaned;
  return '';
}


// ── Generate quiz (chantier #19) ────────────────────────────────────────────
//
// Distinct from generateFlashcards above: flashcards feed the FSRS-5 spaced-
// repetition deck (long-term retention, graded review scheduling). A quiz is
// an ungraded, one-off "check your understanding" session for THIS note right
// now — closer to Recall's per-card "Test Your Knowledge" tab. Same Q/A shape
// under the hood (still the model's easiest reliable output format) but
// consumed by QuizModal as a linear self-check flow, not persisted anywhere.

export interface QuizQuestion { q: string; a: string; }

export async function generateQuiz(
  model: string, content: string, lang: Lang,
): Promise<QuizQuestion[]> {
  const prompt = lang === 'fr'
    ? `Voici le contenu d'une note :\n\n${content.slice(0, 4000)}\n\n`
      + `Génère entre 4 et 8 questions pour vérifier la compréhension de ce contenu, `
      + `sous ce format EXACT (respecte bien les préfixes Q: et A: en début de ligne) :\n\n`
      + `Q: [question qui teste la compréhension, pas juste la mémorisation d'un mot]\n`
      + `A: [réponse complète en une ou deux phrases]\n\n`
      + `Varie la difficulté et les angles. Génère uniquement les paires Q:/A:, sans introduction ni commentaire.`
    : `Here is a note's content:\n\n${content.slice(0, 4000)}\n\n`
      + `Generate between 4 and 8 questions that check understanding of this content, `
      + `in this EXACT format (keep Q: and A: at the start of each line):\n\n`
      + `Q: [a question testing understanding, not just word recall]\n`
      + `A: [a complete answer in one or two sentences]\n\n`
      + `Vary difficulty and angle. Output only the Q:/A: pairs, no intro or commentary.`;
  const raw = await oneShotLocalOllama(model, [{ role: 'user', content: prompt }], { timeoutMs: 120_000 });
  const cleaned = stripThink(raw);
  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
  const out: QuizQuestion[] = [];
  let pendingQ: string | null = null;
  for (const line of lines) {
    if (line.startsWith('Q:')) pendingQ = line.slice(2).trim();
    else if (line.startsWith('A:') && pendingQ) {
      out.push({ q: pendingQ, a: line.slice(2).trim() });
      pendingQ = null;
    }
  }
  return out;
}


// ── Named entity extraction (chantier #6) ───────────────────────────────────
//
// Recall's most distinctive feature: every proper noun in a summary becomes a
// first-class pad, auto-seeded from Wikipedia. Client-side per the Phase 3C
// pattern — extraction via the local Ollama, Wikipedia fetch via its public
// REST API (CORS-enabled, no key needed), pad creation via the existing
// POST /api/pad/new (now takes `content` for document pads).

export type EntityType = 'person' | 'org' | 'place' | 'concept';

export interface ExtractedEntity {
  name: string;
  type: EntityType;
}

export async function extractEntities(
  model: string, content: string, lang: Lang,
): Promise<ExtractedEntity[]> {
  const prompt = lang === 'fr'
    ? `Voici le contenu d'une note :\n\n${content.slice(0, 6000)}\n\n`
      + `Identifie les entités nommées importantes (personnes, organisations, lieux, concepts notables) `
      + `qui mériteraient chacune leur propre fiche de référence. Ignore les entités trop génériques ou triviales.\n\n`
      + `Réponds STRICTEMENT en JSON, aucun texte hors du JSON :\n`
      + `{"entities": [{"name": "Nom exact", "type": "person|org|place|concept"}]}\n\n`
      + `Maximum 10 entités, seulement les plus pertinentes.`
    : `Here is a note's content:\n\n${content.slice(0, 6000)}\n\n`
      + `Identify important named entities (people, organizations, places, notable concepts) `
      + `that would each deserve their own reference card. Skip anything too generic or trivial.\n\n`
      + `Reply STRICTLY as JSON, no text outside the JSON:\n`
      + `{"entities": [{"name": "Exact name", "type": "person|org|place|concept"}]}\n\n`
      + `Maximum 10 entities, only the most relevant ones.`;
  const raw = await oneShotLocalOllama(model, [{ role: 'user', content: prompt }], { format: 'json', timeoutMs: 60_000 });
  const obj = extractJsonObject(raw);
  const list = obj.entities;
  if (!Array.isArray(list)) return [];
  const validTypes: EntityType[] = ['person', 'org', 'place', 'concept'];
  const out: ExtractedEntity[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String((item as Record<string, unknown>).name ?? '').trim();
    const rawType = String((item as Record<string, unknown>).type ?? '').trim() as EntityType;
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, type: validTypes.includes(rawType) ? rawType : 'concept' });
  }
  return out.slice(0, 10);
}

export interface WikipediaSummary {
  title: string;
  extract: string;
  url: string;
  thumbnail?: string;
}

/** Fetch a Wikipedia intro summary via the public REST API. No key, CORS
 * enabled on Wikimedia's side. Returns null on a 404 (no matching article) —
 * that's an expected outcome for niche/local entities, not an error. */
export async function fetchWikipediaSummary(
  name: string, lang: Lang,
): Promise<WikipediaSummary | null> {
  const wikiLang = lang === 'fr' ? 'fr' : 'en';
  const url = `https://${wikiLang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/ /g, '_'))}`;
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.type === 'disambiguation' || !data.extract) return null;
    return {
      title: data.title || name,
      extract: data.extract as string,
      url: data.content_urls?.desktop?.page || `https://${wikiLang}.wikipedia.org/wiki/${encodeURIComponent(name)}`,
      thumbnail: data.thumbnail?.source,
    };
  } catch { return null; }
}


// ── Generate diagram (one-shot, Mermaid code block) ────────────────────────

const MERMAID_KINDS = 'flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, mindmap, or pie';

export async function generateDiagram(
  model: string, content: string, kind: string | undefined, lang: Lang,
): Promise<string> {
  const kindInstr = kind
    ? `Use a Mermaid "${kind}" diagram.`
    : `Pick whichever Mermaid diagram type (${MERMAID_KINDS}) best represents this content.`;
  const prompt = lang === 'fr'
    ? `Voici le contenu d'une note :\n\n${content.slice(0, 4000)}\n\n`
      + `Génère un diagramme Mermaid qui représente visuellement les idées, étapes ou relations clés de ce contenu. ${kindInstr}\n`
      + `Réponds UNIQUEMENT avec un bloc de code markdown \`\`\`mermaid ... \`\`\`, sans aucun texte avant ou après.`
    : `Here is a note's content:\n\n${content.slice(0, 4000)}\n\n`
      + `Generate a Mermaid diagram that visually represents the key ideas, steps, or relationships in this content. ${kindInstr}\n`
      + `Reply ONLY with a \`\`\`mermaid ... \`\`\` markdown code block, no text before or after.`;
  const raw = await oneShotLocalOllama(model, [{ role: 'user', content: prompt }], { timeoutMs: 120_000 });
  const cleaned = stripThink(raw);
  const m = /```mermaid\s*\n([\s\S]*?)```/.exec(cleaned);
  const inner = m ? m[1].trim() : cleaned.trim();
  return inner ? '```mermaid\n' + inner + '\n```' : '';
}


// ── Quiz — generate flashcards across multiple pads (one-shot) ─────────────
//
// Server exposes /api/ai/quiz/collect-content that returns the joined markdown
// bodies of the given pad ids (auth + owner check + text extraction stay
// server-side). The prompt + Ollama call happens here.

export async function quizGenerate(
  model: string, padIds: string[], topic: string | undefined, n: number, lang: Lang,
): Promise<string> {
  const cr = await fetch('/api/ai/quiz/collect-content', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pad_ids: padIds }),
  });
  if (!cr.ok) return '';
  const { content } = await cr.json();
  if (!content) return '';

  const combined = String(content).slice(0, 5000);
  const cap = Math.min(n || 8, 20);
  const topicHint = topic ? ` sur le sujet '${topic}'` : '';

  const prompt = lang === 'fr'
    ? `Voici le contenu de plusieurs notes :\n\n${combined}\n\n`
      + `Génère exactement ${cap} flashcards pédagogiques${topicHint} sous ce format EXACT :\n\n`
      + `Q: [question claire et concise]\nA: [réponse courte et précise]\n\n`
      + `Génère uniquement les paires Q:/A:, sans introduction ni commentaire.`
    : `Here is the content of several notes:\n\n${combined}\n\n`
      + `Generate exactly ${cap} educational flashcards${topicHint} in this EXACT format:\n\n`
      + `Q: [clear question]\nA: [short answer]\n\n`
      + `Output only Q:/A: pairs, no intro.`;
  const raw = await oneShotLocalOllama(model, [{ role: 'user', content: prompt }], { timeoutMs: 120_000 });
  const cleaned = stripThink(raw).trim();
  if (cleaned.includes('Q:') && cleaned.includes('A:')) return cleaned;
  return '';
}


// ── Structure a document (streaming, map-reduce) ───────────────────────────
//
// Long docs get split into ~6000-char chunks; each chunk is analysed
// (map step, in parallel) and the aggregate is synthesised into a coherent
// Markdown note (reduce step). Progress events are emitted so the UI can
// show what phase we're in, then a final `document` event with the body.

export interface StructureEvent {
  kind: 'progress' | 'document' | 'error';
  msg?: string;
  content?: string;
  error?: string;
}

interface MapResult {
  summary: string;
  points: string[];
  entities: string[];
  quotes: string[];
}

function chunkForMap(text: string, targetChars = 6000, maxChunks = 10): string[] {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  const paras = trimmed.split(/\n\s*\n/);
  const chunks: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length > targetChars) { chunks.push(cur.trim()); cur = ''; }
    cur += p + '\n\n';
  }
  if (cur.trim()) chunks.push(cur.trim());
  if (chunks.length > maxChunks) {
    const group = Math.ceil(chunks.length / maxChunks);
    const grouped: string[] = [];
    for (let i = 0; i < chunks.length; i += group) grouped.push(chunks.slice(i, i + group).join('\n\n'));
    return grouped;
  }
  return chunks;
}

async function mapChunk(model: string, chunk: string, lang: Lang): Promise<MapResult> {
  const instr = lang === 'fr' ? 'en français' : 'in English';
  const prompt =
    `Tu analyses UNE portion d'un document plus long. Extrais uniquement ce qui est dans cette portion, ${instr}.\n`
    + `Réponds STRICTEMENT en JSON, rien d'autre :\n`
    + `{"summary": "2-3 phrases", "points": ["..."], "entities": ["..."], "quotes": ["..."]}\n`
    + `N'invente rien. \`quotes\` = citations verbatim courtes (0-2), sinon [].\n\n`
    + `Portion :\n${chunk}`;
  try {
    const raw = await oneShotLocalOllama(model, [{ role: 'user', content: prompt }], { format: 'json', timeoutMs: 180_000 });
    const obj = extractJsonObject(raw);
    return {
      summary: String((obj.summary as string) ?? '').trim(),
      points: (Array.isArray(obj.points) ? obj.points : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 6),
      entities: (Array.isArray(obj.entities) ? obj.entities : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 8),
      quotes: (Array.isArray(obj.quotes) ? obj.quotes : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 2),
    };
  } catch {
    return { summary: '', points: [], entities: [], quotes: [] };
  }
}

async function reduceChunks(
  model: string, results: MapResult[], title: string, lang: Lang, length: 'short' | 'long',
): Promise<string> {
  const digest = JSON.stringify(results).slice(0, 12000);
  const short = length === 'short';
  let prompt: string;
  if (lang === 'fr') {
    const sections = short
      ? '## TL;DR\n(2-3 phrases)\n## Points clés\n(3-5 puces)\n## À retenir\n(puces actionnables)'
      : '## TL;DR\n(2-3 phrases)\n## Points clés\n(puces)\n## Plan détaillé\n(sections ### thématiques avec le détail)\n'
        + '## Intervenants / entités\n(puces)\n## Citations notables\n(> citations, ou « — »)\n## À retenir\n(puces actionnables)';
    prompt =
      `Tu es un éditeur. À partir des analyses de portions ci-dessous (JSON), rédige UNE note Markdown `
      + `cohérente et structurée en français. Fusionne, dédoublonne, ordonne logiquement. N'invente rien.\n`
      + `Produis EXACTEMENT ces sections (garde les titres, omets une section si vraiment vide) :\n${sections}\n\n`
      + `${short ? 'Sois CONCIS.' : 'Sois complet et détaillé.'} `
      + `Commence DIRECTEMENT par « ## TL;DR », sans aucune phrase d'introduction.\n\n`
      + `Titre du document : ${title}\n\nAnalyses :\n${digest}`;
  } else {
    const sections = short
      ? '## TL;DR\n## Key points\n## Takeaways'
      : '## TL;DR\n## Key points\n## Detailed outline\n(thematic ### sections)\n## People / entities\n'
        + '## Notable quotes\n## Takeaways';
    prompt =
      `You are an editor. From the per-portion analyses below (JSON), write ONE coherent, structured `
      + `Markdown note in English. Merge, dedupe, order logically. Do not invent.\n`
      + `Produce EXACTLY these sections (keep the headings, omit one only if truly empty):\n${sections}\n\n`
      + `${short ? 'Be CONCISE.' : 'Be thorough and detailed.'} `
      + `Start DIRECTLY with "## TL;DR", no introductory sentence.\n\n`
      + `Document title: ${title}\n\nAnalyses:\n${digest}`;
  }
  const raw = await oneShotLocalOllama(model, [{ role: 'user', content: prompt }], { timeoutMs: 180_000 });
  const cleaned = stripThink(raw);
  const h = cleaned.indexOf('## ');
  return h > 0 ? cleaned.slice(h).trim() : cleaned;
}

// ── Agent-memory extraction (one-shot, JSON) ───────────────────────────────
//
// Mirrors the retired POST /api/ai/memory/extract server route. Slots are
// duplicated from backend/routers/ai/memory.py::MEMORY_SLOTS — a coordinated
// change here + there when a slot is added/removed. Wanted-audit: keep short.

const MEMORY_SLOTS_HINT: { slug: string; purpose: string }[] = [
  { slug: 'profile',     purpose: "Qui est l'utilisateur : rôle, contexte, ce sur quoi il travaille en général." },
  { slug: 'preferences', purpose: "Comment l'utilisateur aime que l'assistant réponde : longueur, ton, format, langue." },
  { slug: 'projets',     purpose: 'Projets en cours, objectifs, décisions prises. Une section par projet.' },
];
const _VALID_MEMORY_SLUGS = new Set(MEMORY_SLOTS_HINT.map(s => s.slug));

export interface MemoryProposal {
  should_save: true;
  target: string;
  section: string | null;
  content: string;
  reason: string | null;
}

export async function memoryExtract(
  model: string,
  messages: { role: string; content: string }[],
): Promise<MemoryProposal | null> {
  if (!messages.length) return null;
  const tail = messages.slice(-6);
  const convo = tail
    .filter(m => m.content.trim())
    .map(m => `[${m.role}] ${m.content.slice(0, 1500)}`)
    .join('\n\n');
  if (!convo) return null;

  const slotDesc = MEMORY_SLOTS_HINT.map(s => `- "${s.slug}" : ${s.purpose}`).join('\n');
  const prompt =
    "Tu analyses une conversation entre un utilisateur et un assistant. Ta tâche : "
    + "détecter s'il y a UN fait DURABLE sur l'utilisateur, ses préférences ou ses projets "
    + "qui mérite d'être noté dans la mémoire persistante de l'assistant.\n\n"
    + "Cibles possibles :\n" + slotDesc + "\n\n"
    + "N'invente RIEN. Ignore les questions ponctuelles et les demandes d'aide. "
    + "Ne propose que si le fait est nouveau, stable dans le temps, et utile à retenir "
    + "pour de futures conversations.\n\n"
    + "Réponds STRICTEMENT en JSON, rien d'autre :\n"
    + '{"should_save": bool, "target": "profile"|"preferences"|"projets"|null, '
    + '"section": string|null, "content": string, "reason": string}\n\n'
    + "`content` = 1-2 phrases à ajouter, formulées à la 3e personne (« L'utilisateur … »).\n"
    + "`section` = nom d'une section markdown (##) où stocker, ou null pour un append simple.\n"
    + "`reason` = pourquoi ça vaut la peine d'être mémorisé (1 phrase).\n"
    + "Si rien de durable, renvoie {\"should_save\": false}.\n\n"
    + "Conversation :\n" + convo;

  let obj: Record<string, unknown>;
  try {
    const raw = await oneShotLocalOllama(
      model, [{ role: 'user', content: prompt }],
      { format: 'json', timeoutMs: 60_000 },
    );
    obj = extractJsonObject(raw);
  } catch {
    return null;
  }

  const shouldSave = Boolean(obj.should_save);
  const target = typeof obj.target === 'string' ? obj.target : '';
  const content = typeof obj.content === 'string' ? obj.content.trim() : '';
  if (!shouldSave || !_VALID_MEMORY_SLUGS.has(target) || !content) return null;

  const section = typeof obj.section === 'string' && obj.section ? obj.section : null;
  const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : null;
  return { should_save: true, target, section, content, reason };
}


export async function structureDocument(
  model: string, content: string, title: string, lang: Lang, length: 'short' | 'long',
  onEvent: (e: StructureEvent) => void,
): Promise<void> {
  const chunks = chunkForMap(content);
  if (!chunks.length) { onEvent({ kind: 'document', content: '' }); return; }
  try {
    onEvent({ kind: 'progress', msg: `Découpage en ${chunks.length} portion(s)…` });
    const results: MapResult[] = new Array(chunks.length);
    let done = 0;
    const tasks = chunks.map((c, i) => mapChunk(model, c, lang).then(res => {
      results[i] = res;
      done += 1;
      onEvent({ kind: 'progress', msg: `Analyse ${done}/${chunks.length}…` });
    }));
    await Promise.all(tasks);
    onEvent({ kind: 'progress', msg: 'Synthèse (IA mère)…' });
    const body = await reduceChunks(model, results.filter(Boolean), title, lang, length);
    onEvent({ kind: 'document', content: body });
  } catch (e) {
    onEvent({ kind: 'error', error: e instanceof Error ? e.message : String(e) });
  }
}
