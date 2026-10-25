import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildGraph } from '../src/graph.js';
import { planCandidates, planVia, choose } from '../src/planner.js';
import { compactOsm } from '../src/osm.js';
import { makeTrip, tripFileName } from '../src/trips.js';
import { zigzagCity, toLatLon } from './fixtures.js';

const run = promisify(execFile);

function savedTrip(viaXY) {
  const osm = zigzagCity();
  const [s, w] = toLatLon([-200, -200]);
  const [n, e] = toLatLon([800, 800]);
  osm.bbox = [s, w, n, e];
  const graph = buildGraph(osm);
  const from = { label: 'Piazza Statuto', latlng: toLatLon([0, 0]) };
  const to = { label: 'Piazza Vittorio Veneto', latlng: toLatLon([600, 600]) };
  const { easy, fastest } = choose(planCandidates(graph, from.latlng, to.latlng), 4);
  const via = viaXY.map(toLatLon);
  const mine = via.length ? planVia(graph, [from.latlng, ...via, to.latlng]) : null;
  return makeTrip({ from, to, via, note: 'prova', extraMinutes: 4, avoidRestricted: true, osm, easy, fastest, mine });
}

test('compact OSM data keeps everything the router needs', () => {
  const osm = zigzagCity();
  const [s, w] = toLatLon([-200, -200]);
  const [n, e] = toLatLon([800, 800]);
  const compact = compactOsm(osm, [s, w, n, e]);
  const a = buildGraph(osm);
  const b = buildGraph(compact);
  assert.equal(b.edges.length, a.edges.length);
  assert.equal(b.nodes.filter((x) => x.signal).length, a.nodes.filter((x) => x.signal).length);
});

test('a saved trip has a readable name and the driver\'s route', () => {
  const trip = savedTrip([[350, 0]]);
  assert.equal(tripFileName(trip), 'tragitto-piazza-statuto--piazza-vittorio-veneto.json');
  assert.equal(trip.format, 'easy-drive-trip');
  assert.equal(trip.results.mine.counts.maneuvers, 1);
  assert.deepEqual(trip.results.easy.steps, trip.results.mine.steps);
});

test('check-trips replays saved trips and compares them with Easy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'easy-drive-'));
  try {
    await writeFile(join(dir, 'a.json'), JSON.stringify(savedTrip([[350, 0]])));
    await writeFile(join(dir, 'b.json'), JSON.stringify(savedTrip([[300, 300]])));
    const { stdout } = await run(process.execPath, ['scripts/check-trips.mjs', dir]);
    assert.match(stdout, /in comune con Easy: 100% → Easy coincide con il tuo percorso/);
    assert.match(stdout, /in comune con Easy: 0% → il modello giudica il tuo percorso più stressante/);
  } finally {
    await rm(dir, { recursive: true });
  }
});
