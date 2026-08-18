import { useCallback, useEffect, useState } from 'react';

export interface MemorySlot {
  slug: string;
  display_name: string;
  content: string;
  pad_id: string | null;
  updated_at: string | null;
}

export interface MemoryProposal {
  target: string;
  section: string | null;
  content: string;
  reason: string | null;
}

export interface AgentMemory {
  slots: MemorySlot[];
  loading: boolean;
  refresh: () => Promise<void>;
  write: (
    slug: string,
    op: 'append' | 'replace_section' | 'replace',
    content: string,
    section?: string | null,
    reason?: string | null,
  ) => Promise<boolean>;
  extract: (
    messages: { role: string; content: string }[],
  ) => Promise<MemoryProposal | null>;
}

// Small hook backing the "Mémoire" pane and the after-turn "should I save this?"
// proposal. All operations are user-confirmed: extract only proposes; write only
// runs when the user hits Accept.
export function useAgentMemory(): AgentMemory {
  const [slots, setSlots] = useState<MemorySlot[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/ai/memory');
      if (!r.ok) return;
      const d = await r.json();
      setSlots(d.slots || []);
    } catch { /* offline — leave stale */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const write = useCallback(async (
    slug: string,
    op: 'append' | 'replace_section' | 'replace',
    content: string,
    section?: string | null,
    reason?: string | null,
  ): Promise<boolean> => {
    try {
      const r = await fetch('/api/ai/memory/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, op, content, section: section ?? null, reason: reason ?? null }),
      });
      if (!r.ok) return false;
      await refresh();
      return true;
    } catch { return false; }
  }, [refresh]);

  const extract = useCallback(async (
    messages: { role: string; content: string }[],
  ): Promise<MemoryProposal | null> => {
    try {
      const { memoryExtract } = await import('../lib/aiPrompts');
      const model = localStorage.getItem('pad-ws-ai-model') || 'llama3.2';
      const p = await memoryExtract(model, messages);
      if (!p) return null;
      return { target: p.target, section: p.section, content: p.content, reason: p.reason };
    } catch { return null; }
  }, []);

  return { slots, loading, refresh, write, extract };
}
