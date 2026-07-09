// 文件共享助手 relay-fallback e2e: force the "pairing works but ICE can never connect" network
// (the stuck-at-正在建立直连 bug: AP isolation, symmetric NAT, blocked STUN…) by dropping every
// remote ICE candidate, then assert the app downgrades BOTH peers to the server-relay transport
// (watchdog ≈14s × 2 attempts) and that a file actually transfers over it, bytes intact.
// Usage: node test/fileshare-relay-test.mjs   (takes ~45s — two full P2P attempts must time out)
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { ROOT, launchBrowser } from './harness.mjs';

const PORT = 8203;
const done = (c, m) => { console.log(m); try { browser && browser.close(); } catch {} try { srv && srv.kill(); } catch {} process.exit(c); };
const fail = (m) => done(1, 'FILESHARE RELAY TEST FAIL: ' + m);

function startServer() {
  const s = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')],
    { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res) => { s.stdout.on('data', (d) => { if (/listening/.test(d)) res(s); }); setTimeout(() => res(s), 2500); });
}
const url = `http://localhost:${PORT}/fileshare/?server=ws://localhost:${PORT}`;
let srv, browser;

async function run() {
  srv = await startServer();
  browser = await launchBrowser();
  const host = await browser.newPage();
  const guest = await browser.newPage();
  for (const p of [host, guest]) {
    p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    // the ICE-hostile network: candidates never reach the peer connection
    await p.evaluateOnNewDocument(() => {
      const Orig = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Orig {
        addIceCandidate() { return Promise.resolve(); }
      };
    });
  }
  await host.goto(url, { waitUntil: 'load' });
  await guest.goto(url, { waitUntil: 'load' });
  await host.waitForSelector('#view-landing:not([hidden])', { timeout: 8000 });
  await guest.waitForSelector('#view-landing:not([hidden])', { timeout: 8000 });

  await host.evaluate(() => document.getElementById('btn-host').click());
  await host.waitForFunction(() => document.getElementById('code-display').textContent.replace(/[^A-Z0-9]/g, '').length === 9, { timeout: 5000, polling: 250 });
  const code = await host.evaluate(() => document.getElementById('code-display').textContent.replace(/[^A-Z0-9]/g, ''));
  await guest.click('#btn-code');
  await guest.waitForSelector('#view-code:not([hidden]) .code-input input', { timeout: 5000 });
  await guest.evaluate((c) => {
    const boxes = [...document.querySelectorAll('#code-input input')];
    boxes.forEach((b, i) => { b.value = c[i]; b.dispatchEvent(new Event('input', { bubbles: true })); });
  }, code);
  await host.waitForSelector('#view-transfer:not([hidden])', { timeout: 15000 });
  console.log('  paired; waiting for the P2P attempts to give up (~30s)…');

  // both sides must land on the relay ('中转' in the status), not just any 已连接
  await host.waitForFunction(() => document.getElementById('link-status').textContent.includes('中转') && document.getElementById('link-status').textContent.includes('已连接'), { timeout: 60000, polling: 500 });
  await guest.waitForFunction(() => document.getElementById('link-status').textContent.includes('中转') && document.getElementById('link-status').textContent.includes('已连接'), { timeout: 15000, polling: 500 });
  console.log('  both peers downgraded to the server relay');

  // transfer a file over the relay and verify the bytes
  const tmp = path.join(os.tmpdir(), 'fs-relay-sample.txt');
  const payload = 'bytes via the server relay fallback — '.repeat(3000); // ~114 KB → several chunks
  fs.writeFileSync(tmp, payload);
  const input = await host.$('#file-input');
  await input.uploadFile(tmp);
  await guest.waitForSelector('#in-list a.dl', { timeout: 30000 });
  const got = await guest.evaluate(async () => {
    const a = document.querySelector('#in-list a.dl');
    return { name: a.getAttribute('download'), txt: await (await fetch(a.href)).text() };
  });
  fs.unlinkSync(tmp);
  if (got.name !== 'fs-relay-sample.txt') return fail('received filename wrong: ' + got.name);
  if (got.txt.length !== payload.length) return fail(`received size ${got.txt.length} != sent ${payload.length}`);
  if (got.txt !== payload) return fail('received content mismatch');

  const sentOk = await host.evaluate(() => [...document.querySelectorAll('#out-list .pct')].some((e) => e.textContent.includes('已发送')));
  if (!sentOk) return fail('sender never marked 已发送');

  done(0, `  transferred ${payload.length} bytes through the relay, bytes match\nFILESHARE RELAY TEST PASS`);
}

run().catch((e) => fail(e && e.stack ? e.stack : String(e)));
