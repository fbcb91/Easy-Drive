// Builds a directed road graph from an Overpass JSON response.
//
// Nodes are OSM intersections (plus traffic signals and way ends); each
// directed edge is the stretch of one way between two such nodes.

import { ROAD_CLASSES, MULTILANE_SPEED_FACTOR, MAXSPEED_FACTOR } from './config.js';
import { bearing, polylineLength } from './geo.js';

const YES = new Set(['yes', '1', 'true']);
const DENY = new Set(['no', 'private']);
const ALLOW = new Set(['yes', 'designated', 'permissive', 'destination']);
const CONDITIONAL_KEYS = ['motor_vehicle:conditional', 'motorcar:conditional', 'vehicle:conditional', 'access:conditional'];

export function isDrivable(tags) {
  if (!ROAD_CLASSES[tags.highway] || tags.area === 'yes') return false;
  if (tags.oneway === 'reversible') return false;
  const vehicle = tags.motorcar ?? tags.motor_vehicle ?? tags.vehicle;
  if (vehicle !== undefined) return !DENY.has(vehicle) && vehicle !== 'agricultural' && vehicle !== 'delivery';
  return !DENY.has(tags.access);
}

// 1 = only along the way, -1 = only against it, 0 = both directions.
export function onewayDirection(tags) {
  const ow = tags.oneway;
  if (YES.has(ow)) return 1;
  if (ow === '-1' || ow === 'reverse') return -1;
  if (ow === 'no') return 0;
  if (tags.junction === 'roundabout' || tags.junction === 'circular') return 1;
  if (tags.highway === 'motorway' || tags.highway === 'motorway_link') return 1;
  return 0;
}

export function parseMaxspeed(value) {
  if (!value) return null;
  if (/urban/i.test(value)) return 50;
  if (/living_street/i.test(value)) return 10;
  const m = /^(\d+(?:\.\d+)?)\s*(mph)?/.exec(value);
  if (!m) return null;
  return m[2] ? parseFloat(m[1]) * 1.609 : parseFloat(m[1]);
}

export function realSpeed(tags) {
  let speed = ROAD_CLASSES[tags.highway].speed;
  const lanes = parseInt(tags.lanes, 10);
  const oneway = onewayDirection(tags) !== 0;
  if ((oneway && lanes >= 2) || lanes >= 4) speed *= MULTILANE_SPEED_FACTOR;
  const max = parseMaxspeed(tags.maxspeed);
  if (max) speed = Math.min(speed, max * MAXSPEED_FACTOR);
  return speed;
}

function hasTimeRestriction(tags) {
  return CONDITIONAL_KEYS.some((k) => tags[k] && /\b(no|private|destination)\b/.test(tags[k]));
}

export function buildGraph(osm) {
  const osmNodes = new Map();
  const ways = [];
  const restrictions = [];
  for (const el of osm.elements) {
    if (el.type === 'node') osmNodes.set(el.id, el);
    else if (el.type === 'way' && el.tags && isDrivable(el.tags)) ways.push(el);
    else if (el.type === 'relation' && el.tags?.type === 'restriction') restrictions.push(el);
  }

  // Count how many ways use each node to find intersections.
  const usage = new Map();
  for (const way of ways) {
    for (const id of way.nodes) usage.set(id, (usage.get(id) || 0) + 1);
  }

  const nodes = []; // { id, lat, lon, signal }
  const nodeIndex = new Map();
  const nodeFor = (osmId) => {
    let idx = nodeIndex.get(osmId);
    if (idx === undefined) {
      const n = osmNodes.get(osmId);
      idx = nodes.length;
      nodes.push({ id: osmId, lat: n.lat, lon: n.lon, signal: n.tags?.highway === 'traffic_signals' });
      nodeIndex.set(osmId, idx);
    }
    return idx;
  };

  const edges = [];
  const arriving = new Map(); // `${wayId}:${nodeIdx}` -> edge ids ending there
  const departing = new Map(); // `${wayId}:${nodeIdx}` -> edge ids starting there
  const push = (map, key, value) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };

  let segmentId = 0;
  for (const way of ways) {
    const refs = way.nodes.filter((id) => osmNodes.has(id));
    if (refs.length < 2) continue;
    const tags = way.tags;
    const cls = ROAD_CLASSES[tags.highway];
    const dir = onewayDirection(tags);
    const attrs = {
      wayId: way.id,
      name: tags.name || '',
      ref: tags.ref || '',
      highway: tags.highway,
      rank: cls.rank,
      roundabout: tags.junction === 'roundabout' || tags.junction === 'circular',
      speedKmh: realSpeed(tags),
      stressPerKm: cls.stressPerKm,
      restricted: hasTimeRestriction(tags),
    };

    let start = 0;
    for (let i = 1; i < refs.length; i++) {
      const id = refs[i];
      const n = osmNodes.get(id);
      const split = i === refs.length - 1 || usage.get(id) > 1 || n.tags?.highway === 'traffic_signals';
      if (!split) continue;
      const geom = refs.slice(start, i + 1).map((r) => {
        const o = osmNodes.get(r);
        return [o.lat, o.lon];
      });
      const length = polylineLength(geom);
      if (length > 0) {
        const a = nodeFor(refs[start]);
        const b = nodeFor(id);
        const seg = segmentId++;
        if (dir >= 0) edges.push(makeEdge(edges.length, a, b, geom, length, seg, attrs));
        if (dir <= 0) edges.push(makeEdge(edges.length, b, a, geom.slice().reverse(), length, seg, attrs));
      }
      start = i;
    }
  }

  const outEdges = nodes.map(() => []);
  const inEdges = nodes.map(() => []);
  for (const e of edges) {
    outEdges[e.from].push(e.id);
    inEdges[e.to].push(e.id);
    push(arriving, `${e.wayId}:${e.to}`, e.id);
    push(departing, `${e.wayId}:${e.from}`, e.id);
  }

  // Twin = the same stretch of road in the opposite direction (for U-turns and snapping).
  const bySegment = new Map();
  for (const e of edges) push(bySegment, e.segment, e.id);
  for (const list of bySegment.values()) {
    if (list.length === 2) {
      edges[list[0]].twin = list[1];
      edges[list[1]].twin = list[0];
    }
  }

  const forbidden = new Set();
  for (const rel of restrictions) {
    const kind = rel.tags.restriction || rel.tags['restriction:motorcar'];
    if (!kind) continue;
    const from = rel.members.find((m) => m.role === 'from' && m.type === 'way');
    const via = rel.members.find((m) => m.role === 'via' && m.type === 'node');
    const to = rel.members.find((m) => m.role === 'to' && m.type === 'way');
    if (!from || !via || !to || !nodeIndex.has(via.ref)) continue;
    const viaIdx = nodeIndex.get(via.ref);
    const ins = arriving.get(`${from.ref}:${viaIdx}`) || [];
    if (kind.startsWith('no_')) {
      const outs = departing.get(`${to.ref}:${viaIdx}`) || [];
      for (const a of ins) for (const b of outs) forbidden.add(turnKey(a, b));
    } else if (kind.startsWith('only_')) {
      for (const a of ins) {
        for (const b of outEdges[viaIdx]) {
          if (edges[b].wayId !== to.ref) forbidden.add(turnKey(a, b));
        }
      }
    }
  }

  return { nodes, edges, outEdges, inEdges, forbidden, bbox: osm.bbox || null };
}

export function turnKey(a, b) {
  return a * 4194304 + b;
}

function makeEdge(id, from, to, geom, length, segment, attrs) {
  const n = geom.length;
  return {
    id,
    from,
    to,
    geom,
    length,
    segment,
    twin: -1,
    ...attrs,
    timeS: length / (attrs.speedKmh / 3.6),
    stress: (length / 1000) * attrs.stressPerKm,
    // Bearings measured over up to ~20 m so tiny kinks near nodes don't fake turns.
    bearingStart: bearing(geom[0], pointAlong(geom, 20)),
    bearingEnd: bearing(pointAlong(geom.slice().reverse(), 20), geom[n - 1]),
  };
}

function pointAlong(geom, metres) {
  let walked = 0;
  for (let i = 1; i < geom.length; i++) {
    const seg = polylineLength([geom[i - 1], geom[i]]);
    if (walked + seg >= metres) return geom[i];
    walked += seg;
  }
  return geom[geom.length - 1];
}
