// 文件共享助手 signaling broker (server/fileshare.js) — unit test. Drives handleFs/fsOnClose with
// fake clients (a ws stub that records sent frames) and asserts the room lifecycle: create → join
// locks at 2 peers (3rd rejected) → signal relays only to the peer → close notifies + frees → bad /
// missing codes error → join rate-limit. No real server/socket needed.
// Usage: node test/fileshare-signal-test.mjs
import { handleFs, fsOnClose, fsSweepOnce, normalizeCode, _fsRooms } from '../server/fileshare.js';

let failed = 0;
const ok = (cond, msg) => { if (!cond) { console.log('  FAIL:', msg); failed++; } };
const last = (c) => c.ws.sent[c.ws.sent.length - 1];
function mkClient() { return { ws: { OPEN: 1, readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); } } }; }

// ---- create → join → lock --------------------------------------------------
const host = mkClient(), guest = mkClient(), intruder = mkClient();
handleFs(host, { type: 'fs-create' }, 'ipH');
const created = last(host);
ok(created.type === 'fs-created', 'host gets fs-created');
const code = created.room;
ok(/^[A-Z0-9]{9}$/.test(code), 'room code is 9 uppercase alphanumerics, got ' + code);

// guest joins with dashes + lowercase → must normalize and match
handleFs(guest, { type: 'fs-join', room: code.slice(0, 3) + '-' + code.slice(3, 6) + '-' + code.slice(6).toLowerCase() }, 'ipG');
ok(last(host).type === 'fs-peer' && last(host).role === 'host' && last(host).polite === false, 'host notified fs-peer (impolite)');
ok(last(guest).type === 'fs-peer' && last(guest).role === 'guest' && last(guest).polite === true, 'guest notified fs-peer (polite)');

// third joiner rejected — room is locked at 2
handleFs(intruder, { type: 'fs-join', room: code }, 'ipX');
ok(last(intruder).type === 'fs-error' && last(intruder).code === 'full', 'third join rejected as full');

// ---- signal relay (only to the peer, never echoed) -------------------------
const hBefore = guest.ws.sent.length;
handleFs(host, { type: 'fs-signal', data: { description: { type: 'offer' } } }, 'ipH');
ok(last(guest).type === 'fs-signal' && last(guest).data.description.type === 'offer', 'host signal relayed to guest');
ok(host.ws.sent.length && last(host).type !== 'fs-signal', 'signal not echoed back to sender');
const gBefore = host.ws.sent.length;
handleFs(guest, { type: 'fs-signal', data: { candidate: 'x' } }, 'ipG');
ok(last(host).type === 'fs-signal' && last(host).data.candidate === 'x', 'guest signal relayed to host');

// ---- socket drop is NOT a leave: room is kept for a grace window -----------
// A dropped socket (screen lock / background) must not end the session — the peer is told 'stale'
// and the room survives so the dropped side can resume.
fsOnClose(host);
ok(last(guest).type === 'fs-peer-stale', 'guest told peer-stale (not gone) on host socket drop');
ok(_fsRooms.has(code), 'room kept alive after a socket drop (resume window)');

// ---- resume: the dropped peer re-attaches with its token → both re-paired --
const newHost = mkClient();
handleFs(newHost, { type: 'fs-resume', room: code, role: 'host', token: created.token }, 'ipH');
ok(last(newHost).type === 'fs-peer' && last(newHost).polite === false, 'resumed host re-paired (fs-peer)');
ok(last(guest).type === 'fs-peer', 'guest re-paired when peer resumed');
// a resume with the wrong token is refused as a dead session
const impostor = mkClient();
handleFs(impostor, { type: 'fs-resume', room: code, role: 'guest', token: 'WRONGTOKENWRONGTOKEN0000' }, 'ipI');
ok(last(impostor).type === 'fs-peer-gone', 'resume with a bad token → peer-gone (refused)');

// ---- grace expiry: a drop that never resumes ends the session --------------
fsOnClose(guest);
ok(last(newHost).type === 'fs-peer-stale', 'host told peer-stale on guest drop');
fsSweepOnce(Date.now() + 10 * 60_000); // jump past the grace deadline
ok(last(newHost).type === 'fs-peer-gone', 'survivor told peer-gone after the grace window expires');
ok(!_fsRooms.has(code), 'room removed once the grace window expires');

// ---- explicit leave → survivor notified immediately + room freed -----------
const h2 = mkClient(), g2 = mkClient();
handleFs(h2, { type: 'fs-create' }, 'ipH2');
const code2 = last(h2).room;
handleFs(g2, { type: 'fs-join', room: code2 }, 'ipG2');
handleFs(h2, { type: 'fs-leave' }, 'ipH2');
ok(last(g2).type === 'fs-peer-gone', 'guest told peer-gone immediately on explicit leave');
ok(!_fsRooms.has(code2), 'room removed on explicit leave');

// ---- error cases -----------------------------------------------------------
const lonely = mkClient();
handleFs(lonely, { type: 'fs-join', room: 'ZZZZZZZZZ' }, 'ipZ');
ok(last(lonely).type === 'fs-error' && last(lonely).code === 'gone', 'join of unknown code → gone');
handleFs(lonely, { type: 'fs-join', room: 'bad' }, 'ipZ');
ok(last(lonely).type === 'fs-error' && last(lonely).code === 'bad', 'malformed code → bad');
ok(normalizeCode('ab3-7kp-9qz') === 'AB37KP9QZ' && normalizeCode('short') === '', 'normalizeCode strips/uppercases & validates length');

// ---- rate limit ------------------------------------------------------------
const flooder = mkClient();
let gotRate = false;
for (let i = 0; i < 40; i++) { handleFs(flooder, { type: 'fs-join', room: 'AAAAAAAAA' }, 'ipFlood'); if (last(flooder).code === 'rate') { gotRate = true; break; } }
ok(gotRate, 'join attempts are rate-limited per ip');

if (failed) { console.log(`FILESHARE SIGNAL TEST FAIL (${failed})`); process.exit(1); }
console.log('FILESHARE SIGNAL TEST PASS');
