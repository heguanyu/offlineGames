// 文件共享助手 transfer protocol (fileshare/rtc.js) — deterministic unit test. Drives the REAL
// PeerLink send/receive code over a pair of piped fake DataChannels (no actual WebRTC/UDP, which is
// firewall-blocked in headless sandboxes). Verifies the meta→chunk→end framing, in-order chunked
// transfer, Blob reassembly, progress events, and that bytes arrive intact.
// Usage: node test/fileshare-transfer-test.mjs

// rtc.js touches RTCPeerConnection in its constructor; stub it so we can exercise the channel logic.
let handOut = null;
globalThis.RTCPeerConnection = class { constructor() {} createDataChannel() { return handOut; } close() {} };

const { PeerLink } = await import('../fileshare/rtc.js');

let failed = 0;
const ok = (c, m) => { if (!c) { console.log('  FAIL:', m); failed++; } };

// a pair of fake DataChannels that deliver to each other asynchronously, preserving FIFO order
function channelPair() {
  const mk = () => ({
    readyState: 'open', bufferedAmount: 0, binaryType: 'blob', bufferedAmountLowThreshold: 0,
    onopen: null, onclose: null, onmessage: null, _peer: null,
    addEventListener() {}, removeEventListener() {},
    send(data) { const p = this._peer; setTimeout(() => { if (p.onmessage) p.onmessage({ data }); }, 0); },
    close() { this.readyState = 'closed'; if (this.onclose) this.onclose(); },
  });
  const a = mk(), b = mk(); a._peer = b; b._peer = a; return [a, b];
}
const fakeSig = () => Object.assign(new EventTarget(), { signal() {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [chA, chB] = channelPair();
handOut = chA;
const sender = new PeerLink(fakeSig(), { polite: false });   // impolite → constructor binds chA
const receiver = new PeerLink(fakeSig(), { polite: true });  // polite → no auto channel
receiver._bindChannel(chB);

// both report 'open' (chA was open at bind time; chB bound while open → the readyState fallback fires)
let senderOpen = false, recvOpen = false;
sender.addEventListener('open', () => { senderOpen = true; });
receiver.addEventListener('open', () => { recvOpen = true; });
// give the synchronous _opened() a tick (sender already fired during construction; re-check after bind)
ok(sender._openFired, 'sender channel reported open');
ok(receiver._openFired, 'receiver channel reported open');

// a ~70 KB payload → multiple 16 KB chunks
const bytes = new Uint8Array(70000);
for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 3) & 0xff;
const file = new File([bytes], 'sample.bin', { type: 'application/octet-stream' });

let incomingMeta = null, received = null, outProgress = 0, inProgress = 0, sentEvent = null;
receiver.addEventListener('incoming', (e) => { incomingMeta = e.detail; });
receiver.addEventListener('received', (e) => { received = e.detail; });
receiver.addEventListener('progress', (e) => { if (e.detail.dir === 'in') inProgress = e.detail.done; });
sender.addEventListener('progress', (e) => { if (e.detail.dir === 'out') outProgress = e.detail.done; });
sender.addEventListener('sent', (e) => { sentEvent = e.detail; });

sender.send(file);

// wait for the transfer to complete
for (let i = 0; i < 200 && !received; i++) await sleep(10);

ok(incomingMeta && incomingMeta.name === 'sample.bin' && incomingMeta.size === bytes.length, 'receiver got file meta (name+size)');
ok(received, 'receiver fired received');
if (received) {
  const got = new Uint8Array(await received.blob.arrayBuffer());
  ok(received.name === 'sample.bin', 'received name correct');
  ok(got.length === bytes.length, `received length ${got && got.length} == ${bytes.length}`);
  let same = got.length === bytes.length; for (let i = 0; same && i < got.length; i++) if (got[i] !== bytes[i]) same = false;
  ok(same, 'received bytes identical to sent');
}
ok(outProgress === bytes.length, `sender progress reached full (${outProgress})`);
ok(inProgress === bytes.length, `receiver progress reached full (${inProgress})`);
ok(sentEvent && sentEvent.name === 'sample.bin', 'sender fired sent');

if (failed) { console.log(`FILESHARE TRANSFER TEST FAIL (${failed})`); process.exit(1); }
console.log('FILESHARE TRANSFER TEST PASS');
process.exit(0);
