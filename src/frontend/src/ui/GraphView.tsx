import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, Network, Search, SlidersHorizontal } from 'lucide-react';
import { searchRag } from '../lib/rag';
import './GraphView.scss';

interface GraphNode {
  id: string;
  label: string;
  type: 'canvas' | 'document' | 'kanban' | 'gantt' | 'latex' | 'database';
  is_scratch: boolean;
  created_at: string | null;
  tags: string[];
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface GraphEdge { from: string; to: string; }

interface Props {
  onClose: () => void;
  onSelectPad: (id: string) => void;
}

// ── Physics constants ─────────────────────────────────────────────────────────
// K_REP and REST_LEN are now mutable (refs) so the "Espacement" / "Longueur
// des liens" sliders (chantier #21) can nudge the running simulation live.
const K_REP_DEFAULT    = 3200;   // repulsion strength
const K_SPRING = 0.04;   // spring stiffness
const REST_LEN_DEFAULT = 160;    // spring rest length (px)
const K_CENTER = 0.006;  // center gravity
const DAMPING  = 0.82;   // velocity damping per tick
const DT       = 1;      // time step
const NODE_R   = 14;     // node radius

// Canvas 2D can't resolve CSS var() strings — read the live theme values instead
function themeVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// Every pad type gets a distinct color — was previously only canvas/document,
// every other type (kanban/gantt/latex/database, all of which the backend
// already reports via `pad_type`) silently fell back to plain text0, losing
// all visual distinction on the graph.
function getNodeColors(): Record<GraphNode['type'], string> {
  return {
    canvas:   themeVar('--ap-green', '#a6e3a1'),
    document: themeVar('--ap-accent2', '#89b4fa'),
    kanban:   themeVar('--ap-mauve', '#cba6f7'),
    gantt:    themeVar('--ap-peach', '#fab387'),
    latex:    themeVar('--ap-red', '#f38ba8'),
    database: themeVar('--ap-teal', '#94e2d5'),
  };
}

const TYPE_LABELS: Record<GraphNode['type'], string> = {
  canvas: 'Canvas', document: 'Document', kanban: 'Kanban',
  gantt: 'Gantt', latex: 'LaTeX', database: 'Database',
};

// ── Color groups ─────────────────────────────────────────────────────────────
// Recall's graph settings panel lets you paint nodes matching a saved query in
// a chosen color, layered over the type color — useful to see a thematic
// subset without filtering the rest of the graph away. Three query modes,
// picked by prefix (mirrors Recall's tag:/source:/name: convention):
//   "tag:xxx"   — substring match against the pad's tags, instant (tags ship
//                 with every node in the /graph payload, no round-trip).
//   "~xxx"      — semantic proximity: the query is embedded client-side via
//                 the same local-Ollama path the RAG chat uses (searchRag),
//                 the server KNN-ranks it against the owner's stored chunk
//                 embeddings, and pads scoring above a threshold match. This
//                 is the "content-similarity via vectorization" the user
//                 asked about — reuses chantier #7's existing pipeline
//                 instead of building a second one.
//   plain text  — title substring (instant) OR the pad turns up in
//                 /api/pad/search (title+document body+canvas text), so
//                 matching isn't limited to the title anymore.
// The async modes (~ and plain-text content) are debounced and resolved into
// a per-group Set<padId> cache; draw() reads that cache on every frame but
// never triggers the fetch itself (kept in a separate effect keyed on the
// `groups` state, not the ref, since only state changes should fire network
// calls).
interface ColorGroup { id: string; query: string; color: string; }
const GROUP_COLOR_PALETTE = ['#f38ba8', '#fab387', '#f9e2af', '#a6e3a1', '#94e2d5', '#89b4fa', '#cba6f7', '#f5c2e7'];
// Verified empirically against nomic-embed-text on a small corpus: unrelated
// pads still scored 0.45-0.49 cosine similarity against an off-topic query,
// while the true semantic match scored 0.72 — a threshold of 0.35 (the RAG
// chat's own default) let the noise floor through. 0.55 cut both false
// positives while keeping the real match.
const SEMANTIC_MIN_SCORE = 0.55;

const GraphView: React.FC<Props> = ({ onClose, onSelectPad }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef  = useRef<GraphNode[]>([]);
  const edgesRef  = useRef<GraphEdge[]>([]);
  const rafRef    = useRef<number>(0);
  const simRunRef = useRef(true);
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const dragRef   = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const hoveredIdRef = useRef<string | null>(null);
  const clickedRef   = useRef(false);

  // ── Controls (chantier #21) ────────────────────────────────────────────────
  // State drives the UI (inputs, labels); refs mirror the same values for
  // `draw()`/`tick()` to read live without needing to be recreated on every
  // change — matches the existing pattern here (theme vars are also read
  // live inside draw() rather than threaded through as deps).
  const [search, setSearch] = useState('');
  const searchRef = useRef('');
  const [showUnconnected, setShowUnconnected] = useState(true);
  const showUnconnectedRef = useRef(true);
  const [showControls, setShowControls] = useState(false);
  const [spacing, setSpacing] = useState(K_REP_DEFAULT);
  const spacingRef = useRef(K_REP_DEFAULT);
  const [linkLength, setLinkLength] = useState(REST_LEN_DEFAULT);
  const linkLengthRef = useRef(REST_LEN_DEFAULT);
  const [dataRange, setDataRange] = useState<[number, number]>([0, 1]);
  const [timelineRange, setTimelineRange] = useState<[number, number]>([0, 1]);
  const timelineRangeRef = useRef<[number, number]>([0, 1]);
  const connectedIdsRef = useRef<Set<string>>(new Set());
  const [groups, setGroups] = useState<ColorGroup[]>([]);
  const groupsRef = useRef<ColorGroup[]>([]);
  // Resolved pad ids for each group's async (semantic / content) query —
  // draw() reads this every frame; the debounce effect below is the only
  // writer. groupReqIdRef guards against a slow request overwriting a newer
  // one once the user keeps typing.
  const groupMatchSetsRef = useRef<Record<string, Set<string>>>({});
  const groupReqIdRef = useRef<Record<string, number>>({});
  const [groupErrors, setGroupErrors] = useState<Record<string, string>>({});

  // Redraw-on-demand helper for state-driven filter changes (the physics
  // loop already redraws every frame while running, but once it settles
  // after 5s a filter tweak needs to trigger a repaint by itself).
  const drawRef = useRef<(() => void) | null>(null);
  const requestDraw = useCallback(() => { drawRef.current?.(); }, []);

  useEffect(() => { searchRef.current = search; requestDraw(); }, [search, requestDraw]);
  useEffect(() => { showUnconnectedRef.current = showUnconnected; requestDraw(); }, [showUnconnected, requestDraw]);
  useEffect(() => { spacingRef.current = spacing; }, [spacing]);
  useEffect(() => { linkLengthRef.current = linkLength; }, [linkLength]);
  useEffect(() => { timelineRangeRef.current = timelineRange; requestDraw(); }, [timelineRange, requestDraw]);
  useEffect(() => { groupsRef.current = groups; requestDraw(); }, [groups, requestDraw]);

  // Debounced resolution of the async group query modes ("~semantic" and
  // plain-text content search). "tag:" is synchronous (tags are already in
  // the node payload) and skipped here entirely.
  useEffect(() => {
    const timers = groups.map(g => {
      const raw = g.query.trim();
      if (!raw || raw.toLowerCase().startsWith('tag:')) return null;
      if (raw.length < 2 && !raw.startsWith('~')) return null;
      return window.setTimeout(async () => {
        const reqId = (groupReqIdRef.current[g.id] || 0) + 1;
        groupReqIdRef.current[g.id] = reqId;
        try {
          let ids: string[];
          if (raw.startsWith('~')) {
            const q = raw.slice(1).trim();
            if (q.length < 2) return;
            const matches = await searchRag(q, 40);
            ids = matches.filter(m => m.score >= SEMANTIC_MIN_SCORE).map(m => m.pad_id);
          } else {
            const r = await fetch(`/api/pad/search?q=${encodeURIComponent(raw)}`, { credentials: 'include' });
            if (!r.ok) throw new Error(`search ${r.status}`);
            const j: Array<{ pad_id: string }> = await r.json();
            ids = j.map(m => m.pad_id);
          }
          if (groupReqIdRef.current[g.id] !== reqId) return; // superseded by a newer query
          groupMatchSetsRef.current = { ...groupMatchSetsRef.current, [g.id]: new Set(ids) };
          setGroupErrors(prev => { if (!(g.id in prev)) return prev; const { [g.id]: _drop, ...rest } = prev; return rest; });
          requestDraw();
        } catch {
          if (groupReqIdRef.current[g.id] !== reqId) return;
          setGroupErrors(prev => ({
            ...prev,
            [g.id]: raw.startsWith('~') ? 'Ollama local indisponible' : 'Recherche indisponible',
          }));
        }
      }, 400);
    });
    return () => timers.forEach(t => { if (t) clearTimeout(t); });
  }, [groups, requestDraw]);

  const addGroup = useCallback(() => {
    setGroups(gs => [...gs, {
      id: Math.random().toString(36).slice(2),
      query: '',
      color: GROUP_COLOR_PALETTE[gs.length % GROUP_COLOR_PALETTE.length],
    }]);
  }, []);
  const updateGroup = useCallback((id: string, patch: Partial<ColorGroup>) => {
    setGroups(gs => gs.map(g => (g.id === id ? { ...g, ...patch } : g)));
  }, []);
  const removeGroup = useCallback((id: string) => {
    setGroups(gs => gs.filter(g => g.id !== id));
  }, []);

  const toWorld = useCallback((cx: number, cy: number) => {
    const t = transformRef.current;
    return { x: (cx - t.x) / t.scale, y: (cy - t.y) / t.scale };
  }, []);

  const hitNode = useCallback((wx: number, wy: number) =>
    nodesRef.current.find(n => Math.hypot(n.x - wx, n.y - wy) < NODE_R + 4),
  []);

  // ── Draw ──────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = canvas;
    const { x: tx, y: ty, scale } = transformRef.current;
    const nodes = nodesRef.current;
    const edges = edgesRef.current;
    const hoveredId = hoveredIdRef.current;

    const nodeColors = getNodeColors();
    const textRgb = themeVar('--ap-text0-rgb', '205,214,244');
    const text0 = themeVar('--ap-text0', '#cdd6f4');
    const text2 = themeVar('--ap-text2', '#a6adc8');
    const yellow = themeVar('--ap-yellow', '#f9e2af');

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = themeVar('--ap-sidebar-bg', '#0d0d1a');
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    // index
    const byId: Record<string, GraphNode> = {};
    nodes.forEach(n => (byId[n.id] = n));

    // Active filters, read live from refs (chantier #21).
    const search = searchRef.current.trim().toLowerCase();
    const showUnconnected = showUnconnectedRef.current;
    const [tMin, tMax] = timelineRangeRef.current;
    const connected = connectedIdsRef.current;
    const groups = groupsRef.current;

    const isVisible = (n: GraphNode): boolean => {
      if (!showUnconnected && !connected.has(n.id)) return false;
      if (n.created_at) {
        const ts = new Date(n.created_at).getTime();
        if (ts < tMin || ts > tMax) return false;
      }
      return true;
    };
    const isMatch = (n: GraphNode): boolean =>
      !search || n.label.toLowerCase().includes(search);
    // tag:xxx → tags (instant, shipped with the node) · ~xxx → semantic
    // proximity · plain text → title (instant) or content (async), both
    // resolved through groupMatchSetsRef by the debounce effect above.
    const nodeMatchesGroup = (n: GraphNode, g: ColorGroup): boolean => {
      const raw = g.query.trim();
      if (!raw) return false;
      const lower = raw.toLowerCase();
      if (lower.startsWith('tag:')) {
        const tagQuery = lower.slice(4).trim();
        return !!tagQuery && (n.tags || []).some(t => t.toLowerCase().includes(tagQuery));
      }
      if (raw.startsWith('~')) {
        return groupMatchSetsRef.current[g.id]?.has(n.id) ?? false;
      }
      if (n.label.toLowerCase().includes(lower)) return true;
      return groupMatchSetsRef.current[g.id]?.has(n.id) ?? false;
    };
    // Later groups win when a node matches more than one query — mirrors Recall.
    const groupColor = (n: GraphNode): string | null => {
      let color: string | null = null;
      for (const g of groups) {
        if (nodeMatchesGroup(n, g)) color = g.color;
      }
      return color;
    };

    // edges — only drawn when both endpoints are visible under the current filters.
    edges.forEach(e => {
      const a = byId[e.from];
      const b = byId[e.to];
      if (!a || !b || !isVisible(a) || !isVisible(b)) return;
      const highlighted = hoveredId && (a.id === hoveredId || b.id === hoveredId);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = highlighted ? `rgba(${textRgb},0.5)` : `rgba(${textRgb},0.12)`;
      ctx.lineWidth = highlighted ? 1.5 / scale : 1 / scale;
      ctx.stroke();
    });

    // nodes
    nodes.forEach(n => {
      if (!isVisible(n)) return;
      const dimmed = !isMatch(n);
      const color = groupColor(n) || nodeColors[n.type] || text0;
      const isHovered = n.id === hoveredId;
      const r = isHovered ? NODE_R + 3 : NODE_R;

      // glow
      if (isHovered) {
        const grd = ctx.createRadialGradient(n.x, n.y, r * 0.3, n.x, n.y, r * 2.5);
        grd.addColorStop(0, color + '55');
        grd.addColorStop(1, color + '00');
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 2.5, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();
      }

      ctx.globalAlpha = dimmed ? 0.18 : 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isHovered ? color : color + 'cc';
      ctx.fill();

      if (n.is_scratch) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = yellow;
        ctx.lineWidth = 2 / scale;
        ctx.setLineDash([4 / scale, 3 / scale]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // label
      const fontSize = Math.max(9, 11 / scale);
      ctx.font = `${fontSize}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = isHovered ? text0 : text2;
      ctx.fillText(
        n.label.length > 20 ? n.label.slice(0, 18) + '…' : n.label,
        n.x,
        n.y + r + fontSize + 2
      );
    });

    ctx.restore();
  }, []);

  // ── Physics tick ──────────────────────────────────────────────────────────
  const tick = useCallback(() => {
    const nodes = nodesRef.current;
    const edges = edgesRef.current;

    const byId: Record<string, GraphNode> = {};
    nodes.forEach(n => (byId[n.id] = n));

    const fx: Record<string, number> = {};
    const fy: Record<string, number> = {};
    nodes.forEach(n => { fx[n.id] = 0; fy[n.id] = 0; });

    // Live from the "Espacement" / "Longueur des liens" sliders (#21) — refs
    // so dragging a slider doesn't need to recreate this callback.
    const kRep = spacingRef.current;
    const restLen = linkLengthRef.current;

    // repulsion O(n²)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x || 0.01;
        const dy = b.y - a.y || 0.01;
        const d2 = dx * dx + dy * dy + 0.01;
        const f = kRep / d2;
        const ux = dx / Math.sqrt(d2), uy = dy / Math.sqrt(d2);
        fx[a.id] -= ux * f; fy[a.id] -= uy * f;
        fx[b.id] += ux * f; fy[b.id] += uy * f;
      }
    }

    // spring
    edges.forEach(e => {
      const a = byId[e.from], b = byId[e.to];
      if (!a || !b) return;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = K_SPRING * (d - restLen);
      const ux = dx / d, uy = dy / d;
      fx[a.id] += ux * f; fy[a.id] += uy * f;
      fx[b.id] -= ux * f; fy[b.id] -= uy * f;
    });

    // center gravity
    nodes.forEach(n => {
      fx[n.id] -= K_CENTER * n.x;
      fy[n.id] -= K_CENTER * n.y;
    });

    // integrate
    nodes.forEach(n => {
      n.vx = (n.vx + fx[n.id] * DT) * DAMPING;
      n.vy = (n.vy + fy[n.id] * DT) * DAMPING;
      n.x += n.vx * DT;
      n.y += n.vy * DT;
    });
  }, []);

  // ── Simulation loop ───────────────────────────────────────────────────────
  const loop = useCallback(() => {
    if (!simRunRef.current) { draw(); return; }
    tick();
    draw();
    rafRef.current = requestAnimationFrame(loop);
  }, [tick, draw]);

  useEffect(() => { drawRef.current = draw; }, [draw]);

  // ── Load data ─────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/pad/graph')
      .then(r => r.json())
      .then(({ nodes, edges }: { nodes: any[]; edges: GraphEdge[] }) => {
        const W = canvasRef.current?.width  || 800;
        const H = canvasRef.current?.height || 600;
        nodesRef.current = nodes.map(n => ({
          ...n,
          x: (Math.random() - 0.5) * Math.min(W, H) * 0.6,
          y: (Math.random() - 0.5) * Math.min(W, H) * 0.6,
          vx: 0, vy: 0,
        }));
        edgesRef.current = edges;

        // Connected-ids set for "Show Unconnected" (#21).
        const connected = new Set<string>();
        edges.forEach(e => { connected.add(e.from); connected.add(e.to); });
        connectedIdsRef.current = connected;

        // Timeline scrubber range — span of created_at across all nodes,
        // padded by a day on each side so endpoints aren't clipped exactly
        // at the slider's extremes. Falls back to a 1-day window around now
        // if no node has a timestamp (shouldn't happen — created_at is
        // always set server-side — but keeps the sliders well-formed).
        const timestamps = nodes.map(n => n.created_at ? new Date(n.created_at).getTime() : NaN).filter(t => !isNaN(t));
        const dayMs = 86_400_000;
        const range: [number, number] = timestamps.length
          ? [Math.min(...timestamps) - dayMs, Math.max(...timestamps) + dayMs]
          : [Date.now() - dayMs, Date.now() + dayMs];
        setDataRange(range);
        setTimelineRange(range);
        timelineRangeRef.current = range;

        setLoading(false);
        simRunRef.current = true;
        // stop simulation after 5s (energy dissipated)
        setTimeout(() => { simRunRef.current = false; }, 5000);
        loop();
      })
      .catch(() => setLoading(false));
  }, [loop]);

  // ── Canvas resize ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      // center transform
      transformRef.current.x = canvas.width  / 2;
      transformRef.current.y = canvas.height / 2;
      draw();
    });
    ro.observe(canvas);
    return () => { ro.disconnect(); cancelAnimationFrame(rafRef.current); };
  }, [draw]);

  // ── Mouse events ──────────────────────────────────────────────────────────
  const onMouseDown = (e: React.MouseEvent) => {
    clickedRef.current = true;
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      panX: transformRef.current.x, panY: transformRef.current.y,
    };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const { x: wx, y: wy } = toWorld(cx, cy);

    // pan
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) clickedRef.current = false;
      transformRef.current.x = dragRef.current.panX + dx;
      transformRef.current.y = dragRef.current.panY + dy;
      draw();
      return;
    }

    // hover
    const hov = hitNode(wx, wy);
    const prev = hoveredIdRef.current;
    hoveredIdRef.current = hov?.id || null;
    if (hoveredIdRef.current !== prev) draw();

    if (hov) {
      const canvasRect = canvas.getBoundingClientRect();
      setTooltip({
        x: e.clientX + 12,
        y: e.clientY - 8,
        label: hov.label,
      });
      (canvas as HTMLElement).style.cursor = 'pointer';
    } else {
      setTooltip(null);
      (canvas as HTMLElement).style.cursor = 'grab';
    }
  };

  const onMouseUp = (e: React.MouseEvent) => {
    const wasDrag = !clickedRef.current;
    dragRef.current = null;
    if (wasDrag) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const { x: wx, y: wy } = toWorld(e.clientX - rect.left, e.clientY - rect.top);
    const node = hitNode(wx, wy);
    if (node) { onSelectPad(node.id); onClose(); }
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const t = transformRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.max(0.2, Math.min(4, t.scale * factor));
    t.x = mx - (mx - t.x) * (newScale / t.scale);
    t.y = my - (my - t.y) * (newScale / t.scale);
    t.scale = newScale;
    draw();
  };

  const onMouseLeave = () => {
    dragRef.current = null;
    hoveredIdRef.current = null;
    setTooltip(null);
    draw();
  };

  // ── Legend ────────────────────────────────────────────────────────────────
  // Only types actually present in the loaded graph get a legend entry —
  // a user with only canvas/document pads shouldn't see 4 empty swatches.
  const presentTypes = Array.from(new Set(nodesRef.current.map(n => n.type)));
  const nodeColors = getNodeColors();
  const Legend = () => (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
      {(presentTypes.length ? presentTypes : ['canvas', 'document'] as const).map(type => (
        <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--ap-text2)' }}>
          <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: nodeColors[type] }} />
          {TYPE_LABELS[type]}
        </div>
      ))}
    </div>
  );

  const rangeFmt = (ts: number) => new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });

  return (
    <div className="graph-overlay">
      <div className="graph-header">
        <div className="graph-header__title">
          <Network size={16} />
          Knowledge Graph
        </div>
        <div className="graph-header__actions">
          <Legend />
          <div className="graph-search">
            <Search size={12} />
            <input
              placeholder="Filtrer par titre…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <button
            className={`graph-header__filters-btn${showControls ? ' active' : ''}`}
            onClick={() => setShowControls(v => !v)}
            title="Filtres et réglages"
          >
            <SlidersHorizontal size={14} />
          </button>
          <button className="graph-header__close" onClick={onClose}><X size={18} /></button>
        </div>
      </div>

      {showControls && (
        <div className="graph-controls">
          <label className="graph-controls__row">
            <input type="checkbox" checked={showUnconnected} onChange={e => setShowUnconnected(e.target.checked)} />
            Afficher les nœuds non connectés
          </label>

          <div className="graph-controls__row graph-controls__row--slider">
            <span>Espacement</span>
            <input
              type="range" min={800} max={8000} step={100}
              value={spacing}
              onChange={e => setSpacing(Number(e.target.value))}
            />
          </div>

          <div className="graph-controls__row graph-controls__row--slider">
            <span>Longueur des liens</span>
            <input
              type="range" min={60} max={400} step={10}
              value={linkLength}
              onChange={e => setLinkLength(Number(e.target.value))}
            />
          </div>

          <div className="graph-controls__row graph-controls__row--timeline">
            <span>Période — {rangeFmt(timelineRange[0])} → {rangeFmt(timelineRange[1])}</span>
            <div className="graph-controls__timeline">
              <input
                type="range"
                min={dataRange[0]} max={dataRange[1]} step={3_600_000}
                value={timelineRange[0]}
                onChange={e => setTimelineRange([Math.min(Number(e.target.value), timelineRange[1]), timelineRange[1]])}
              />
              <input
                type="range"
                min={dataRange[0]} max={dataRange[1]} step={3_600_000}
                value={timelineRange[1]}
                onChange={e => setTimelineRange([timelineRange[0], Math.max(Number(e.target.value), timelineRange[0])])}
              />
            </div>
            {(timelineRange[0] !== dataRange[0] || timelineRange[1] !== dataRange[1]) && (
              <button className="graph-controls__reset" onClick={() => setTimelineRange(dataRange)}>
                Réinitialiser la période
              </button>
            )}
          </div>

          <div className="graph-controls__row graph-controls__groups">
            <span>
              Groupes de couleur
              <span className="graph-controls__groups-hint">
                {' '}— texte (titre+contenu) · tag:xxx · ~similaire à…
              </span>
            </span>
            {groups.map(g => (
              <div key={g.id} className="graph-controls__group">
                <div className="graph-controls__group-row">
                  <input
                    type="color"
                    value={g.color}
                    onChange={e => updateGroup(g.id, { color: e.target.value })}
                    title="Couleur du groupe"
                  />
                  <input
                    type="text"
                    placeholder="ex: tag:esat, ~conditions de travail…"
                    value={g.query}
                    onChange={e => updateGroup(g.id, { query: e.target.value })}
                  />
                  <button
                    className="graph-controls__group-remove"
                    onClick={() => removeGroup(g.id)}
                    title="Supprimer ce groupe"
                  >
                    <X size={12} />
                  </button>
                </div>
                {groupErrors[g.id] && (
                  <span className="graph-controls__group-error">{groupErrors[g.id]}</span>
                )}
              </div>
            ))}
            <button className="graph-controls__add-group" onClick={addGroup}>
              + Nouveau groupe
            </button>
          </div>
        </div>
      )}

      {loading && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ap-overlay0)', fontSize: 14 }}>
          Chargement du graph…
        </div>
      )}

      <canvas
        ref={canvasRef}
        className="graph-canvas"
        style={{ display: loading ? 'none' : 'block' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onWheel={onWheel}
      />

      {tooltip && (
        <div className="graph-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          {tooltip.label}
        </div>
      )}
    </div>
  );
};

export default GraphView;
