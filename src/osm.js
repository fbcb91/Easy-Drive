// Downloads the drivable road network around a trip from OpenStreetMap (Overpass API).

import { ROAD_CLASSES } from './config.js';
import { expandBBox, distance } from './geo.js';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export const MAX_TRIP_M = 25000;

export function overpassQuery([s, w, n, e]) {
  const box = [s, w, n, e].map((v) => v.toFixed(5)).join(',');
  const classes = Object.keys(ROAD_CLASSES).join('|');
  return `[out:json][timeout:90];
way["highway"~"^(${classes})$"](${box})->.roads;
rel(bw.roads)["type"="restriction"]->.rules;
(.roads; .roads >; .rules;);
out body qt;`;
}

// Area to download for a trip: both points plus a margin for detours.
export function tripBBox(from, to) {
  const box = [
    Math.min(from[0], to[0]), Math.min(from[1], to[1]),
    Math.max(from[0], to[0]), Math.max(from[1], to[1]),
  ];
  const margin = Math.max(1500, distance(from, to) * 0.3);
  return expandBBox(box, margin);
}

export async function fetchRoads(bbox, { signal } = {}) {
  const body = new URLSearchParams({ data: overpassQuery(bbox) });
  let lastError;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, { method: 'POST', body, signal });
      if (!res.ok) throw new Error(`overpass ${res.status}`);
      const json = await res.json();
      json.bbox = bbox;
      return json;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastError = err;
    }
  }
  throw lastError;
}

const KEPT_TAGS = /^(highway|name|ref|oneway|junction|lanes|maxspeed|access|motor_vehicle|motorcar|vehicle|area|restriction(:motorcar)?|type|.*:conditional)$/;

// Keeps only what the router needs (drivable roads touching the box, their
// nodes, turn restrictions), so a saved trip stays a few MB at most.
export function compactOsm(osm, bbox) {
  const [s, w, n, e] = bbox;
  const nodes = new Map();
  for (const el of osm.elements) if (el.type === 'node') nodes.set(el.id, el);
  const inside = (id) => {
    const p = nodes.get(id);
    return p && p.lat >= s && p.lat <= n && p.lon >= w && p.lon <= e;
  };
  const pickTags = (tags) => Object.fromEntries(Object.entries(tags || {}).filter(([k]) => KEPT_TAGS.test(k)));
  const ways = osm.elements.filter((el) => el.type === 'way' && el.tags?.highway && el.nodes.some(inside));
  const wayIds = new Set(ways.map((wy) => wy.id));
  const usedNodes = new Set(ways.flatMap((wy) => wy.nodes));
  const elements = [];
  for (const id of usedNodes) {
    const p = nodes.get(id);
    if (!p) continue;
    const node = { type: 'node', id, lat: +p.lat.toFixed(7), lon: +p.lon.toFixed(7) };
    if (p.tags?.highway === 'traffic_signals') node.tags = { highway: 'traffic_signals' };
    elements.push(node);
  }
  for (const wy of ways) elements.push({ type: 'way', id: wy.id, nodes: wy.nodes, tags: pickTags(wy.tags) });
  for (const el of osm.elements) {
    if (el.type === 'relation' && el.members?.some((m) => m.type === 'way' && wayIds.has(m.ref))) {
      elements.push({ type: 'relation', id: el.id, members: el.members, tags: pickTags(el.tags) });
    }
  }
  return { bbox, elements };
}
