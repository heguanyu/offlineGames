// Diagnostic: boots a ROM and dumps what the core detected for saving —
// core options, save file path, and the save file size after a forced flush
// (Emerald needs a 131072-byte flash save; smaller means wrong save type).
// Usage: node test/save-probe.mjs [system] [rom-name]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const SYSTEM = process.argv[2] || 'gba';
const ROM = process.argv[3] || 'Emerald386CN.gba';
const PORT = 8125;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.data': 'application/octet-stream', '.gba': 'application/octet-stream', '.wasm': 'application/wasm' };
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
  await sleep(4000);

  const info = await page.evaluate(() => {
    const emu = window.EJS_emulator;
    const gm = emu.gameManager;
    gm.saveSaveFiles();
    const savePath = gm.getSaveFilePath();
    let saveSize = null;
    try { saveSize = gm.FS.stat(savePath).size; } catch (e) { saveSize = 'missing: ' + e.message; }
    let savesDir = [];
    try { savesDir = gm.FS.readdir('/data/saves'); } catch (e) {}
    return {
      coreName: emu.coreName,
      saveFileExt: emu.saveFileExt,
      savePath,
      saveSize,
      savesDir,
      coreOptions: emu.defaultCoreOpts,
      retroarchOpts: emu.retroarchOpts,
    };
  });
  console.log(JSON.stringify(info, null, 2));
} finally {
  await browser.close();
  server.close();
}
