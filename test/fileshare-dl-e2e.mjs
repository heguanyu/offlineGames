// 文件共享助手 LARGE-file save, end-to-end in a REAL browser with a REAL service worker.
// Reproduces the production path a file over INLINE_MAX takes: FileSink streams it into IndexedDB,
// then the 保存 link fetches /fileshare/dl/<id>, which only the service worker can answer. The unit
// test (fileshare-recv-store-test.mjs) fakes IndexedDB and the worker scope, so it cannot see a
// registration/scope/version problem — this one can.
// Usage: node test/fileshare-dl-e2e.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, launchBrowser } from './harness.mjs';

const PORT = 8207;
let srv, browser;
const done = (c, m) => { console.log(m); try { browser && browser.close(); } catch {} try { srv && srv.kill(); } catch {} process.exit(c); };

function startServer() {
  const s = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')],
    { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res) => { s.stdout.on('data', (d) => { if (/listening/.test(d)) res(s); }); setTimeout(() => res(s), 2500); });
}

srv = await startServer();
browser = await launchBrowser();
const page = await browser.newPage();
page.on('console', (m) => { const t = m.text(); if (!/favicon/.test(t)) console.log('   [page]', t); });

// The hub is what registers /sw.js (scope /). The fileshare page does not register one.
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 90000 });
} catch { done(1, 'FAIL: the service worker never took control of the hub (install failed?)'); }
const swName = await page.evaluate(() => new Promise((r) => {
  const ch = new MessageChannel(); ch.port1.onmessage = (e) => r(e.data);
  navigator.serviceWorker.controller.postMessage('version', [ch.port2]);
  setTimeout(() => r('(no answer)'), 3000);
}));
console.log('  service worker in control:', swName);

await page.goto(`http://localhost:${PORT}/fileshare/`, { waitUntil: 'domcontentloaded' });
const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
console.log('  /fileshare/ controlled by it:', controlled);

const r = await page.evaluate(async () => {
  const { FileSink, INLINE_MAX } = await import('/fileshare/recv-store.js');
  const SIZE = INLINE_MAX + 15 * 1024 * 1024;      // ~79 MB, the size that fails in production
  const id = 424242;
  const sink = new FileSink({ id, name: '视频.mp4', size: SIZE, mime: 'video/mp4' });
  const CH = 1024 * 1024;
  let w = 0, roll = 0;
  while (w < SIZE) {
    const n = Math.min(CH, SIZE - w);
    const u = new Uint8Array(n);
    for (let i = 0; i < n; i++) u[i] = (roll++) & 0xff;
    sink.push(u); w += n;
  }
  let finishErr = null;
  try { await sink.finish(); } catch (e) { finishErr = String(e && e.message || e); }

  // exactly what the 保存 link does
  const res = await fetch('dl/' + id);
  const body = res.ok ? await res.arrayBuffer() : null;
  return {
    finishErr, size: SIZE, status: res.status,
    url: new URL('dl/' + id, location.href).href,
    contentLength: res.headers.get('content-length'),
    got: body ? body.byteLength : 0,
    servedBy: res.headers.get('content-disposition') ? 'service worker' : 'network/other',
  };
});

console.log('  href resolves to :', r.url);
console.log('  sink.finish()    :', r.finishErr ? 'REJECTED — ' + r.finishErr : 'ok (row shows 已接收 + 保存 link)');
console.log('  GET dl/<id>      :', r.status, '| served by:', r.servedBy);
console.log('  bytes            :', r.got, 'of', r.size, '| content-length:', r.contentLength);

if (r.status === 404) done(1, `\nREPRODUCED: dl/<id> returned 404 — this is the "Download failed – No file" the user sees.`);
if (r.got !== r.size) done(1, `\nFAIL: short body (${r.got} of ${r.size})`);
done(0, '\nPASS: the large-file save works in a real browser');
