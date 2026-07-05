import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, Network } from 'lucide-react';
import './GraphView.scss';

interface GraphNode {
  id: string;
  label: string;
  type: 'canvas' | 'document';
  is_scratch: boolean;
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
const K_REP    = 3200;   // repulsion strength
const K_SPRING = 0.04;   // spring stiffness
const REST_LEN = 160;    // spring rest length (px)
const K_CENTER = 0.006;  // center gravity
const DAMPING  = 0.82;   // velocity damping per tick
const DT       = 1;      // time step
const NODE_R   = 14;     // node radius

// Canvas 2D can't resolve CSS var() strings — read the live theme values instead
function themeVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function getNodeColors(): Record<string, string> {
  return {
    canvas:   themeVar('--ap-green', '#a6e3a1'),
    document: themeVar('--ap-accent2', '#89b4fa'),
  };
}

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

    // edges
    edges.forEach(e => {
      const a = byId[e.from];
      const b = byId[e.to];
      if (!a || !b) return;
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
      const color = nodeColors[n.type] || text0;
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

    // repulsion O(n²)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x || 0.01;
        const dy = b.y - a.y || 0.01;
        const d2 = dx * dx + dy * dy + 0.01;
        const f = K_REP / d2;
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
      const f = K_SPRING * (d - REST_LEN);
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
  const Legend = () => (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
      {[['canvas', 'var(--ap-green)', 'Canvas'], ['document', 'var(--ap-accent2)', 'Document']].map(([, color, label]) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--ap-text2)' }}>
          <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: color }} />
          {label}
        </div>
      ))}
    </div>
  );

  return (
    <div className="graph-overlay">
      <div className="graph-header">
        <div className="graph-header__title">
          <Network size={16} />
          Knowledge Graph
        </div>
        <div className="graph-header__actions">
          <Legend />
          <span className="graph-header__hint">Scroll pour zoomer · Glisser pour naviguer · Cliquer un nœud</span>
          <button className="graph-header__close" onClick={onClose}><X size={18} /></button>
        </div>
      </div>

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
