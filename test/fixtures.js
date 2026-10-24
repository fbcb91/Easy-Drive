// Builds small synthetic cities in the same JSON shape Overpass returns.
// Coordinates are given in metres (x east, y north) around central Turin.

const ORIGIN = [45.0703, 7.6869];
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos((ORIGIN[0] * Math.PI) / 180);

export function toLatLon([x, y]) {
  return [ORIGIN[0] + y / M_PER_DEG_LAT, ORIGIN[1] + x / M_PER_DEG_LON];
}

// ways: [{ points: [[x,y],...], tags: {...} }]; signals: [[x,y],...]
// restrictions: [{ from: wayIndex, via: [x,y], to: wayIndex, kind }]
export function makeCity({ ways, signals = [], restrictions = [] }) {
  const nodeIds = new Map();
  const elements = [];
  let nextId = 1;
  const signalKeys = new Set(signals.map(key));
  const nodeId = (p) => {
    const k = key(p);
    if (!nodeIds.has(k)) {
      const id = nextId++;
      nodeIds.set(k, id);
      const [lat, lon] = toLatLon(p);
      const node = { type: 'node', id, lat, lon };
      if (signalKeys.has(k)) node.tags = { highway: 'traffic_signals' };
      elements.push(node);
    }
    return nodeIds.get(k);
  };
  const wayIds = ways.map((w, i) => {
    const id = 1000 + i;
    elements.push({ type: 'way', id, nodes: w.points.map(nodeId), tags: w.tags });
    return id;
  });
  restrictions.forEach((r, i) => {
    elements.push({
      type: 'relation',
      id: 5000 + i,
      tags: { type: 'restriction', restriction: r.kind },
      members: [
        { type: 'way', ref: wayIds[r.from], role: 'from' },
        { type: 'node', ref: nodeId(r.via), role: 'via' },
        { type: 'way', ref: wayIds[r.to], role: 'to' },
      ],
    });
  });
  return { elements };
}

function key([x, y]) {
  return `${Math.round(x)},${Math.round(y)}`;
}

// A city where the time-optimal route zig-zags through small streets, while a
// pair of signalised "corsi" offers a route that is a bit slower but has a
// single turn. Start (0,0), end (600,600).
export function zigzagCity() {
  const ways = [];
  const signals = [];
  // Corso Francia along the bottom, Corso Regina up the right side, signals every 200 m.
  const bottom = [];
  for (let x = 0; x <= 700; x += 100) bottom.push([x, 0]);
  const right = [];
  for (let y = 0; y <= 600; y += 100) right.push([600, y]);
  ways.push({ points: bottom, tags: { highway: 'primary', name: 'Corso Francia' } });
  ways.push({ points: right, tags: { highway: 'primary', name: 'Corso Regina Margherita' } });
  for (let v = 200; v <= 600; v += 200) {
    signals.push([v, 0]);
    signals.push([600, v]);
  }

  // Zig-zag of short residential streets roughly along the diagonal,
  // alternating between bearings of 30° and 60°. Each corner also has a short
  // dead-end street going straight on, so every corner is a real decision.
  let p = [0, 0];
  const zig = [p];
  for (let i = 0; i < 12; i++) {
    const deg = i % 2 === 0 ? 30 : 60;
    const len = 600 * Math.SQRT2 / 12 / Math.cos((15 * Math.PI) / 180);
    const rad = (deg * Math.PI) / 180;
    p = [p[0] + Math.sin(rad) * len, p[1] + Math.cos(rad) * len];
    zig.push(p);
  }
  zig[zig.length - 1] = [600, 600];
  for (let i = 1; i < zig.length; i++) {
    ways.push({ points: [zig[i - 1], zig[i]], tags: { highway: 'residential', name: `Via Vicolo ${i}` } });
    if (i < zig.length - 1) {
      const a = zig[i - 1];
      const b = zig[i];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const n = Math.hypot(dx, dy);
      ways.push({ points: [b, [b[0] + (dx / n) * 50, b[1] + (dy / n) * 50]], tags: { highway: 'residential', name: `Cortile ${i}` } });
    }
  }
  return makeCity({ ways, signals });
}
