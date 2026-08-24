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
    value: async (opts) => (await navigator.storage.getDirectory()).getFileHandle(
      opts?.suggestedName?.endsWith('.zip') ? '__fileshare_big_zip__' : '__fileshare_big_save__',
      { create: true },
    ),
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

// A second, small Blob-backed file makes the batch action appear. Re-select the already-saved large
// row and exercise the real mixed-source ZIP button: big entry from SW/IndexedDB, small entry from Blob.
const SMALL = 8192;
const smallTmp = path.join(os.tmpdir(), 'fs-small-zip-sample.bin');
const smallBuf = Buffer.alloc(SMALL);
for (let i = 0; i < SMALL; i++) smallBuf[i] = (i * 7 + 3) & 0xff;
fs.writeFileSync(smallTmp, smallBuf);
await (await host.$('#file-input')).uploadFile(smallTmp);
await guest.waitForFunction(() => document.querySelectorAll('#in-list li.item').length === 2, { timeout: 30000 });
await guest.evaluate(() => {
  const first = document.querySelector('#in-list li.item .pick');
  first.checked = true;
  first.dispatchEvent(new Event('change', { bubbles: true }));
});
await guest.waitForFunction(() => {
  const button = document.getElementById('save-selected');
  return !document.getElementById('in-actions').hidden && !button.disabled && button.textContent.includes('(2)');
}, { timeout: 5000 });

console.log('  clicking 打包 .zip for one large + one small file …');
await guest.click('#save-selected');
const zipped = await guest.waitForFunction(
  () => [...document.querySelectorAll('#in-list a.dl')].every((a) => a.textContent === '已保存 ✓'),
  { timeout: 120000, polling: 250 },
).then(() => true).catch(() => false);
if (!zipped) fail('the streamed ZIP write did not finish');

const zip = await guest.evaluate(async ({ bigSize, smallSize }) => {
  const root = await navigator.storage.getDirectory();
  const file = await (await root.getFileHandle('__fileshare_big_zip__')).getFile();
  const td = new TextDecoder();
  const read = async (start, length) => new Uint8Array(await file.slice(start, start + length).arrayBuffer());
  const u16 = (u, p) => u[p] | (u[p + 1] << 8);
  const u32 = (u, p) => (u[p] | (u[p + 1] << 8) | (u[p + 2] << 16) | (u[p + 3] << 24)) >>> 0;

  const h1 = await read(0, 256);
  const n1 = u16(h1, 26), name1 = td.decode(h1.slice(30, 30 + n1)), data1 = 30 + n1;
  const first1 = await read(data1, 16), last1 = await read(data1 + bigSize - 16, 16);
  const d1 = await read(data1 + bigSize, 16);
  const secondOffset = data1 + bigSize + 16;
  const h2 = await read(secondOffset, 256);
  const n2 = u16(h2, 26), name2 = td.decode(h2.slice(30, 30 + n2)), data2 = secondOffset + 30 + n2;
  const bytes2 = await read(data2, smallSize), d2 = await read(data2 + smallSize, 16);
  const central = await read(data2 + smallSize + 16, 4);
  const end = await read(file.size - 22, 22);
  return {
    size: file.size, name1, name2,
    first1: [...first1], last1: [...last1], bytes2: [...bytes2],
    descriptor1: u32(d1, 0), size1: u32(d1, 8),
    descriptor2: u32(d2, 0), size2: u32(d2, 8),
    central: u32(central, 0), eocd: u32(end, 0), entries: u16(end, 10),
  };
}, { bigSize: SIZE, smallSize: SMALL });
console.log('  streamed ZIP:', zip.size, 'bytes | entries:', zip.name1, '+', zip.name2);
if (zip.name1 !== path.basename(tmp) || zip.name2 !== path.basename(smallTmp)) fail('ZIP entry names are wrong');
if (zip.descriptor1 !== 0x08074b50 || zip.descriptor2 !== 0x08074b50 || zip.size1 !== SIZE || zip.size2 !== SMALL) fail('ZIP data descriptors are wrong');
if (zip.central !== 0x02014b50 || zip.eocd !== 0x06054b50 || zip.entries !== 2) fail('ZIP directory framing is wrong');
if (!zip.first1.every((b, i) => b === i) || !zip.last1.every((b, i) => b === ((SIZE - 16 + i) & 0xff))) fail('large ZIP entry bytes are corrupt');
if (!zip.bytes2.every((b, i) => b === ((i * 7 + 3) & 0xff))) fail('small ZIP entry bytes are corrupt');
done(0, '\nPASS: direct save and mixed large-file ZIP both completed without crashing the page');
