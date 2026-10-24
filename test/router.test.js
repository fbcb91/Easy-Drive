import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, onewayDirection, parseMaxspeed, isDrivable } from '../src/graph.js';
import { route, snap } from '../src/router.js';
import { planCandidates, choose, PlanError } from '../src/planner.js';
import { turnAngle, bearing } from '../src/geo.js';
import { makeCity, zigzagCity, toLatLon } from './fixtures.js';

const res = (name, extra = {}) => ({ highway: 'residential', name, ...extra });

test('turn angles are signed: right positive, left negative', () => {
  assert.equal(turnAngle(0, 90), 90);
  assert.equal(turnAngle(0, 270), -90);
  assert.equal(turnAngle(350, 10), 20);
  assert.equal(Math.round(bearing(toLatLon([0, 0]), toLatLon([100, 0]))), 90);
});

test('OSM tag parsing', () => {
  assert.equal(onewayDirection({ oneway: 'yes' }), 1);
  assert.equal(onewayDirection({ oneway: '-1' }), -1);
  assert.equal(onewayDirection({ junction: 'roundabout' }), 1);
  assert.equal(onewayDirection({ highway: 'primary' }), 0);
  assert.equal(parseMaxspeed('30'), 30);
  assert.equal(parseMaxspeed('IT:urban'), 50);
  assert.equal(isDrivable({ highway: 'footway' }), false);
  assert.equal(isDrivable({ highway: 'residential', access: 'private' }), false);
  assert.equal(isDrivable({ highway: 'residential', access: 'no', motor_vehicle: 'yes' }), true);
  assert.equal(isDrivable({ highway: 'primary', access: 'no', bus: 'yes' }), false);
});

test('Easy route trades a little time for far fewer maneuvers', () => {
  const graph = buildGraph(zigzagCity());
  const candidates = planCandidates(graph, toLatLon([0, 0]), toLatLon([600, 600]));
  const { fastest, easy, same } = choose(candidates, 4);
  assert.equal(same, false);
  assert.ok(fastest.counts.maneuvers >= 10, `fastest has ${fastest.counts.maneuvers} maneuvers`);
  assert.equal(easy.counts.maneuvers, 1);
  assert.ok(easy.time > fastest.time);
  assert.ok(easy.time - fastest.time < 60);
  assert.deepEqual(easy.steps.map((s) => s.text), [
    'Parti verso est su Corso Francia',
    'Svolta a sinistra in Corso Regina Margherita',
    'Sei arrivato a destinazione',
  ]);
});

test('with no extra time allowed the fastest route is chosen', () => {
  const graph = buildGraph(zigzagCity());
  const { easy, fastest, same } = choose(planCandidates(graph, toLatLon([0, 0]), toLatLon([600, 600])), 0);
  assert.equal(same, true);
  assert.equal(easy, fastest);
});

test('one-way streets are respected', () => {
  // Direct street from A to B is one-way the wrong way; the detour must be used.
  const graph = buildGraph(makeCity({
    ways: [
      { points: [[300, 0], [0, 0]], tags: res('Via Senso Unico', { oneway: 'yes' }) },
      { points: [[0, 0], [0, 100], [300, 100], [300, 0]], tags: res('Via Giro') },
    ],
  }));
  const r = route(graph, snap(graph, toLatLon([0, 0])), snap(graph, toLatLon([300, 0])));
  assert.ok(Math.abs(r.distance - 500) < 2, `distance ${r.distance}`);
});

test('turn restrictions are respected', () => {
  // Coming north on Via Sud, left onto Via Ovest is banned: go via the loop instead.
  const ways = [
    { points: [[0, -200], [0, 0]], tags: res('Via Sud') },
    { points: [[0, 0], [-200, 0]], tags: res('Via Ovest') },
    { points: [[0, 0], [0, 100], [-200, 100], [-200, 0]], tags: res('Via Anello') },
  ];
  const free = buildGraph(makeCity({ ways }));
  const banned = buildGraph(makeCity({ ways, restrictions: [{ from: 0, via: [0, 0], to: 1, kind: 'no_left_turn' }] }));
  const from = toLatLon([0, -200]);
  const to = toLatLon([-100, 0]);
  const a = route(free, snap(free, from), snap(free, to));
  const b = route(banned, snap(banned, from), snap(banned, to));
  assert.ok(Math.abs(a.distance - 300) < 2, `free distance ${a.distance}`);
  assert.ok(b.distance > 450, `banned distance ${b.distance}`);
});

test('roundabout exits are counted in the instructions', () => {
  // Square roundabout with arms leaving south (entry), east, north and west.
  const ring = { points: [[0, -20], [20, 0], [0, 20], [-20, 0], [0, -20]], tags: { highway: 'primary', junction: 'roundabout' } };
  const graph = buildGraph(makeCity({
    ways: [
      ring,
      { points: [[0, -300], [0, -20]], tags: res('Via Ingresso') },
      { points: [[20, 0], [300, 0]], tags: res('Via Est') },
      { points: [[0, 20], [0, 300]], tags: res('Via Nord') },
      { points: [[-20, 0], [-300, 0]], tags: res('Via Ovest') },
    ],
  }));
  const r = route(graph, snap(graph, toLatLon([0, -300])), snap(graph, toLatLon([0, 250])));
  const [plan] = planCandidates(graph, toLatLon([0, -300]), toLatLon([0, 250]));
  assert.ok(r);
  assert.ok(plan.steps.some((s) => s.text === 'Alla rotonda prendi la 2ª uscita su Via Nord'), plan.steps.map((s) => s.text).join('\n'));
});

test('points far from any road are rejected', () => {
  const graph = buildGraph(zigzagCity());
  assert.throws(() => planCandidates(graph, toLatLon([0, 0]), toLatLon([5000, 5000])), (e) => e instanceof PlanError && e.code === 'end-off-road');
});

test('routing a city-sized grid stays fast', () => {
  // 70 x 70 blocks of 90 m (about 6 km a side), every 5th street a signalised corso.
  const ways = [];
  const signals = [];
  const N = 70, S = 90;
  for (let i = 0; i <= N; i++) {
    const major = i % 5 === 0;
    const tags = (n) => (major ? { highway: 'primary', name: `Corso ${n}${i}` } : res(`Via ${n}${i}`, i % 2 ? { oneway: 'yes' } : {}));
    const row = [], col = [];
    for (let j = 0; j <= N; j++) {
      row.push([j * S, i * S]);
      col.push([i * S, j * S]);
      if (major && j % 5 === 0) signals.push([j * S, i * S]);
    }
    ways.push({ points: row, tags: tags('R') }, { points: col, tags: tags('C') });
  }
  const graph = buildGraph(makeCity({ ways, signals }));
  const t0 = performance.now();
  const candidates = planCandidates(graph, toLatLon([95, 130]), toLatLon([N * S - 120, N * S - 70]));
  const ms = performance.now() - t0;
  const { fastest, easy } = choose(candidates, 4);
  assert.ok(ms < 8000, `took ${ms.toFixed(0)} ms`);
  assert.ok(easy.counts.maneuvers <= fastest.counts.maneuvers);
  assert.ok(easy.time <= fastest.time + 240);
  console.log(`grid: ${graph.edges.length} edges, ${candidates.length} candidates in ${ms.toFixed(0)} ms; ` +
    `fastest ${Math.round(fastest.time)}s/${fastest.counts.maneuvers} manovre, easy ${Math.round(easy.time)}s/${easy.counts.maneuvers} manovre`);
});
