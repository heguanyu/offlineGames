// 文件共享助手 end-to-end: spin up the REAL server (static site + WS signaling), open two headless
// pages, pair them by typing the 9-char code, then send a file from one and confirm the other
// receives the exact bytes over the WebRTC DataChannel. Exercises qr/code UI + signaling + rtc.
// Usage: node test/fileshare-e2e.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { ROOT, launchBrowser } from './harness.mjs';

const PORT = 8199;
const done = (c, m) => { console.log(m); try { browser && browser.close(); } catch {} try { srv && srv.kill(); } catch {} process.exit(c); };
const fail = (m) => done(1, 'FILESHARE E2E FAIL: ' + m);

function startServer() {
  const s = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')],
    { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res) => { s.stdout.on('data', (d) => { if (/listening/.test(d)) res(s); }); setTimeout(() => res(s), 2500); });
}
// serverUrl() hardcodes ws://localhost:18012 for localhost, so point the page's signaling at the
// real port via the ?server= override (same hook the lobby tests use).
const url = `http://localhost:${PORT}/fileshare/?server=ws://localhost:${PORT}`;
let srv, browser;

async function run() {
  srv = await startServer();
  console.log('  server up');
  // Headless Chromium hides local ICE candidates behind mDNS .local names that don't resolve in
  // this environment, so loopback WebRTC never connects — expose real local IPs for the test.
  browser = await launchBrowser(['--disable-features=WebRtcHideLocalIpsWithMdns']);
  console.log('  browser up');

  const host = await browser.newPage();
  const guest = await browser.newPage();
  for (const p of [host, guest]) { p.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text()); }); p.on('pageerror', (e) => console.log('  [pageerror]', e.message)); }

  // 'load' not 'networkidle0' — the signaling WebSocket stays open, so the network is never idle.
  await host.goto(url, { waitUntil: 'load' });
  await guest.goto(url, { waitUntil: 'load' });
  console.log('  both pages loaded');

  // landing view visible on both
  await host.waitForSelector('#view-landing:not([hidden])', { timeout: 5000 });
  console.log('  landing visible');

  // host creates a share → a 9-char code appears
  await host.evaluate(() => document.getElementById('btn-host').click());
  await host.waitForFunction(() => { const t = document.getElementById('code-display').textContent.replace(/[^A-Z0-9]/g, ''); return t.length === 9; }, { timeout: 5000, polling: 250 });
  const code = await host.evaluate(() => document.getElementById('code-display').textContent.replace(/[^A-Z0-9]/g, ''));
  console.log('  host code:', code);
  // QR canvas actually rendered (non-blank)
  const qrPainted = await host.evaluate(() => { const c = document.getElementById('qr'); const x = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < x.length; i += 4) if (x[i] < 128) return true; return false; });
  if (!qrPainted) return fail('QR canvas is blank');

  // guest types the code into the 3×3 boxes
  await guest.click('#btn-code');
  await guest.waitForSelector('#view-code:not([hidden]) .code-input input', { timeout: 5000 });
  await guest.evaluate((c) => {
    const boxes = [...document.querySelectorAll('#code-input input')];
    boxes.forEach((b, i) => { b.value = c[i]; b.dispatchEvent(new Event('input', { bubbles: true })); });
  }, code);
  // filling the last box auto-submits the join — no extra click (a duplicate join would race)

  // HARD assertion: pairing delivered fs-peer to both → each opened the transfer view + built a
  // PeerLink (which kicked off WebRTC offer/answer/ICE through the signaling relay).
  await host.waitForSelector('#view-transfer:not([hidden])', { timeout: 10000 });
  await guest.waitForSelector('#view-transfer:not([hidden])', { timeout: 10000 });
  console.log('  paired: both reached the transfer view');

  // The link MUST connect one way or the other: P2P when the sandbox allows loopback UDP, else
  // the app downgrades to the server-relay transport (watchdog ≈14s × 2 attempts → relay), which
  // only needs the already-working signaling socket. This exercises exactly the "stuck at
  // 正在建立直连 + retry" bug: pairing fine, ICE impossible.
  // NOTE: interval polling, not the default rAF — the host page is a hidden background tab in
  // headless Chrome, where rAF never fires, so an rAF-polled predicate can miss a status that
  // was set within the first second (this bit us: the link connected at ~1s and the wait still
  // timed out at 45s).
  const opened = await host.waitForFunction(() => document.getElementById('link-status').textContent.includes('已连接'), { timeout: 45000, polling: 500 }).then(() => true).catch(() => false);
  if (!opened) return fail('link never connected — even the server-relay fallback failed');
  await guest.waitForFunction(() => document.getElementById('link-status').textContent.includes('已连接'), { timeout: 15000, polling: 500 });
  const mode = await host.evaluate(() => document.getElementById('link-status').textContent);
  console.log(`  both peers connected (${mode.includes('中转') ? 'server relay' : 'P2P DataChannel'}) — transferring a file`);

  // host sends a file via the hidden file input (uploadFile triggers the real change handler)
  const tmp = path.join(os.tmpdir(), 'fs-e2e-sample.txt');
  const payload = 'hello from the file share helper — '.repeat(2000); // ~70 KB → multiple chunks
  fs.writeFileSync(tmp, payload);
  const input = await host.$('#file-input');
  await input.uploadFile(tmp);

  // guest receives it: an <a.dl> appears; fetch its blob URL and compare bytes
  await guest.waitForSelector('#in-list a.dl', { timeout: 20000 });
  const got = await guest.evaluate(async () => {
    const a = document.querySelector('#in-list a.dl');
    const name = a.getAttribute('download');
    const txt = await (await fetch(a.href)).text();
    return { name, len: txt.length, head: txt.slice(0, 34) };
  });
  fs.unlinkSync(tmp);

  if (got.name !== 'fs-e2e-sample.txt') return fail('received filename wrong: ' + got.name);
  if (got.len !== payload.length) return fail(`received size ${got.len} != sent ${payload.length}`);
  if (got.head !== payload.slice(0, 34)) return fail('received content mismatch');

  // sender shows it completed
  const sentOk = await host.evaluate(() => [...document.querySelectorAll('#out-list .pct')].some((e) => e.textContent.includes('已发送')));
  if (!sentOk) return fail('sender never marked 已发送');

  done(0, `transferred ${got.len} bytes, bytes match\nFILESHARE E2E PASS`);
}

run().catch((e) => fail(e && e.stack ? e.stack : String(e)));
