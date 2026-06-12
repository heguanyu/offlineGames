// Drives Pokémon Emerald from boot to an actual in-game save via scripted
// inputs, then inspects the result. Used to diagnose/verify the "save
// failed" issue with ROM hacks. Pass --nightly to swap in the nightly mGBA
// core (test/fixtures/mgba-wasm-nightly.data) instead of the shipped one.
// Usage: node test/ingame-save-test.mjs [--nightly]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const NIGHTLY = process.argv.includes('--nightly');
const ROM = process.argv.find((a) => a.endsWith('.gba')) || 'Emerald386CN.gba';
const PORT = 8126;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ingame');
fs.mkdirSync(outDir, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.data': 'application/octet-stream', '.gba': 'application/octet-stream', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(root, urlPath);
  if (NIGHTLY && urlPath.endsWith('/cores/mgba-wasm.data')) {
    file = path.join(root, 'test', 'fixtures', 'mgba-wasm-nightly.data');
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--enable-unsafe-swiftshader', '--mute-audio'] });

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  page.on('console', (m) => console.log(`[console.${m.type()}]`, m.text().slice(0, 300)));
  await page.goto(`http://localhost:${PORT}/games/gba/`, { waitUntil: 'load' });
  await page.evaluate(async (rom) => {
    const data = await (await fetch('/roms/' + rom)).arrayBuffer();
    play({ name: rom, data });
  }, ROM);
  await page.waitForFunction('window.EJS_emulator && window.EJS_emulator.started === true', { timeout: 120000, polling: 500 });
  console.log('emulator started', NIGHTLY ? '(NIGHTLY core)' : '(shipped core)');

  // Crank fast-forward so the long intro takes seconds, not minutes.
  await page.evaluate(() => {
    const gm = window.EJS_emulator.gameManager;
    gm.setFastForwardRatio(10);
    gm.toggleFastForward(1);
  });

  const canvas = await page.$('#game canvas');
  const shot = async (name) => {
    await canvas.screenshot({ path: path.join(outDir, name + '.png') });
    console.log('shot:', name);
  };
  const tap = async (key, hold = 70) => {
    await page.keyboard.down(key);
    await sleep(hold);
    await page.keyboard.up(key);
    await sleep(130);
  };
  const mash = async (key, n, gap = 200) => {
    for (let i = 0; i < n; i++) { await tap(key); await sleep(gap); }
  };
  const holdKey = async (key, ms) => {
    await page.keyboard.down(key);
    await sleep(ms);
    await page.keyboard.up(key);
    await sleep(150);
  };

  const statePath = path.join(root, 'test', 'fixtures', ROM + '.state');
  if (fs.existsSync(statePath)) {
    // Resume from the in-game fixture state, skipping the whole intro.
    const state = Array.from(fs.readFileSync(statePath));
    await page.evaluate((arr) => {
      window.EJS_emulator.gameManager.loadState(new Uint8Array(arr));
    }, state);
    await sleep(2000);
    await shot('t6-resumed');
  } else {
    await sleep(9000); // boot logos -> title
    await shot('t1-title');
    await tap('Enter');
    await sleep(2500);
    await shot('t2-intro');

    await mash('z', 45); // Birch speech + gender select
    await shot('t3-after-birch');

    // Naming screen: type one character, START jumps to OK, A confirms, A = yes.
    await tap('z'); await tap('Enter'); await tap('z');
    await sleep(800);
    await tap('z');
    await sleep(800);
    await shot('t4-after-naming');

    await mash('z', 25); // closing speech -> truck
    await shot('t5-truck');

    await holdKey('ArrowDown', 2500); // walk toward the truck exit
    await mash('z', 35); // any remaining dialogs
    await mash('x', 4, 120); // close anything left open
    await shot('t6-ingame');

    // Save an emulator state fixture so future runs skip the intro.
    const state = await page.evaluate(() => Array.from(window.EJS_emulator.gameManager.getState()));
    fs.writeFileSync(statePath, Buffer.from(state));
    console.log('fixture state saved:', statePath);
  }

  // In-game save: ensure the START menu is closed, open it fresh (cursor on
  // top item = Bag), go down 2 to Save (menu: Bag / Trainer / Save / Options
  // / Close), confirm twice.
  await mash('x', 3, 120);
  await tap('Enter'); await sleep(900);
  await shot('t7a-menu-open');
  await tap('ArrowDown'); await tap('ArrowDown');
  await shot('t7b-on-save');
  await tap('z'); await sleep(1500); // open save screen
  await shot('t7c-save-screen');
  await tap('z'); await sleep(9000); // YES -> save attempt runs
  await shot('t7d-save-result');
  // The "save failed, checking backup memory (~1 min)" flow ends with a
  // retry prompt; ride it out and answer any prompts with A.
  for (let i = 1; i <= 6; i++) {
    await sleep(10000);
    await mash('z', 3, 200);
    await shot(`t7e-check-${i}`);
    const nonFF = await page.evaluate(() => {
      const gm = window.EJS_emulator.gameManager;
      gm.saveSaveFiles();
      const data = gm.FS.readFile(gm.getSaveFilePath());
      let n = 0;
      for (let j = 0; j < data.length; j++) if (data[j] !== 0xFF) n++;
      return n;
    });
    console.log(`check ${i}: non-FF bytes in save = ${nonFF}`);
  }

  const saveInfo = await page.evaluate(() => {
    const gm = window.EJS_emulator.gameManager;
    gm.saveSaveFiles();
    const p = gm.getSaveFilePath();
    try {
      const data = gm.FS.readFile(p);
      let nonFF = 0;
      for (let i = 0; i < data.length; i++) if (data[i] !== 0xFF) nonFF++;
      const head = Array.from(data.slice(0, 16)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      return { path: p, size: data.length, nonFF, head };
    } catch (e) {
      return { path: p, error: e.message };
    }
  });
  console.log('save file after attempts:', JSON.stringify(saveInfo));
  await shot('t8-final');
} finally {
  await browser.close();
  server.close();
}
