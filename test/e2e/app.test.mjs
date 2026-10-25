// End-to-end check of the web page with OpenStreetMap services replaced by a synthetic city.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { startServer } from '../../scripts/serve.mjs';
import { zigzagCity, toLatLon } from '../fixtures.js';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  // Playwright not installed: the test is skipped.
}

test('the page compares Easy and fastest routes', { skip: !chromium && 'playwright not installed' }, async () => {
  const server = await startServer(0);
  const { port } = server.address();
  const browser = await chromium.launch();
  // acceptDownloads is on by default for new pages.
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const places = { 'Piazza Statuto': [0, 0], 'Piazza Vittorio': [600, 600] };
    await page.route(/overpass/, (r) => r.fulfill({ json: zigzagCity() }));
    await page.route(/nominatim\.openstreetmap\.org\/search/, (r) => {
      const q = new URL(r.request().url()).searchParams.get('q');
      const [lat, lon] = toLatLon(places[q]);
      r.fulfill({ json: [{ lat: String(lat), lon: String(lon), name: q, address: {}, display_name: q }] });
    });
    await page.route(/nominatim\.openstreetmap\.org\/reverse/, (r) => r.fulfill({ json: {} }));
    const blankTile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
    await page.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ body: blankTile, contentType: 'image/png' }));
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());

    await page.goto(`http://localhost:${port}/`);
    // The example trip is outside the synthetic city, so it must fail gracefully.
    await page.waitForSelector('#status[data-kind="error"]');

    await page.fill('#from-input', 'Piazza Statuto');
    await page.press('#from-input', 'Enter');
    await page.waitForFunction(() => document.querySelector('#from-input').value === 'Piazza Statuto');
    await page.fill('#to-input', 'Piazza Vittorio');
    await page.press('#to-input', 'Enter');
    await page.waitForSelector('#results:not([hidden]) .route-card');

    const cards = await page.$$eval('.route-card', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')));
    assert.equal(cards.length, 2);
    assert.match(cards[0], /^EASY .* 1 manovra 1 svolta a sinistra/i);
    assert.match(cards[1], /^PIÙ VELOCE .* 11 manovre/i);
    assert.match(await page.textContent('#summary'), /10 manovre in meno/);
    const steps = await page.$$eval('.step-text', (els) => els.map((e) => e.textContent));
    assert.deepEqual(steps, ['Parti verso est su Corso Francia', 'Svolta a sinistra in Corso Regina Margherita', 'Sei arrivato a destinazione']);

    await page.click('.route-fast');
    assert.equal(await page.textContent('#steps-title'), 'Istruzioni · più veloce');

    // With no extra time allowed, only the fastest route remains.
    await page.fill('#extra', '0');
    assert.equal(await page.locator('.route-card').count(), 1);

    await page.fill('#extra', '4');
    await page.waitForTimeout(800); // let the map finish its zoom animation

    // Trace the driver's own route through the zig-zag with one waypoint.
    await page.click('#mine-toggle');
    const a = await page.locator('.leaflet-marker-pane .pin-from').boundingBox();
    const b = await page.locator('.leaflet-marker-pane .pin-to').boundingBox();
    await page.mouse.click((a.x + b.x) / 2 + a.width / 2, (a.y + b.y) / 2 + a.height / 2);
    await page.waitForSelector('.route-mine');
    assert.match(await page.textContent('.route-mine'), /11\s*manovre/);
    assert.match(await page.textContent('#mine-verdict'), /più stressante .* soprattutto per manovre e manovre ravvicinate/);
    assert.equal(await page.textContent('#steps-title'), 'Istruzioni · il tuo percorso');
    assert.equal(await page.locator('#why-table thead th').count(), 4);
    await page.click('#mine-toggle');

    // Saving downloads a trip file with the driver's route and the road data.
    await page.fill('#save-note', 'Preferisco i vicoli');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#save-trip')]);
    assert.equal(download.suggestedFilename(), 'tragitto-piazza-statuto--piazza-vittorio.json');
    const trip = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(trip.note, 'Preferisco i vicoli');
    assert.equal(trip.via.length, 1);
    assert.equal(trip.results.mine.counts.maneuvers, 11);
    assert.ok(trip.osm.elements.length > 20);

    if (process.env.SCREENSHOT_DIR) {
      await page.click('.route-easy');
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/desktop.png` });
      await page.locator('#why-title').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/desktop-why.png` });
      await page.setViewportSize({ width: 400, height: 860 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/phone.png` });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
