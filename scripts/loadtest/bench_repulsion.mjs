// Benchmark: naive O(n^2) all-pairs repulsion vs the spatial-hash version
// now in GraphView.tsx's tick(). Standalone port of both algorithms (no
// React/DOM deps) so we can measure real ms/tick at graph sizes too large to
// comfortably click through in a browser (the real Recall export this repo's
// user has is ~12k nodes).

function makeNodes(n, spread) {
  const nodes = [];
  for (let i = 0; i < n; i++) {
    nodes.push({
      id: String(i),
      x: (Math.random() - 0.5) * spread,
      y: (Math.random() - 0.5) * spread,
      vx: 0, vy: 0,
    });
  }
  return nodes;
}

function tickNaive(nodes, kRep) {
  const fx = new Float64Array(nodes.length);
  const fy = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const dx = b.x - a.x || 0.01;
      const dy = b.y - a.y || 0.01;
      const d2 = dx * dx + dy * dy + 0.01;
      const f = kRep / d2;
      const d = Math.sqrt(d2);
      const ux = dx / d, uy = dy / d;
      fx[i] -= ux * f; fy[i] -= uy * f;
      fx[j] += ux * f; fy[j] += uy * f;
    }
  }
  return { fx, fy };
}

function tickGrid(nodes, kRep) {
  const fx = new Float64Array(nodes.length);
  const fy = new Float64Array(nodes.length);
  const REPULSION_CUTOFF = Math.max(120, Math.sqrt(kRep * 20));
  const cutoff2 = REPULSION_CUTOFF * REPULSION_CUTOFF;
  const cellOf = (v) => Math.floor(v / REPULSION_CUTOFF);
  const grid = new Map();
  nodes.forEach((n, idx) => {
    const key = `${cellOf(n.x)},${cellOf(n.y)}`;
    let bucket = grid.get(key);
    if (!bucket) { bucket = []; grid.set(key, bucket); }
    bucket.push(idx);
  });
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const cx = cellOf(a.x), cy = cellOf(a.y);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = grid.get(`${gx},${gy}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const b = nodes[j];
          const dx = b.x - a.x || 0.01;
          const dy = b.y - a.y || 0.01;
          const d2 = dx * dx + dy * dy + 0.01;
          if (d2 > cutoff2) continue;
          const f = kRep / d2;
          const d = Math.sqrt(d2);
          const ux = dx / d, uy = dy / d;
          fx[i] -= ux * f; fy[i] -= uy * f;
          fx[j] += ux * f; fy[j] += uy * f;
        }
      }
    }
  }
  return { fx, fy };
}

function bench(fn, nodes, kRep, reps) {
  // warm up
  fn(nodes, kRep);
  const t0 = performance.now();
  for (let r = 0; r < reps; r++) fn(nodes, kRep);
  return (performance.now() - t0) / reps;
}

const K_REP = 3200;
const FRAME_BUDGET_MS = 16.7; // 60fps

console.log("N nodes | spread(px) | naive O(n²) ms/tick | grid ms/tick | speedup | naive fits 60fps? | grid fits 60fps?");
console.log("--------|------------|----------------------|--------------|---------|-------------------|------------------");

// Spread scales with N so density stays roughly comparable to a real
// force-directed layout settling (not everything crammed into one cell).
const scenarios = [
  { n: 100, spread: 800 },
  { n: 500, spread: 1800 },
  { n: 1500, spread: 3200 },
  { n: 3000, spread: 4600 },
  { n: 6000, spread: 6600 },
  { n: 12000, spread: 9400 },
];

for (const { n, spread } of scenarios) {
  const nodes = makeNodes(n, spread);
  const reps = n <= 1500 ? 20 : (n <= 6000 ? 5 : 2);
  const naiveMs = bench(tickNaive, nodes, K_REP, reps);
  const gridMs = bench(tickGrid, nodes, K_REP, reps);
  const speedup = (naiveMs / gridMs).toFixed(1);
  const naiveOk = naiveMs <= FRAME_BUDGET_MS ? "yes" : "NO";
  const gridOk = gridMs <= FRAME_BUDGET_MS ? "yes" : "NO";
  console.log(
    `${String(n).padEnd(7)} | ${String(spread).padEnd(10)} | ${naiveMs.toFixed(2).padEnd(20)} | ${gridMs.toFixed(2).padEnd(12)} | ${speedup.padEnd(7)}x | ${naiveOk.padEnd(17)} | ${gridOk}`
  );
}
