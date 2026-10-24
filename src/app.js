// Browser UI: map, search, route comparison and turn-by-turn list.
/* global L */

import { buildGraph } from './graph.js';
import { planCandidates, choose, PlanError } from './planner.js';
import { fetchRoads, tripBBox, MAX_TRIP_M } from './osm.js';
import { bboxContains, distance, expandBBox } from './geo.js';

const TORINO = { center: [45.0703, 7.6869], viewbox: '7.55,45.15,7.80,44.98' };
const EXAMPLE = {
  from: { label: 'Piazza Castello', latlng: [45.07121, 7.68555] },
  to: { label: 'Lingotto, Via Nizza', latlng: [45.03253, 7.66713] },
};
const ERRORS = {
  'start-off-road': 'La partenza è lontana da strade percorribili in auto. Spostala su una strada.',
  'end-off-road': "L'arrivo è lontano da strade percorribili in auto. Spostalo su una strada.",
  'no-route': 'Non ho trovato un percorso tra i due punti. Prova a spostarli su strade vicine.',
  'too-far': 'Il prototipo gestisce tragitti fino a circa 25 km. Avvicina i due punti.',
  network: 'Non riesco a scaricare le strade da OpenStreetMap. Il servizio potrebbe essere occupato: riprova tra qualche secondo.',
};

const $ = (id) => document.getElementById(id);
const state = {
  points: { from: null, to: null },
  markers: { from: null, to: null },
  nextClick: 'from',
  cache: null, // { bbox, graph }
  graph: null,
  candidates: null,
  choice: null,
  selected: 'easy',
  layers: [],
  busy: false,
};

// ---------- Map ----------

const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView(TORINO.center, 13);
L.control.zoom({ position: 'topright' }).addTo(map);

const dark = window.matchMedia('(prefers-color-scheme: dark)');
let tiles;
function setTiles() {
  const theme = document.documentElement.dataset.theme;
  const isDark = theme ? theme === 'dark' : dark.matches;
  if (tiles) tiles.remove();
  tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${isDark ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`, {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
}
setTiles();
dark.addEventListener('change', setTiles);

function pinIcon(kind) {
  return L.divIcon({
    className: '',
    html: `<span class="pin pin-${kind}">${kind === 'from' ? 'A' : 'B'}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function setPoint(kind, latlng, label) {
  state.points[kind] = { latlng, label };
  $(`${kind}-input`).value = label;
  if (state.markers[kind]) state.markers[kind].setLatLng(latlng);
  else {
    const m = L.marker(latlng, { icon: pinIcon(kind), draggable: true, keyboard: false }).addTo(map);
    m.on('dragend', () => {
      const p = m.getLatLng();
      setPoint(kind, [p.lat, p.lng], coordLabel([p.lat, p.lng]));
      reverseLabel(kind, [p.lat, p.lng]);
      plan();
    });
    state.markers[kind] = m;
  }
}

function coordLabel([lat, lon]) {
  return `Punto sulla mappa (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
}

map.on('click', (e) => {
  const latlng = [e.latlng.lat, e.latlng.lng];
  const kind = state.nextClick;
  setPoint(kind, latlng, coordLabel(latlng));
  reverseLabel(kind, latlng);
  state.nextClick = kind === 'from' ? 'to' : 'from';
  updateClickHint();
  if (state.points.from && state.points.to) plan();
});

function updateClickHint() {
  $('click-hint').textContent = state.nextClick === 'from'
    ? 'Tocca la mappa per scegliere la partenza.'
    : "Tocca la mappa per scegliere l'arrivo.";
}

// ---------- Search (Nominatim) ----------

async function searchPlace(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({
    format: 'jsonv2', q: query, limit: '1', countrycodes: 'it',
    viewbox: TORINO.viewbox, bounded: '1', 'accept-language': 'it',
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error('nominatim');
  const [hit] = await res.json();
  return hit ? { latlng: [+hit.lat, +hit.lon], label: shortName(hit) } : null;
}

async function reverseLabel(kind, latlng) {
  try {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.search = new URLSearchParams({ format: 'jsonv2', lat: latlng[0], lon: latlng[1], zoom: '17', 'accept-language': 'it' });
    const res = await fetch(url);
    const hit = await res.json();
    const current = state.points[kind];
    if (hit && current && current.latlng === latlng) {
      current.label = shortName(hit);
      $(`${kind}-input`).value = current.label;
    }
  } catch {
    // The coordinates stay as the label.
  }
}

function shortName(hit) {
  const a = hit.address || {};
  const road = a.road || a.pedestrian || a.square;
  if (hit.name && road && hit.name !== road) return `${hit.name}, ${road}`;
  if (road) return a.house_number ? `${road} ${a.house_number}` : road;
  return hit.display_name.split(',').slice(0, 2).join(',');
}

for (const kind of ['from', 'to']) {
  $(`${kind}-form`).addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $(`${kind}-input`).value.trim();
    if (!q) return;
    setStatus(`Cerco “${q}” a Torino…`);
    try {
      const hit = await searchPlace(q);
      if (!hit) {
        setStatus(`Non trovo “${q}” a Torino. Prova con via e numero civico, oppure tocca la mappa.`, 'error');
        return;
      }
      setPoint(kind, hit.latlng, hit.label);
      if (state.points.from && state.points.to) plan();
      else {
        map.panTo(hit.latlng);
        setStatus('');
      }
    } catch {
      setStatus('La ricerca indirizzi non risponde. Tocca la mappa per scegliere il punto.', 'error');
    }
  });
}

$('swap').addEventListener('click', () => {
  const { from, to } = state.points;
  if (!from || !to) return;
  setPoint('from', to.latlng, to.label);
  setPoint('to', from.latlng, from.label);
  plan();
});

// ---------- Planning ----------

const tick = () => new Promise((r) => setTimeout(r, 30));

async function plan() {
  const { from, to } = state.points;
  if (!from || !to || state.busy) return;
  if (distance(from.latlng, to.latlng) > MAX_TRIP_M) {
    setStatus(ERRORS['too-far'], 'error');
    return;
  }
  state.busy = true;
  $('plan').disabled = true;
  try {
    const need = tripBBox(from.latlng, to.latlng);
    if (!state.cache || !bboxContains(state.cache.bbox, need)) {
      setStatus('Scarico le strade della zona da OpenStreetMap…', 'busy');
      // Download a little more than needed so nearby trips reuse the data.
      const osm = await fetchRoads(expandBBox(need, 1000));
      setStatus('Preparo la mappa stradale…', 'busy');
      await tick();
      state.cache = { bbox: osm.bbox, graph: buildGraph(osm) };
    }
    setStatus('Confronto i percorsi…', 'busy');
    await tick();
    state.graph = state.cache.graph;
    state.candidates = planCandidates(state.graph, from.latlng, to.latlng, { avoidRestricted: $('avoid-ztl').checked });
    state.selected = 'easy';
    setStatus('');
    render(true);
  } catch (err) {
    const code = err instanceof PlanError ? err.code : 'network';
    setStatus(ERRORS[code] || ERRORS.network, 'error');
    console.error(err);
  } finally {
    state.busy = false;
    $('plan').disabled = false;
  }
}

$('plan').addEventListener('click', () => plan());
$('avoid-ztl').addEventListener('change', () => plan());
$('extra').addEventListener('input', () => {
  $('extra-value').textContent = `${$('extra').value} min`;
  if (state.candidates) render(false);
});

// ---------- Rendering ----------

function render(fit) {
  const choice = choose(state.candidates, Number($('extra').value));
  state.choice = choice;
  renderCards(choice);
  renderSteps(choice.same || state.selected === 'easy' ? choice.easy : choice.fastest);
  drawRoutes(choice, fit);
}

function minutes(s) {
  return Math.max(1, Math.round(s / 60));
}

function km(m) {
  return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function stat(n, one, many) {
  return `<strong>${n}</strong> ${n === 1 ? one : many}`;
}

function renderCards({ fastest, easy, same }) {
  const card = (kind, r, title) => `
    <button type="button" class="route-card route-${kind}${state.selected === kind || same ? ' is-selected' : ''}" data-kind="${kind}" ${same ? 'disabled' : ''}>
      <span class="route-title">${title}</span>
      <span class="route-time"><strong>${minutes(r.time)}</strong> min</span>
      <span class="route-meta">${km(r.distance)}</span>
      <span class="route-stats">
        <span>${stat(r.counts.maneuvers, 'manovra', 'manovre')}</span>
        <span>${stat(r.counts.left, 'svolta a sinistra', 'svolte a sinistra')}</span>
        <span>${stat(r.counts.close, 'manovra ravvicinata', 'manovre ravvicinate')}</span>
      </span>
    </button>`;

  let summary;
  if (same) {
    summary = `Il percorso più veloce è già il più semplice: ${plural(easy.counts.maneuvers, 'manovra', 'manovre')} in tutto.`;
  } else {
    const dt = minutes(easy.time) - minutes(fastest.time);
    const saved = fastest.counts.maneuvers - easy.counts.maneuvers;
    const cost = dt <= 0 ? 'nello stesso tempo' : `con ${plural(dt, 'minuto', 'minuti')} in più`;
    summary = saved > 0
      ? `Easy ti porta a destinazione ${cost} e con ${plural(saved, 'manovra', 'manovre')} in meno.`
      : `Easy ti porta a destinazione ${cost} su strade più tranquille.`;
  }

  $('results').hidden = false;
  $('summary').textContent = summary;
  $('cards').innerHTML = same ? card('easy', easy, 'Easy · anche il più veloce') : card('easy', easy, 'Easy') + card('fast', fastest, 'Più veloce');
  for (const btn of $('cards').querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      state.selected = btn.dataset.kind;
      render(false);
    });
  }
}

const ICONS = {
  depart: '<circle cx="12" cy="12" r="5"/>',
  arrive: '<path d="M6 21V4h11l-2 4 2 4H6"/>',
  left: '<path d="M17 21v-8a3 3 0 0 0-3-3H6"/><path d="M10 6 6 10l4 4"/>',
  right: '<path d="M7 21v-8a3 3 0 0 1 3-3h8"/><path d="m14 6 4 4-4 4"/>',
  'slight-left': '<path d="M15 21v-6L8 8"/><path d="M8 13V8h5"/>',
  'slight-right': '<path d="M9 21v-6l7-7"/><path d="M11 8h5v5"/>',
  uturn: '<path d="M8 21V9a4 4 0 0 1 8 0v4"/><path d="m12 10 4 4 4-4"/>',
  roundabout: '<circle cx="12" cy="10" r="4"/><path d="M12 14v7"/><path d="M15 7l3-3"/>',
  straight: '<path d="M12 21V4"/><path d="m8 8 4-4 4 4"/>',
};

function renderSteps(r) {
  const list = $('steps');
  list.innerHTML = r.steps.map((s) => {
    const icon = ICONS[s.type === 'turn' || s.type === 'roundabout' || s.type === 'uturn' ? s.modifier : s.type] || ICONS.straight;
    const when = s.type === 'depart' ? '' : `<span class="step-dist">tra ${s.distance < 1000 ? `${Math.max(10, Math.round(s.distance / 10) * 10)} m` : km(s.distance)}</span>`;
    const flag = s.close ? '<span class="step-flag">ravvicinata</span>' : '';
    return `<li class="step step-${s.type}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>
      <span class="step-body">${when}<span class="step-text">${escapeHtml(s.text)}</span>${flag}</span>
    </li>`;
  }).join('');
  $('steps-title').textContent = r === state.choice.fastest && !state.choice.same ? 'Istruzioni · più veloce' : 'Istruzioni · Easy';
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawRoutes({ fastest, easy, same }, fit) {
  for (const l of state.layers) l.remove();
  state.layers = [];
  const selected = same || state.selected === 'easy' ? easy : fastest;
  const other = selected === easy ? fastest : easy;
  const color = (r) => cssVar(r === easy ? '--easy' : '--fast');

  if (!same) {
    state.layers.push(L.polyline(other.coords, { color: color(other), weight: 5, opacity: 0.55, dashArray: '2 9', lineCap: 'round' }).addTo(map));
  }
  state.layers.push(L.polyline(selected.coords, { color: cssVar('--route-casing'), weight: 10, opacity: 0.9 }).addTo(map));
  state.layers.push(L.polyline(selected.coords, { color: color(selected), weight: 6, opacity: 1 }).addTo(map));
  for (const s of selected.steps) {
    if (s.type === 'depart' || s.type === 'arrive') continue;
    state.layers.push(L.circleMarker(s.at, {
      radius: s.close ? 6 : 4.5, weight: 2.5, color: s.close ? cssVar('--alert') : color(selected),
      fillColor: cssVar('--surface'), fillOpacity: 1,
    }).addTo(map));
  }
  if (fit) {
    const bounds = L.latLngBounds([...fastest.coords, ...easy.coords]);
    const wide = window.matchMedia('(min-width: 760px)').matches;
    map.fitBounds(bounds, wide ? { paddingTopLeft: [40, 40], paddingBottomRight: [40, 40] } : { padding: [24, 24] });
  }
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.dataset.kind = kind;
  el.hidden = !text;
}

// ---------- Start with an example trip ----------

setPoint('from', EXAMPLE.from.latlng, EXAMPLE.from.label);
setPoint('to', EXAMPLE.to.latlng, EXAMPLE.to.label);
updateClickHint();
plan();
