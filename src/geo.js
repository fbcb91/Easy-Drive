// Small geodesy helpers. Points are [lat, lon] arrays in degrees.

const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;

export function distance(a, b) {
  const dLat = (b[0] - a[0]) * RAD;
  const dLon = (b[1] - a[1]) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Initial bearing from a to b, 0..360 degrees clockwise from north.
export function bearing(a, b) {
  const lat1 = a[0] * RAD;
  const lat2 = b[0] * RAD;
  const dLon = (b[1] - a[1]) * RAD;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

// Signed turn from an incoming to an outgoing bearing, in (-180, 180].
// Positive means a right turn, negative a left turn.
export function turnAngle(inBearing, outBearing) {
  let d = (outBearing - inBearing) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += distance(points[i - 1], points[i]);
  return len;
}

// Projects p onto segment a-b using a local flat approximation (fine at city scale).
export function projectOnSegment(p, a, b) {
  const kx = Math.cos(p[0] * RAD);
  const ax = a[1] * kx, ay = a[0];
  const bx = b[1] * kx, by = b[0];
  const px = p[1] * kx, py = p[0];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { t, point, dist: distance(p, point) };
}

// Returns the part of a polyline between two fractions (0..1) of its length.
export function slicePolyline(points, from, to) {
  const total = polylineLength(points);
  const start = from * total;
  const end = to * total;
  const out = [];
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = distance(a, b);
    const segStart = walked;
    const segEnd = walked + seg;
    if (segEnd >= start && segStart <= end && seg > 0) {
      const t0 = Math.max(0, (start - segStart) / seg);
      const t1 = Math.min(1, (end - segStart) / seg);
      const p0 = lerp(a, b, t0);
      const p1 = lerp(a, b, t1);
      if (!out.length) out.push(p0);
      out.push(p1);
    }
    walked = segEnd;
  }
  if (!out.length) out.push(points[0]);
  return out;
}

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// Expands a [south, west, north, east] box by a margin in metres.
export function expandBBox([s, w, n, e], marginM) {
  const dLat = marginM / 111320;
  const dLon = marginM / (111320 * Math.cos(((s + n) / 2) * RAD));
  return [s - dLat, w - dLon, n + dLat, e + dLon];
}

export function bboxContains(outer, inner) {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}
