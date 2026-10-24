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
