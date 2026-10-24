// Computes the fastest route and a family of simpler ones, then picks the
// simplest route that costs at most `extraMinutes` more than the fastest.

import { route, snap } from './router.js';
import { buildSteps, countStress } from './instructions.js';
import { STRESS_WEIGHTS } from './config.js';

export const MAX_SNAP_DISTANCE_M = 300;

export function planCandidates(graph, from, to, { avoidRestricted = true } = {}) {
  const start = snap(graph, from);
  const end = snap(graph, to);
  if (!start || start.dist > MAX_SNAP_DISTANCE_M) throw new PlanError('start-off-road');
  if (!end || end.dist > MAX_SNAP_DISTANCE_M) throw new PlanError('end-off-road');

  const seen = new Map();
  for (const lambda of STRESS_WEIGHTS) {
    const r = route(graph, start, end, { lambda, avoidRestricted });
    if (!r) continue;
    if (!seen.has(r.key)) {
      r.counts = countStress(graph, r);
      r.steps = buildSteps(graph, r);
      seen.set(r.key, r);
    }
  }
  const candidates = [...seen.values()];
  if (!candidates.length) throw new PlanError('no-route');
  return candidates;
}

export function choose(candidates, extraMinutes) {
  const fastest = candidates.reduce((a, b) => (b.time < a.time ? b : a));
  const budget = fastest.time + extraMinutes * 60;
  const easy = candidates
    .filter((r) => r.time <= budget)
    .reduce((a, b) => (b.stress < a.stress - 1e-9 || (Math.abs(b.stress - a.stress) < 1e-9 && b.time < a.time) ? b : a));
  return { fastest, easy, same: easy.key === fastest.key };
}

export class PlanError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
