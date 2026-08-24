// Saving a LARGE received file, exercised the way a user does it — in a real browser, against a real
// service worker. Files over INLINE_MAX are not blobs; their 保存 goes to /fileshare/dl/<id>, which only
// the service worker can answer. How the page ASKS for that URL decides whether the worker is consulted
// at all, and Chromium and WebKit disagree — so this asserts both Chromium download mechanisms:
//
//   <a download>  → Chromium hands it to the browser-process download manager, which never consults the
//                   service worker. The request reaches the origin server, 404s, and the download fails
//                   with "No file" on a transfer that plainly succeeded. This is the shipped bug.
//   top-level nav → runs through the worker; Content-Disposition: attachment makes it a download.
//
// Desktop Chromium normally takes the safer File System Access path; the navigation is its fallback on
// platforms without showSaveFilePicker. Usage: node test/fileshare-dl-click-e2e.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ROOT, launchBrowser } from './harness.mjs';

const PORT = 8208;
let srv, browser, failed = 0;
const ok = (c, m) => { console.log((c ? '  ok:   ' : '  FAIL: ') + m); if (!c) failed++; };
const done = () => {
  try { browser && browser.close(); } catch {}
  try { srv && srv.kill(); } catch {}
  console.log(failed ? `\nFAILED (${failed})` : '\nPASS');
  process.exit(failed ? 1 : 0);
};

srv = await new Promise((res) => {
  const s = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')],
    { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  s.stdout.on('data', (d) => { if (/listening/.test(d)) res(s); }); setTimeout(() => res(s), 2500);
});

browser = await launchBrowser();
const page = await browser.newPage();
// The hub is what registers /sw.js at scope / — the fileshare page relies on it.
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 90000 });
await page.goto(`http://localhost:${PORT}/fileshare/`, { waitUntil: 'domcontentloaded' });
ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'the service worker controls /fileshare/');

// stream a file just over INLINE_MAX into IndexedDB, exactly as a real reception does
const SIZE = await page.evaluate(async () => {
  const { FileSink, INLINE_MAX } = await import('/fileshare/recv-store.js');
  const size = INLINE_MAX + 15 * 1024 * 1024;                   // ~79 MB — the size reported failing
  for (const id of [515151, 626262]) {
    const sink = new FileSink({ id, name: 'video.mp4', size, mime: 'video/mp4' });
    let w = 0, roll = 0;
    while (w < size) {
      const n = Math.min(1024 * 1024, size - w);
      const u = new Uint8Array(n);
      for (let i = 0; i < n; i++) u[i] = (roll++) & 0xff;
      sink.push(u); w += n;
    }
    await sink.finish();
  }
  return size;
});

async function download(how, id) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsdl-'));
  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
  const settled = new Promise((res) => {
    client.on('Browser.downloadProgress', (e) => { if (e.state === 'completed' || e.state === 'canceled') res(e.state); });
    setTimeout(() => res('timeout'), 45000);
  });
  await page.evaluate((how, id) => {
    const url = new URL('dl/' + id, location.href).href;
    if (how === 'navigate') {
      location.replace(url);
    } else {
      const a = document.createElement('a'); a.href = url; a.download = 'video.mp4'; document.body.appendChild(a); a.click();
    }
  }, how, id);
  const state = await settled;
  const sizes = fs.readdirSync(dir).map((f) => fs.statSync(path.join(dir, f)).size);
  await client.detach();
  return { state, sizes };
}

const viaLink = await download('link', 515151);
ok(viaLink.state !== 'completed' || !viaLink.sizes.includes(SIZE),
  `<a download> does NOT reach the service worker in this browser (state=${viaLink.state}) — the bug this guards`);

const viaNavigation = await download('navigate', 626262);
ok(viaNavigation.state === 'completed', `a top-level navigation completes the download (state=${viaNavigation.state})`);
ok(viaNavigation.sizes.includes(SIZE), `and writes the whole ${SIZE}-byte file (${viaNavigation.sizes})`);

// the shipping code must be the one that works here
const src = fs.readFileSync(path.join(ROOT, 'fileshare', 'main.js'), 'utf8');
ok(/showSaveFilePicker/.test(src) && /res\.body\.pipeTo/.test(src), 'main.js streams desktop Chromium saves into a picked file');
ok(!/streamSave/.test(src) && !/createElement\(['"]iframe['"]\)/.test(src), 'main.js no longer uses the crash-prone hidden iframe');
ok(!/a\.href = 'dl\/' \+ id/.test(src), 'main.js no longer builds a page-relative dl/<id> href');

done();
