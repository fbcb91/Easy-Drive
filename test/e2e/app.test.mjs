// End-to-end check of the web page with OpenStreetMap services replaced by a synthetic city.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
    await page.route(/basemaps\.cartocdn\.com/, (r) => r.fulfill({ body: blankTile, contentType: 'image/png' }));
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

    if (process.env.SCREENSHOT_DIR) {
      await page.fill('#extra', '4');
      await page.click('.route-easy');
      await page.waitForTimeout(800); // let the map finish its zoom animation
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/desktop.png` });
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
