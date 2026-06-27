// 文件共享助手 — WebRTC SIGNALING broker (pairing only; NO file bytes ever touch the server).
//
// Two devices pair through a short-lived "room", then exchange WebRTC SDP/ICE through this relay
// and transfer files device-to-device over an encrypted DataChannel. We only broker the handshake:
//   fs-create → mint a room, return its id (a 9-char case-insensitive alphanumeric code)
//   fs-join   → the second device claims the room; the room LOCKS at 2 peers (3rd is rejected)
//   fs-signal → relay one peer's SDP/ICE blob verbatim to the OTHER peer in the room
//   fs-leave  → tear the room down, tell the surviving peer
//
// Security model (see docs/file-share-helper.md): file content is end-to-end encrypted by WebRTC
// DTLS, so the only real risk is the WRONG device pairing. We mitigate with a high-entropy room id
// (≈46 bits), a 2-peer lock, a short unclaimed TTL, and a per-IP join rate-limit.

// 9-char id from a case-insensitive alphanumeric alphabet (A–Z 0–9). 36^9 ≈ 1.0e14 ≈ 46 bits.
// Normalized to uppercase everywhere; the client displays it grouped 3-3-3 (AB3-7KP-9QZ) but the
// dashes are cosmetic — only the 9 chars are significant.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LEN = 9;
const ROOM_TTL_MS = 120_000;     // an unclaimed room expires after this
const JOIN_WINDOW_MS = 60_000;   // rate-limit window per ip
const JOIN_MAX = 30;             // max join attempts per ip per window (blunts code-guessing)

// roomId → { host, guest, createdAt }   (host/guest are connection clients: { ws, id, ... })
const rooms = new Map();
// ip → { count, resetAt }
const joinHits = new Map();

// Normalize whatever the client typed/scanned to the canonical 9-char form: uppercase, keep only
// alphanumerics (drops the cosmetic dashes / spaces). Returns '' if it isn't a valid 9-char code.
function normalizeCode(s) {
  const c = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === CODE_LEN ? c : '';
}

function newCode() {
  let c;
  do {
    c = '';
    for (let i = 0; i < CODE_LEN; i++) c += ALPHABET[(Math.random() * ALPHABET.length) | 0];
  } while (rooms.has(c)); // astronomically unlikely, but never collide a live room
  return c;
}

const send = (ws, msg) => { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
const peerOf = (room, client) => (room.host === client ? room.guest : room.host);

function rateOk(ip) {
  const now = Date.now();
  let h = joinHits.get(ip);
  if (!h || now > h.resetAt) { h = { count: 0, resetAt: now + JOIN_WINDOW_MS }; joinHits.set(ip, h); }
  h.count++;
  return h.count <= JOIN_MAX;
}

// Drop a client from any room it's in, telling the surviving peer the link is gone. Called on
// fs-leave and on socket close.
function leaveRoom(client) {
  for (const [id, room] of rooms) {
    if (room.host !== client && room.guest !== client) continue;
    const other = peerOf(room, client);
    rooms.delete(id);
    if (other) send(other.ws, { type: 'fs-peer-gone' });
    break; // a client is only ever in one room
  }
}

// Handle one fs-* message. `client` is the per-connection object (carries .ws); `ip` identifies the
// remote for rate-limiting. Returns true if it consumed the message.
function handleFs(client, msg, ip) {
  switch (msg.type) {
    case 'fs-create': {
      leaveRoom(client); // one room per client; abandon any previous
      const id = newCode();
      rooms.set(id, { host: client, guest: null, createdAt: Date.now() });
      send(client.ws, { type: 'fs-created', room: id });
      return true;
    }
    case 'fs-join': {
      const id = normalizeCode(msg.room);
      if (!id) { send(client.ws, { type: 'fs-error', code: 'bad' }); return true; }
      if (!rateOk(ip)) { send(client.ws, { type: 'fs-error', code: 'rate' }); return true; }
      const room = rooms.get(id);
      if (!room) { send(client.ws, { type: 'fs-error', code: 'gone' }); return true; }
      if (room.guest || room.host === client) { send(client.ws, { type: 'fs-error', code: 'full' }); return true; }
      leaveRoom(client); // in case this client was hosting something else
      room.guest = client;
      // Both peers learn they're connected. The guest is the "polite" peer for perfect-negotiation
      // (it yields on offer collisions); the host makes the initial offer.
      send(room.host.ws, { type: 'fs-peer', role: 'host', polite: false });
      send(room.guest.ws, { type: 'fs-peer', role: 'guest', polite: true });
      return true;
    }
    case 'fs-signal': {
      // Relay an opaque SDP/ICE blob to the other peer. Find the client's room by membership (don't
      // trust a room id on the wire for routing — the socket's room is authoritative).
      for (const room of rooms.values()) {
        if (room.host !== client && room.guest !== client) continue;
        const other = peerOf(room, client);
        if (other) send(other.ws, { type: 'fs-signal', data: msg.data });
        break;
      }
      return true;
    }
    case 'fs-leave': {
      leaveRoom(client);
      return true;
    }
    default:
      return false;
  }
}

// Periodic sweep: expire rooms never claimed within the TTL (host minted a code then wandered off),
// and prune stale rate-limit buckets. Returns the interval so the caller can clear it on shutdown.
function startFsSweep() {
  return setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms) {
      if (!room.guest && now - room.createdAt > ROOM_TTL_MS) {
        rooms.delete(id);
        send(room.host.ws, { type: 'fs-error', code: 'expired' });
      }
    }
    for (const [ip, h] of joinHits) if (now > h.resetAt) joinHits.delete(ip);
  }, 10_000);
}

export { handleFs, leaveRoom as fsOnClose, startFsSweep, normalizeCode, rooms as _fsRooms };
