/**
 * Named, reusable chat personas (chantier #17, 2026-08-20 Recall audit).
 *
 * Alcove already had a single global `customPrompt` (AIPanel's
 * CUSTOM_PROMPT_KEY) — one set of "extra instructions" appended to every
 * conversation. Recall's "+ Add persona" lets a user save several named
 * system-prompt profiles and pick one per conversation. This module
 * generalizes the single custom prompt into a small named list, stored in
 * localStorage (same tier as the old single-prompt key — no backend change,
 * personas are a per-device preference like the model picker already is).
 *
 * Migration: on first read, if the old single CUSTOM_PROMPT_KEY has content
 * and the new list is empty, it's wrapped into one persona so existing
 * users don't lose their instructions silently.
 */

export interface Persona {
  id: string;
  name: string;
  instructions: string;
}

const PERSONAS_KEY = 'alcove-ai-personas';
const ACTIVE_PERSONA_KEY = 'alcove-ai-active-persona';
const LEGACY_CUSTOM_PROMPT_KEY = 'alcove-ai-custom-prompt';

function uid(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function listPersonas(): Persona[] {
  try {
    const raw = localStorage.getItem(PERSONAS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch { /* corrupted storage — fall through to migration/empty */ }

  // One-time migration from the old single custom_prompt.
  const legacy = localStorage.getItem(LEGACY_CUSTOM_PROMPT_KEY);
  if (legacy && legacy.trim()) {
    const migrated: Persona[] = [{ id: uid(), name: 'Assistant', instructions: legacy.trim() }];
    localStorage.setItem(PERSONAS_KEY, JSON.stringify(migrated));
    return migrated;
  }
  return [];
}

function savePersonas(list: Persona[]): void {
  localStorage.setItem(PERSONAS_KEY, JSON.stringify(list));
}

export function createPersona(name: string, instructions: string): Persona {
  const list = listPersonas();
  const persona: Persona = { id: uid(), name: name.trim() || 'Persona', instructions: instructions.trim() };
  savePersonas([...list, persona]);
  return persona;
}

export function updatePersona(id: string, patch: Partial<Pick<Persona, 'name' | 'instructions'>>): void {
  const list = listPersonas();
  savePersonas(list.map(p => p.id === id ? { ...p, ...patch } : p));
}

export function deletePersona(id: string): void {
  savePersonas(listPersonas().filter(p => p.id !== id));
  if (getActivePersonaId() === id) setActivePersonaId(null);
}

export function getActivePersonaId(): string | null {
  return localStorage.getItem(ACTIVE_PERSONA_KEY);
}

export function setActivePersonaId(id: string | null): void {
  if (id) localStorage.setItem(ACTIVE_PERSONA_KEY, id);
  else localStorage.removeItem(ACTIVE_PERSONA_KEY);
}

/** The instructions text to append to the system prompt for the currently
 * active persona, or '' if none is selected / it was deleted out from
 * under an active selection. */
export function getActivePersonaInstructions(): string {
  const id = getActivePersonaId();
  if (!id) return '';
  const p = listPersonas().find(p => p.id === id);
  return p?.instructions ?? '';
}
