// Browser UI: map, search, route comparison and turn-by-turn list.
/* global L */

import { buildGraph } from './graph.js';
import { planCandidates, planVia, choose, overlap, PlanError } from './planner.js';
import { fetchRoads, tripBBox, MAX_TRIP_M } from './osm.js';
import { bboxContains, distance, expandBBox } from './geo.js';
import { makeTrip, tripFileName } from './trips.js';

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
  'via-off-road': 'Una tappa è lontana da strade percorribili in auto. Spostala su una strada.',
  'via-outside': 'Questa tappa è fuori dalla zona scaricata. Mettila più vicino al tragitto.',
  network: 'Non riesco a scaricare le strade da OpenStreetMap. Il servizio potrebbe essere occupato: riprova tra qualche secondo.',
};

const $ = (id) => document.getElementById(id);
const state = {
  points: { from: null, to: null },
  markers: { from: null, to: null },
  nextClick: 'from',
  drawing: false, // true while the driver is adding waypoints for their own route
  via: [], // [{ latlng, marker }]
  mine: null,
  cache: null, // { bbox, graph, osm }
  graph: null,
  candidates: null,
  choice: null,
  selected: 'easy',
  layers: [],
  busy: false,
  pending: false,
};

// ---------- Map ----------

const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView(TORINO.center, 13);
L.control.zoom({ position: 'topright' }).addTo(map);

// Standard OpenStreetMap tiles; css/style.css tones them down and darkens them in dark mode.
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

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
  if (state.drawing) {
    addVia(latlng);
    return;
  }
  const kind = state.nextClick;
  setPoint(kind, latlng, coordLabel(latlng));
  reverseLabel(kind, latlng);
  state.nextClick = kind === 'from' ? 'to' : 'from';
  updateClickHint();
  if (state.points.from && state.points.to) plan();
});

function updateClickHint() {
  $('click-hint').textContent = state.drawing
    ? 'Tocca la mappa sulle vie che prenderesti tu per aggiungere una tappa.'
    : state.nextClick === 'from'
      ? 'Tocca la mappa per scegliere la partenza.'
      : "Tocca la mappa per scegliere l'arrivo.";
}

// ---------- The driver's own route (waypoints) ----------

function viaIcon(n) {
  return L.divIcon({ className: '', html: `<span class="pin pin-via">${n}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] });
}

// New waypoints go where they lengthen the route least, so the order of taps doesn't matter.
function addVia(latlng) {
  if (!state.cache || !bboxContains(state.cache.bbox, [latlng[0], latlng[1], latlng[0], latlng[1]])) {
    setStatus(ERRORS['via-outside'], 'error');
    return;
  }
  const chain = [state.points.from.latlng, ...state.via.map((v) => v.latlng), state.points.to.latlng];
  let best = 0;
  let bestCost = Infinity;
  for (let i = 0; i < chain.length - 1; i++) {
    const cost = distance(chain[i], latlng) + distance(latlng, chain[i + 1]) - distance(chain[i], chain[i + 1]);
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  const via = { latlng, marker: null };
  via.marker = L.marker(latlng, { draggable: true, keyboard: false, icon: viaIcon(0) }).addTo(map);
  via.marker.on('dragend', () => {
    const p = via.marker.getLatLng();
    via.latlng = [p.lat, p.lng];
    planMine();
  });
  via.marker.on('click', () => removeVia(via));
  state.via.splice(best, 0, via);
  planMine();
}

function removeVia(via) {
  via.marker.remove();
  state.via = state.via.filter((v) => v !== via);
  planMine();
}

function clearVia() {
  for (const v of state.via) v.marker.remove();
  state.via = [];
  planMine();
}

function planMine({ quiet = false } = {}) {
  state.via.forEach((v, i) => v.marker.setIcon(viaIcon(i + 1)));
  $('mine-clear').hidden = !state.via.length;
  if (!state.drawing) setDrawing(false);
  if (!state.via.length || !state.graph) {
    state.mine = null;
    if (state.selected === 'mine') state.selected = 'easy';
  } else {
    try {
      const { from, to } = state.points;
      state.mine = planVia(state.graph, [from.latlng, ...state.via.map((v) => v.latlng), to.latlng], { avoidRestricted: $('avoid-ztl').checked });
      if (!quiet) state.selected = 'mine';
      if (!quiet) setStatus('');
    } catch (err) {
      state.mine = null;
      setStatus(ERRORS[err.code] || ERRORS['no-route'], 'error');
    }
  }
  if (state.candidates) render(false);
}

function setDrawing(on) {
  state.drawing = on;
  $('mine-toggle').textContent = on ? 'Fine' : state.via.length ? 'Modifica il mio percorso' : 'Traccia il mio percorso';
  $('mine-toggle').setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('is-drawing', on);
  updateClickHint();
}

$('mine-toggle').addEventListener('click', () => setDrawing(!state.drawing));
$('mine-clear').addEventListener('click', () => clearVia());

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
  if (!from || !to) return;
  if (state.busy) {
    // A point changed while computing: run again with the new points afterwards.
    state.pending = true;
    return;
  }
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
      state.cache = { bbox: osm.bbox, graph: buildGraph(osm), osm };
    }
    setStatus('Confronto i percorsi…', 'busy');
    await tick();
    state.graph = state.cache.graph;
    state.candidates = planCandidates(state.graph, from.latlng, to.latlng, { avoidRestricted: $('avoid-ztl').checked });
    state.selected = 'easy';
    setStatus('');
    planMine({ quiet: true });
    render(true);
  } catch (err) {
    const code = err instanceof PlanError ? err.code : 'network';
    setStatus(ERRORS[code] || ERRORS.network, 'error');
    console.error(err);
  } finally {
    state.busy = false;
    $('plan').disabled = false;
  }
  if (state.pending) {
    state.pending = false;
    plan();
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
  if (choice.same && state.selected === 'fast') state.selected = 'easy';
  renderCards(choice);
  renderWhy(choice);
  renderVerdict(choice);
  renderSteps(selectedRoute());
  drawRoutes(choice, fit);
}

function selectedRoute() {
  const { easy, fastest } = state.choice;
  if (state.selected === 'mine' && state.mine) return state.mine;
  return state.selected === 'fast' ? fastest : easy;
}

function minutes(s) {
  return Math.max(1, Math.round(s / 60));
}

function km(m) {
  return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

function decimal(n) {
  return n.toFixed(1).replace('.', ',');
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function stat(n, one, many) {
  return `<strong>${n}</strong> ${n === 1 ? one : many}`;
}

const TITLES = { easy: 'Easy', fast: 'Più veloce', mine: 'Il tuo' };

function renderCards({ fastest, easy, same }) {
  const card = (kind, r, title) => `
    <button type="button" class="route-card route-${kind}${state.selected === kind ? ' is-selected' : ''}" data-kind="${kind}" aria-pressed="${state.selected === kind}">
      <span class="route-title">${title}</span>
      <span class="route-time"><strong>${minutes(r.time)}</strong> min</span>
      <span class="route-meta">${km(r.distance)} · stress ${decimal(r.stress)}</span>
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
  let html = same ? card('easy', easy, 'Easy · anche il più veloce') : card('easy', easy, 'Easy') + card('fast', fastest, 'Più veloce');
  if (state.mine) html += card('mine', state.mine, 'Il tuo percorso');
  $('cards').innerHTML = html;
  for (const btn of $('cards').querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      state.selected = btn.dataset.kind;
      render(false);
    });
  }
}

// Stress categories, in the words a driver would use.
const CAUSES = {
  maneuver: { label: 'manovre', unit: (r) => r.counts.maneuvers },
  left: { label: 'svolte a sinistra', unit: (r) => r.counts.left },
  major: { label: 'immissioni senza semaforo', unit: (r) => r.counts.major },
  close: { label: 'manovre ravvicinate', unit: (r) => r.counts.close },
  narrow: { label: 'tratti su vie piccole', unit: (r) => `${decimal(r.counts.narrowKm)} km` },
};

function topCauses(worse, better) {
  return Object.keys(CAUSES)
    .map((k) => ({ k, diff: worse.breakdown[k] - better.breakdown[k] }))
    .filter((c) => c.diff > 0.2)
    .sort((a, b) => b.diff - a.diff)
    .slice(0, 2)
    .map((c) => CAUSES[c.k].label);
}

function renderWhy({ fastest, easy, same }) {
  const routes = [['easy', easy]];
  if (!same) routes.push(['fast', fastest]);
  if (state.mine) routes.push(['mine', state.mine]);
  const rows = [
    ['Tempo', (r) => minutes(r.time), (r) => `${minutes(r.time)} min`],
    ['Manovre', (r) => r.counts.maneuvers],
    ['Svolte a sinistra', (r) => r.counts.left],
    ['Immissioni senza semaforo', (r) => r.counts.major],
    ['Manovre ravvicinate', (r) => r.counts.close],
    ['Km su vie piccole', (r) => r.counts.narrowKm, (r) => decimal(r.counts.narrowKm)],
    ['Semafori', (r) => r.signals],
    ['Punti stress', (r) => r.stress, (r) => decimal(r.stress)],
  ];
  const head = `<tr><th scope="col"></th>${routes.map(([k]) => `<th scope="col" class="col-${k}">${TITLES[k]}</th>`).join('')}</tr>`;
  const body = rows.map(([label, value, show = value]) => {
    const best = Math.min(...routes.map(([, r]) => value(r)));
    const cells = routes.map(([, r]) => {
      const isBest = routes.length > 1 && Math.abs(value(r) - best) < 1e-9;
      return `<td${isBest ? ' class="is-best"' : ''}>${show(r)}</td>`;
    }).join('');
    return `<tr${label === 'Punti stress' ? ' class="total"' : ''}><th scope="row">${label}</th>${cells}</tr>`;
  }).join('');
  $('why-table').innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;

  const causes = same ? [] : topCauses(fastest, easy);
  $('why-text').textContent = causes.length
    ? `Rispetto al più veloce, Easy toglie stress soprattutto su: ${causes.join(' e ')}. Un punto stress vale più o meno una svolta normale.`
    : 'Un punto stress vale più o meno una svolta normale. Le svolte a sinistra, le immissioni senza semaforo e le manovre ravvicinate pesano di più.';
}

function renderVerdict({ easy, fastest }) {
  const el = $('mine-verdict');
  const mine = state.mine;
  el.hidden = !mine;
  if (!mine) return;
  const budget = fastest.time + Number($('extra').value) * 60;
  const shared = overlap(state.graph, easy, mine);
  let text;
  if (shared > 0.9) {
    text = 'Easy fa già la tua stessa strada.';
  } else if (mine.stress < easy.stress - 0.05 && mine.time <= budget) {
    text = `Secondo il modello il tuo percorso è più semplice di Easy (stress ${decimal(mine.stress)} contro ${decimal(easy.stress)}), ma la ricerca non l'ha trovato. Salva il tragitto: è un caso da correggere.`;
  } else if (mine.time > budget) {
    const extra = minutes(mine.time) - minutes(fastest.time);
    text = `Il tuo percorso richiede ${plural(extra, 'minuto', 'minuti')} in più del più veloce, oltre il tempo che accetti. Sposta il cursore per confrontarlo alla pari.`;
  } else {
    const causes = topCauses(mine, easy);
    text = `Per il modello il tuo percorso è più stressante (${decimal(mine.stress)} contro ${decimal(easy.stress)})${causes.length ? `, soprattutto per ${causes.join(' e ')}` : ''}. Se per te è più tranquillo, salva il tragitto: serve proprio a tarare l'app.`;
  }
  el.textContent = text;
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
  const kind = state.selected === 'mine' && state.mine ? 'mine' : state.selected === 'fast' && !state.choice.same ? 'fast' : 'easy';
  $('steps-title').textContent = `Istruzioni · ${{ easy: 'Easy', fast: 'più veloce', mine: 'il tuo percorso' }[kind]}`;
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
  const routes = [['easy', easy, '--easy']];
  if (!same) routes.push(['fast', fastest, '--fast']);
  if (state.mine) routes.push(['mine', state.mine, '--mine']);
  const selected = selectedRoute();

  for (const [, r, color] of routes) {
    if (r === selected) continue;
    state.layers.push(L.polyline(r.coords, { color: cssVar(color), weight: 5, opacity: 0.6, dashArray: '2 9', lineCap: 'round' }).addTo(map));
  }
  const color = cssVar(routes.find(([, r]) => r === selected)[2]);
  state.layers.push(L.polyline(selected.coords, { color: cssVar('--route-casing'), weight: 10, opacity: 0.9 }).addTo(map));
  state.layers.push(L.polyline(selected.coords, { color, weight: 6, opacity: 1 }).addTo(map));
  for (const s of selected.steps) {
    if (s.type === 'depart' || s.type === 'arrive') continue;
    state.layers.push(L.circleMarker(s.at, {
      radius: s.close ? 6 : 4.5, weight: 2.5, color: s.close ? cssVar('--alert') : color,
      fillColor: cssVar('--surface'), fillOpacity: 1,
    }).addTo(map));
  }
  if (fit) {
    const bounds = L.latLngBounds(routes.flatMap(([, r]) => r.coords));
    const wide = window.matchMedia('(min-width: 760px)').matches;
    map.fitBounds(bounds, wide ? { paddingTopLeft: [40, 40], paddingBottomRight: [40, 40] } : { padding: [24, 24] });
  }
}

// ---------- Save a trip for tuning ----------

$('save-trip').addEventListener('click', () => {
  if (!state.choice) return;
  const trip = makeTrip({
    from: state.points.from,
    to: state.points.to,
    via: state.via.map((v) => v.latlng),
    note: $('save-note').value.trim(),
    extraMinutes: Number($('extra').value),
    avoidRestricted: $('avoid-ztl').checked,
    osm: state.cache.osm,
    easy: state.choice.easy,
    fastest: state.choice.fastest,
    mine: state.mine,
  });
  const name = tripFileName(trip);
  const url = URL.createObjectURL(new Blob([JSON.stringify(trip)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`Ho salvato ${name} nella cartella Download.${state.via.length ? '' : ' Per tarare l\'app è più utile con il tuo percorso tracciato.'}`, 'ok');
});

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
