// Reproduces/verifies the rotation bug: after an orientation (viewport)
// change, does the emulator canvas still fill the screen?
// Usage: node test/rotate-test.mjs [system] [rom-name]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const SYSTEM = process.argv[2] || 'gba';
const ROM = process.argv[3] || 'Emerald386CN.gba';
const PORT = 8128;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.data': 'application/octet-stream', '.gba': 'application/octet-stream', '.nds': 'application/octet-stream', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--enable-unsafe-swiftshader', '--mute-audio'] });

function measure() {
  const c = document.querySelector('#game canvas');
  const cr = c ? c.getBoundingClientRect() : null;
  return {
    win: [innerWidth, innerHeight],
    canvasCss: cr ? [Math.round(cr.width), Math.round(cr.height)] : null,
    canvasTop: cr ? Math.round(cr.top) : null,
    // Fraction of viewport height the canvas covers.
    coverage: cr ? +(cr.height / innerHeight).toFixed(2) : null,
  };
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 }); // landscape
  await page.goto(`http://localhost:${PORT}/games/${SYSTEM}/`, { waitUntil: 'load' });
  await page.evaluate(async (rom) => {
    const data = await (await fetch('/roms/' + rom)).arrayBuffer();
    play({ name: rom, data });
  }, ROM);
  await page.waitForFunction('window.EJS_emulator && window.EJS_emulator.started === true', { timeout: 120000, polling: 500 });
  await sleep(3000);
  console.log('landscape:', JSON.stringify(await page.evaluate(measure)));

  // Rotate to portrait.
  await page.setViewport({ width: 768, height: 1024 });
  await sleep(1500);
  console.log('portrait :', JSON.stringify(await page.evaluate(measure)));

  // Rotate back to landscape.
  await page.setViewport({ width: 1024, height: 768 });
  await sleep(1500);
  const back = await page.evaluate(measure);
  console.log('landscape:', JSON.stringify(back));

  // After settling, the canvas should cover ~the full viewport height.
  console.log(back.coverage >= 0.9 ? 'ROTATE OK' : 'ROTATE BROKEN (canvas does not fill screen)');
} finally {
  await browser.close();
  server.close();
}
