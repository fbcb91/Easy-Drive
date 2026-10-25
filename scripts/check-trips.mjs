// Replays saved trips with the current model and compares Easy with the
// route the driver would take. Usage: node scripts/check-trips.mjs [folder or files]
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { buildGraph } from '../src/graph.js';
import { planCandidates, planVia, choose, overlap } from '../src/planner.js';
import { TRIP_FORMAT } from '../src/trips.js';

const args = process.argv.slice(2);
const inputs = args.length ? args : ['trips'];
const files = [];
for (const input of inputs) {
  const info = await stat(input).catch(() => null);
  if (!info) continue;
  if (info.isDirectory()) {
    for (const f of (await readdir(input)).sort()) if (f.endsWith('.json')) files.push(join(input, f));
  } else files.push(input);
}
if (!files.length) {
  console.log('Nessun tragitto trovato. Metti i file salvati dalla app nella cartella trips/.');
  process.exit(0);
}

const min = (s) => (s / 60).toFixed(1);
const fmtBreakdown = (b) => Object.entries(b).filter(([, v]) => v > 0.05).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ');

for (const file of files) {
  const trip = JSON.parse(await readFile(file, 'utf8'));
  if (trip.format !== TRIP_FORMAT) continue;
  const graph = buildGraph(trip.osm);
  const { avoidRestricted, extraMinutes } = trip.settings;
  const candidates = planCandidates(graph, trip.from.latlng, trip.to.latlng, { avoidRestricted });
  const { easy, fastest } = choose(candidates, extraMinutes);
  console.log(`\n${trip.from.label} → ${trip.to.label}  (${file})`);
  if (trip.note) console.log(`  nota: ${trip.note}`);
  const row = (name, r) => console.log(`  ${name.padEnd(12)} ${min(r.time).padStart(5)} min  ${(r.distance / 1000).toFixed(1)} km  stress ${r.stress.toFixed(1).padStart(5)}  [${fmtBreakdown(r.breakdown)}]`);
  row('Più veloce', fastest);
  row('Easy', easy);
  if (trip.via?.length) {
    const mine = planVia(graph, [trip.from.latlng, ...trip.via, trip.to.latlng], { avoidRestricted });
    row('Il tuo', mine);
    const same = overlap(graph, easy, mine);
    const verdict = same > 0.9 ? 'Easy coincide con il tuo percorso'
      : mine.stress < easy.stress ? 'il modello trova il tuo percorso più semplice ma non l\'ha scelto: controllare la ricerca'
      : mine.time > fastest.time + extraMinutes * 60 ? 'il tuo percorso supera il tempo in più accettato'
      : 'il modello giudica il tuo percorso più stressante: da tarare';
    console.log(`  in comune con Easy: ${Math.round(same * 100)}% → ${verdict}`);
    for (const s of mine.steps) console.log(`    · ${s.text}`);
  }
}
