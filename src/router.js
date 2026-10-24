// Edge-based Dijkstra with a cost of: time + λ × stress.
//
// A search state is (edge, entered-by-maneuver flag). The flag lets us
// charge extra stress when two maneuvers follow each other too closely.

import { turnKey } from './graph.js';
import { distance, turnAngle, projectOnSegment, slicePolyline } from './geo.js';
import {
  ANGLE, TURN_TIME_S, STRESS, SIGNAL_DELAY_S, CLOSE_MANEUVER_M, RESTRICTED_PENALTY_S,
} from './config.js';

// Describes what the driver has to do when going from edge a to edge b.
export function describeTurn(graph, a, b, options) {
  const { edges, nodes } = graph;
  const ea = edges[a];
  const eb = edges[b];
  const node = nodes[ea.to];
  const angle = turnAngle(ea.bearingEnd, eb.bearingStart);
  const abs = Math.abs(angle);
  const uturn = eb.segment === ea.segment;

  // Signals right after another signal (dual carriageways) are counted once.
  const signal = node.signal && !(ea.length < 40 && nodes[ea.from].signal);
  const majorRank = Math.max(...graph.outEdges[ea.to].map((id) => edges[id].rank));
  const ontoMajor = !signal && eb.rank > ea.rank && eb.rank >= majorRank;

  let time = signal ? SIGNAL_DELAY_S : 0;
  let stress = 0;
  let maneuver = false;
  let kind = 'straight';

  if (uturn) {
    kind = 'uturn';
    maneuver = true;
    time += TURN_TIME_S.uturn;
    stress += STRESS.maneuver + STRESS.uturn;
  } else if (eb.roundabout && !ea.roundabout) {
    kind = 'roundabout';
    maneuver = true;
    time += TURN_TIME_S.roundabout;
    stress += STRESS.roundabout;
  } else if (ea.roundabout) {
    kind = eb.roundabout ? 'straight' : 'exit';
  } else {
    const same = sameStreet(ea, eb);
    const straightest = options.every((o) => o.b === b || Math.abs(o.angle) >= abs);
    const natural = (same && abs < 60) || (straightest && abs < ANGLE.straight);
    if (abs >= ANGLE.turn) kind = angle > 0 ? 'right' : 'left';
    else if (abs >= ANGLE.straight) kind = angle > 0 ? 'slight-right' : 'slight-left';
    maneuver = options.length > 1 && !natural;
    if (abs >= ANGLE.turn) time += kind === 'left' ? TURN_TIME_S.left : TURN_TIME_S.right;
    else if (abs >= ANGLE.straight) time += TURN_TIME_S.slight;
    if (abs >= ANGLE.sharp) time += TURN_TIME_S.sharp;
    if (ontoMajor) time += TURN_TIME_S.yieldMajor;
    if (maneuver) {
      stress += STRESS.maneuver;
      if (kind === 'left') stress += STRESS.left;
      if (abs >= ANGLE.sharp) stress += STRESS.sharp;
      if (ontoMajor) stress += kind === 'left' ? STRESS.unsignalizedLeftOntoMajor : STRESS.unsignalizedOntoMajor;
    }
  }
  return { to: b, angle, kind, maneuver, time, stress };
}

function sameStreet(a, b) {
  if (a.name && a.name === b.name) return true;
  if (a.ref && a.ref === b.ref) return true;
  return !a.name && !b.name && a.wayId === b.wayId;
}

// Allowed successors of an edge with their turn descriptions (cached on the graph).
export function successors(graph, a) {
  graph.succCache ??= new Map();
  let list = graph.succCache.get(a);
  if (list) return list;
  const ea = graph.edges[a];
  const candidates = graph.outEdges[ea.to].filter((b) => !graph.forbidden.has(turnKey(a, b)));
  const forward = candidates.filter((b) => graph.edges[b].segment !== ea.segment);
  const options = forward.map((b) => ({ b, angle: turnAngle(ea.bearingEnd, graph.edges[b].bearingStart) }));
  // U-turns only where the road ends (no other way forward).
  const allowed = forward.length ? forward : candidates;
  list = allowed.map((b) => describeTurn(graph, a, b, options));
  graph.succCache.set(a, list);
  return list;
}

// Snaps a point to the closest stretch of road.
export function snap(graph, point) {
  let best = null;
  for (const e of graph.edges) {
    if (e.twin !== -1 && e.twin < e.id) continue; // same geometry, check once
    let walked = 0;
    for (let i = 1; i < e.geom.length; i++) {
      const p = projectOnSegment(point, e.geom[i - 1], e.geom[i]);
      const segLen = distance(e.geom[i - 1], e.geom[i]);
      if (!best || p.dist < best.dist) {
        best = { edge: e.id, dist: p.dist, offset: walked + p.t * segLen, point: p.point };
      }
      walked += segLen;
    }
  }
  if (!best) return null;
  const e = graph.edges[best.edge];
  const t = e.length ? Math.min(1, best.offset / e.length) : 0;
  // Points right at an intersection can leave or arrive along any of its roads.
  const node = best.offset < NODE_SNAP_M ? e.from : e.length - best.offset < NODE_SNAP_M ? e.to : -1;
  if (node !== -1) {
    return {
      point: best.point,
      dist: best.dist,
      departures: graph.outEdges[node].map((id) => ({ edge: id, t: 0 })),
      arrivals: graph.inEdges[node].map((id) => ({ edge: id, t: 1 })),
    };
  }
  const options = [{ edge: e.id, t }];
  if (e.twin !== -1) options.push({ edge: e.twin, t: 1 - t });
  return { point: best.point, dist: best.dist, departures: options, arrivals: options };
}

const NODE_SNAP_M = 8;

function edgeCost(e, lambda, avoidRestricted) {
  return e.timeS + lambda * e.stress + (avoidRestricted && e.restricted ? RESTRICTED_PENALTY_S : 0);
}

export function route(graph, start, end, { lambda = 0, avoidRestricted = true } = {}) {
  const { edges } = graph;
  const dist = new Map();
  const parent = new Map();
  const heap = new MinHeap();
  const targets = new Map(end.arrivals.map((o) => [o.edge, o.t]));

  for (const o of start.departures) {
    const s = o.edge * 2;
    const g = (1 - o.t) * edgeCost(edges[o.edge], lambda, avoidRestricted);
    dist.set(s, g);
    parent.set(s, { prev: -1, startT: o.t });
    heap.push(g, s);
  }

  let best = Infinity;
  let bestState = -1;
  while (heap.size) {
    const [g, s] = heap.pop();
    if (g > dist.get(s)) continue;
    if (g >= best) break;
    const a = s >> 1;
    const ea = edges[a];

    if (targets.has(a)) {
      const tEnd = targets.get(a);
      const p = parent.get(s);
      if (p.prev !== -1 || tEnd >= p.startT) {
        const total = g - (1 - tEnd) * edgeCost(ea, lambda, avoidRestricted);
        if (total < best) {
          best = total;
          bestState = s;
        }
      }
    }

    const flag = s & 1;
    for (const t of successors(graph, a)) {
      const close = flag && t.maneuver && ea.length < CLOSE_MANEUVER_M ? STRESS.close : 0;
      const cost = g + t.time + lambda * (t.stress + close) + edgeCost(edges[t.to], lambda, avoidRestricted);
      const ns = t.to * 2 + (t.maneuver ? 1 : 0);
      if (cost < (dist.get(ns) ?? Infinity)) {
        dist.set(ns, cost);
        parent.set(ns, { prev: s, turn: t, close });
        heap.push(cost, ns);
      }
    }
  }
  if (bestState === -1) return null;

  const chain = [];
  for (let s = bestState; s !== -1; s = parent.get(s).prev) chain.push(s);
  chain.reverse();
  return summarize(graph, chain.map((s) => ({ edge: s >> 1, ...parent.get(s) })), targets, lambda);
}

// Turns a chain of states into a route with geometry and honest metrics.
function summarize(graph, steps, targets, lambda) {
  const { edges } = graph;
  const first = steps[0];
  const last = steps[steps.length - 1];
  const endT = targets.get(last.edge);
  const legs = [];
  let time = 0, stress = 0, distance = 0;
  const coords = [];

  steps.forEach((step, i) => {
    const e = edges[step.edge];
    const from = i === 0 ? first.startT : 0;
    const to = i === steps.length - 1 ? endT : 1;
    const frac = Math.max(0, to - from);
    const piece = slicePolyline(e.geom, from, to);
    coords.push(...(coords.length ? piece.slice(1) : piece));
    if (step.turn) {
      time += step.turn.time;
      stress += step.turn.stress + step.close;
    }
    time += e.timeS * frac;
    stress += e.stress * frac;
    distance += e.length * frac;
    legs.push({ edge: step.edge, turn: step.turn || null, close: !!step.close, length: e.length * frac });
  });

  return { lambda, legs, coords, time, stress, distance, key: steps.map((s) => s.edge).join(',') };
}

class MinHeap {
  constructor() {
    this.keys = [];
    this.vals = [];
  }
  get size() {
    return this.keys.length;
  }
  push(k, v) {
    const { keys, vals } = this;
    let i = keys.length;
    keys.push(k);
    vals.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= k) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }
  pop() {
    const { keys, vals } = this;
    const top = [keys[0], vals[0]];
    const k = keys.pop();
    const v = vals.pop();
    const n = keys.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= k) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = k;
      vals[i] = v;
    }
    return top;
  }
}
