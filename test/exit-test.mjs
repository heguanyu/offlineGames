// Verifies that exiting the emulator returns to the ROM library view.
// Usage: node test/exit-test.mjs [system] [rom-name]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const SYSTEM = process.argv[2] || 'gba';
const ROM = process.argv[3] || 'Emerald386CN.gba';
const PORT = 8127;
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
try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/games/${SYSTEM}/`, { waitUntil: 'load' });
  await page.evaluate(async (rom) => {
    const data = await (await fetch('/roms/' + rom)).arrayBuffer();
    play({ name: rom, data });
  }, ROM);
  await page.waitForFunction('window.EJS_emulator && window.EJS_emulator.started === true', { timeout: 120000, polling: 500 });
  await sleep(3000);

  const gameVisibleBefore = await page.$eval('#game-wrap', (el) => !el.hidden);
  console.log('in-game (game-wrap visible):', gameVisibleBefore);

  // Trigger the same event EmulatorJS's exit button fires.
  await page.evaluate(() => window.EJS_emulator.callEvent('exit'));

  // Our handler reloads the page; wait for it, then confirm the library is back.
  await page.waitForNavigation({ waitUntil: 'load', timeout: 15000 });
  await sleep(500);
  const libraryVisible = await page.$eval('#library', (el) => !el.hidden);
  const gameVisibleAfter = await page.$eval('#game-wrap', (el) => !el.hidden);
  console.log('after exit -> library visible:', libraryVisible, '| game-wrap visible:', gameVisibleAfter);

  if (libraryVisible && !gameVisibleAfter) {
    console.log('EXIT TEST PASS');
  } else {
    throw new Error('did not return to library view after exit');
  }
} finally {
  await browser.close();
  server.close();
}
