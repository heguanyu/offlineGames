// Shared test harness for the browser-based mahjong tests: a static file server
// with the right MIME types (notably image/svg+xml for the tile faces) and a
// headless Edge/puppeteer browser configured for offline WebGL via SwiftShader.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

// Start a static server rooted at the project dir; resolves once it's listening.
export function startServer(port) {
  const server = http.createServer((req, res) => {
    let file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

export async function launchBrowser(extraArgs = []) {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    // --mute-audio silences the browser's WebAudio output; the localStorage seed below
    // also mutes the game's Sound class (incl. TTS voices) so test runs are SILENT.
    args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-webgl', '--mute-audio', ...extraArgs],
  });
  // Seed the mute preference before any page script runs, on every navigation, so the
  // Sound constructor reads muted=1 (no SFX, no spoken voices) during tests.
  const orig = browser.newPage.bind(browser);
  browser.newPage = async () => {
    const page = await orig();
    try { await page.evaluateOnNewDocument(() => { try { localStorage.setItem('mahjong-muted', '1'); } catch {} }); } catch {}
    return page;
  };
  return browser;
}
