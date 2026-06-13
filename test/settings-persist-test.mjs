// E2E: settings durability + shared controls profile.
//  1) Boot ROM A, change a binding, verify it lands in localStorage and is
//     mirrored into the IndexedDB 'settings' store.
//  2) Wipe localStorage (simulating iOS purging it), reload, boot a
//     different ROM — the binding must be applied there too (restored from
//     the mirror and shared across games).
// Usage: node test/settings-persist-test.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROM_A = 'Emerald386CN_fixed.gba';
const ROM_B = 'LeafGreen386.gba';
const BINDING = 'LEFT_TOP_SHOULDER'; // test value for control 26 (change slot)
const PORT = 8124;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm',
  '.data': 'application/octet-stream', '.gba': 'application/octet-stream',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});

async function launchRom(page, rom) {
  await page.evaluate(async (r) => {
    const data = await (await fetch('/roms/' + r)).arrayBuffer();
    play({ name: r, data });
  }, rom);
  await page.waitForFunction('window.EJS_emulator && window.EJS_emulator.started === true',
    { timeout: 120000, polling: 500 });
  await sleep(2000); // let EJS_onGameStart hooks settle
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console.error]', m.text());
  });

  await page.goto(`http://localhost:${PORT}/games/gba/`, { waitUntil: 'load' });
  console.log('booting ROM A:', ROM_A);
  await launchRom(page, ROM_A);

  // Rebind control 26 the way the Control Settings UI does: mutate
  // controls, then saveSettings() (our wrapper mirrors it to IndexedDB).
  const written = await page.evaluate((binding) => {
    const em = window.EJS_emulator;
    em.controls[0][26].value2 = binding;
    em.saveSettings();
    const record = JSON.parse(localStorage.getItem(em.getLocalStorageKey()));
    return record.controlSettings[0][26].value2;
  }, BINDING);
  if (written !== BINDING) throw new Error('binding not in localStorage: ' + written);
  console.log('rebound control 26 ->', written);

  await sleep(1500); // async IndexedDB mirror
  const mirrored = await page.evaluate(() => new Promise((res) => {
    const req = indexedDB.open('gba-library');
    req.onsuccess = () => {
      const r = req.result.transaction('settings', 'readonly').objectStore('settings').getAll();
      r.onsuccess = () => res(r.result.map((row) => row.key));
    };
  }));
  console.log('mirrored settings rows:', mirrored);
  if (!mirrored.includes('__shared-controls__')) throw new Error('shared controls profile not mirrored');
  if (!mirrored.some((k) => k.includes('Emerald386CN_fixed'))) throw new Error('per-game record not mirrored');

  // Simulate iOS purging localStorage, then boot a different ROM.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  console.log('localStorage wiped + reloaded; booting ROM B:', ROM_B);
  await launchRom(page, ROM_B);

  const applied = await page.evaluate(() => {
    const c = window.EJS_emulator.controls[0][26];
    return c && c.value2;
  });
  console.log('ROM B control 26 ->', applied);
  if (applied !== BINDING) throw new Error('shared binding not applied to ROM B: ' + applied);

  // The purged per-game record of ROM A must be back in localStorage too.
  const restoredKeys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('ejs-')));
  console.log('restored localStorage keys:', restoredKeys);
  if (!restoredKeys.includes('ejs-1-gba-Emerald386CN_fixed-settings')) {
    throw new Error('ROM A settings record not restored after purge');
  }

  console.log('SETTINGS PERSIST PASS');
} finally {
  await browser.close();
  server.close();
}
