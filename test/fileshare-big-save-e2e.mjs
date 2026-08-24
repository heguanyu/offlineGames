// The reported crash, end to end: pair two real pages, send a file just over INLINE_MAX so it takes
// the IndexedDB + service-worker save path, then click the REAL 保存 element the receiver built and
// stream it into a real FileSystemWritableFileStream — or detect a hung/crashed page.
// Usage: node test/fileshare-big-save-e2e.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { ROOT, launchBrowser } from './harness.mjs';

const PORT = 8211;
let srv, browser;
const done = (c, m) => { console.log(m); try { browser && browser.close(); } catch {} try { srv && srv.kill(); } catch {} process.exit(c); };
const fail = (m) => done(1, '\nFAIL: ' + m);

srv = await new Promise((res) => {
  const s = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')],
    { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  s.stdout.on('data', (d) => { if (/listening/.test(d)) res(s); }); setTimeout(() => res(s), 2500);
});
const url = `http://localhost:${PORT}/fileshare/?server=ws://localhost:${PORT}`;

browser = await launchBrowser(['--disable-features=WebRtcHideLocalIpsWithMdns']);

// register the worker first (the hub does this), then open the two fileshare pages
const boot = await browser.newPage();
await boot.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
await boot.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 90000 });
await boot.close();

const host = await browser.newPage();
const guest = await browser.newPage();
// Native save dialogs cannot be automated. Back showSaveFilePicker with the browser's origin-private
// file system instead; it returns the same FileSystemFileHandle/createWritable API and performs a real
// streamed file write without opening a dialog.
await guest.evaluateOnNewDocument(() => {
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: async () => (await navigator.storage.getDirectory()).getFileHandle('__fileshare_big_save__', { create: true }),
  });
});
let crashed = null;
for (const [n, p] of [['host', host], ['guest', guest]]) {
  p.on('error', (e) => { crashed = `${n} page CRASHED: ${e.message}`; });
  p.on('pageerror', (e) => console.log(`  [${n} pageerror]`, e.message));
}
await host.goto(url, { waitUntil: 'load' });
await guest.goto(url, { waitUntil: 'load' });
console.log('  guest controlled by SW:', await guest.evaluate(() => !!navigator.serviceWorker.controller));

await host.evaluate(() => document.getElementById('btn-host').click());
await host.waitForFunction(() => document.getElementById('code-display').textContent.replace(/[^A-Z0-9]/g, '').length === 9, { timeout: 8000, polling: 250 });
const code = await host.evaluate(() => document.getElementById('code-display').textContent.replace(/[^A-Z0-9]/g, ''));
await guest.click('#btn-code');
await guest.waitForSelector('#view-code:not([hidden]) .code-input input', { timeout: 5000 });
await guest.evaluate((c) => {
  [...document.querySelectorAll('#code-input input')].forEach((b, i) => { b.value = c[i]; b.dispatchEvent(new Event('input', { bubbles: true })); });
}, code);
await host.waitForSelector('#view-transfer:not([hidden])', { timeout: 15000 });
await guest.waitForSelector('#view-transfer:not([hidden])', { timeout: 15000 });
const opened = await host.waitForFunction(() => document.getElementById('link-status').textContent.includes('已连接'), { timeout: 45000, polling: 500 }).then(() => true).catch(() => false);
if (!opened) fail('link never connected');
console.log('  paired and connected — sending the file');

// just over INLINE_MAX (64 MB) → the streamed path
const SIZE = 66 * 1024 * 1024;
const tmp = path.join(os.tmpdir(), 'fs-big-sample.bin');
const buf = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) buf[i] = i & 0xff;
fs.writeFileSync(tmp, buf);
await (await host.$('#file-input')).uploadFile(tmp);

await guest.waitForSelector('#in-list a.dl', { timeout: 300000 });
console.log('  received: the 保存 link appeared (so finish() resolved)');
const isStreamed = await guest.evaluate(() => !document.querySelector('#in-list a.dl').href.startsWith('blob:'));
console.log('  took the streamed (service-worker) path:', isStreamed);
if (!isStreamed) fail('file rode the in-memory path — raise SIZE above INLINE_MAX');

console.log('  clicking 保存 …');
await guest.evaluate(() => document.querySelector('#in-list a.dl').click());

// while the save runs, watch the guest's JS heap — an infinite pull loop shows up here
const heaps = [];
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  if (crashed) fail(crashed);
  try { heaps.push(Math.round((await guest.metrics()).JSHeapUsedSize / 1e6)); } catch { fail('guest page died (metrics unavailable) — ' + (crashed || 'crashed')); }
}
console.log('  guest JS heap over 24s (MB):', heaps.join(' → '));

if (crashed) fail(crashed);
const completed = await guest.waitForFunction(
  () => document.querySelector('#in-list a.dl')?.textContent === '已保存 ✓',
  { timeout: 120000, polling: 250 },
).then(() => true).catch(() => false);
if (!completed) fail('the streamed write did not finish');
const saved = await guest.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle('__fileshare_big_save__');
  const file = await handle.getFile();
  const first = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const last = new Uint8Array(await file.slice(-16).arrayBuffer());
  return { size: file.size, first: [...first], last: [...last], label: document.querySelector('#in-list a.dl').textContent };
});
console.log('  saved file:', saved.size, 'bytes | row:', saved.label);
if (saved.label !== '已保存 ✓') fail(`the save did not complete (row=${saved.label})`);
if (saved.size !== SIZE) fail(`wrong size on disk (${saved.size} vs ${SIZE})`);
if (!saved.first.every((b, i) => b === i) || !saved.last.every((b, i) => b === ((SIZE - 16 + i) & 0xff))) fail('saved bytes are corrupt');
done(0, '\nPASS: the large-file 保存 completed without crashing the page');
