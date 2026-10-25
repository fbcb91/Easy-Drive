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
  let maneuver = false;
  let kind = 'straight';
  // Stress split by cause, so the app can explain its choices.
  const parts = { maneuver: 0, left: 0, major: 0 };

  if (uturn) {
    kind = 'uturn';
    maneuver = true;
    time += TURN_TIME_S.uturn;
    parts.maneuver = STRESS.maneuver + STRESS.uturn;
  } else if (eb.roundabout && !ea.roundabout) {
    kind = 'roundabout';
    maneuver = true;
    time += TURN_TIME_S.roundabout;
    parts.maneuver = STRESS.roundabout;
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
      parts.maneuver = STRESS.maneuver + (abs >= ANGLE.sharp ? STRESS.sharp : 0);
      if (kind === 'left') parts.left = STRESS.left;
      if (ontoMajor) parts.major = kind === 'left' ? STRESS.unsignalizedLeftOntoMajor : STRESS.unsignalizedOntoMajor;
    }
  }
  const stress = parts.maneuver + parts.left + parts.major;
  return { to: b, angle, kind, maneuver, time, stress, parts, signal, ontoMajor: maneuver && ontoMajor };
}

// Same street = same name (or ref) on a road of similar importance. A corso's
// side lane (controviale) shares the name but is a much smaller road, so
// moving onto it is a real maneuver.
function sameStreet(a, b) {
  if (Math.abs(a.rank - b.rank) > 1) return false;
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
  const endT = targets.get(steps[steps.length - 1].edge);
  const coords = [];
  const legs = steps.map((step, i) => {
    const e = edges[step.edge];
    const from = i === 0 ? steps[0].startT : 0;
    const to = i === steps.length - 1 ? endT : 1;
    const piece = slicePolyline(e.geom, from, to);
    coords.push(...(coords.length ? piece.slice(1) : piece));
    return { edge: step.edge, from, to, turn: step.turn || null, close: !!step.close };
  });
  return { lambda, legs, coords, ...measure(graph, legs) };
}

// Time, distance and stress (split by cause) of a list of legs.
export function measure(graph, legs) {
  const breakdown = { maneuver: 0, left: 0, major: 0, close: 0, narrow: 0 };
  let time = 0, distance = 0, signals = 0;
  for (const leg of legs) {
    const e = graph.edges[leg.edge];
    const frac = Math.max(0, leg.to - leg.from);
    leg.length = e.length * frac;
    if (leg.turn) {
      time += leg.turn.time;
      breakdown.maneuver += leg.turn.parts.maneuver;
      breakdown.left += leg.turn.parts.left;
      breakdown.major += leg.turn.parts.major;
      if (leg.turn.signal) signals++;
    }
    if (leg.close) breakdown.close += STRESS.close;
    time += e.timeS * frac;
    breakdown.narrow += e.stress * frac;
    distance += leg.length;
  }
  const stress = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { time, distance, stress, breakdown, signals, key: legs.map((l) => l.edge).join(',') };
}

// Chains routes that meet at waypoints (A → tappa → … → B) into one route,
// adding the turn the driver makes at each waypoint.
export function joinRoutes(graph, parts) {
  const legs = parts[0].legs.map((l) => ({ ...l }));
  const coords = [...parts[0].coords];
  for (const part of parts.slice(1)) {
    const next = part.legs.map((l) => ({ ...l }));
    const last = legs[legs.length - 1];
    if (next[0].edge === last.edge && next[0].from >= last.to - 1e-6) {
      // The waypoint is in the middle of a road we keep driving on.
      last.to = next[0].to;
      next.shift();
    } else {
      next[0].turn = successors(graph, last.edge).find((t) => t.to === next[0].edge) || uturnAt(graph, next[0].edge);
    }
    legs.push(...next);
    coords.push(...part.coords.slice(1));
  }
  // Each part was searched on its own, so redo "close maneuver" flags across the joins.
  for (let i = 1; i < legs.length; i++) {
    const prev = legs[i - 1];
    legs[i].close = !!(legs[i].turn?.maneuver && prev.turn?.maneuver && graph.edges[prev.edge].length < CLOSE_MANEUVER_M);
  }
  return { lambda: null, legs, coords, ...measure(graph, legs) };
}

// Turning back on the same road at a waypoint (only happens if the driver asks for it).
function uturnAt(graph, edge) {
  return {
    to: edge, angle: 180, kind: 'uturn', maneuver: true, signal: false, ontoMajor: false,
    time: TURN_TIME_S.uturn,
    stress: STRESS.maneuver + STRESS.uturn,
    parts: { maneuver: STRESS.maneuver + STRESS.uturn, left: 0, major: 0 },
  };
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
