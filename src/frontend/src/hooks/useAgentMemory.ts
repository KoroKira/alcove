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
      const r = await fetch('/api/ai/memory/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      });
      if (!r.ok) return null;
      const d = await r.json();
      if (!d.should_save) return null;
      return {
        target: d.target,
        section: d.section ?? null,
        content: d.content,
        reason: d.reason ?? null,
      };
    } catch { return null; }
  }, []);

  return { slots, loading, refresh, write, extract };
}
