// Saved trips: a driver's own route plus the road data around it, used to
// check and tune the model on real streets (see scripts/check-trips.mjs).

import { compactOsm } from './osm.js';

export const TRIP_FORMAT = 'easy-drive-trip';

function summary(r) {
  if (!r) return null;
  return {
    timeS: Math.round(r.time),
    distanceM: Math.round(r.distance),
    stress: +r.stress.toFixed(2),
    counts: r.counts,
    steps: r.steps.map((s) => s.text),
  };
}

export function makeTrip({ from, to, via, note, extraMinutes, avoidRestricted, osm, easy, fastest, mine }) {
  return {
    format: TRIP_FORMAT,
    version: 1,
    savedAt: new Date().toISOString(),
    from: { label: from.label, latlng: from.latlng },
    to: { label: to.label, latlng: to.latlng },
    via,
    note: note || '',
    settings: { extraMinutes, avoidRestricted },
    results: { easy: summary(easy), fastest: summary(fastest), mine: summary(mine) },
    osm: compactOsm(osm, osm.bbox),
  };
}

export function tripFileName(trip) {
  const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  return `tragitto-${slug(trip.from.label)}--${slug(trip.to.label)}.json`;
}
