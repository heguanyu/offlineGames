// 文件共享助手 — WebRTC SIGNALING broker (pairing only; NO file bytes ever touch the server).
//
// Two devices pair through a short-lived "room", then exchange WebRTC SDP/ICE through this relay
// and transfer files device-to-device over an encrypted DataChannel. We only broker the handshake:
//   fs-create → mint a room, return its id (a 9-char case-insensitive alphanumeric code)
//   fs-join   → the second device claims the room; the room LOCKS at 2 peers (3rd is rejected)
//   fs-signal → relay one peer's SDP/ICE blob verbatim to the OTHER peer in the room
//   fs-resume → a peer whose socket dropped (screen lock / brief background) re-attaches to its room
//   fs-repair → both sockets are up but the P2P link died → re-issue the pairing so both rebuild RTC
//   fs-leave  → tear the room down explicitly, tell the surviving peer
//
// Connection lifetime ≠ socket lifetime. A signaling socket drop is COMMON and benign — iOS freezes
// the page (and its WebSocket) on screen-lock or while a download save-sheet is up. So a dropped
// socket does NOT end the session: the room is kept alive for DISCONNECT_GRACE_MS and the peer is
// told 'fs-peer-stale' (show "重连中…"). If the dropped side reconnects and resumes within the grace
// window the session continues (RTC is rebuilt); only an explicit fs-leave or a grace timeout ends it
// with 'fs-peer-gone'. Each slot gets a resume token so only the original occupant can re-attach.
//
// Security model (see docs/file-share-helper.md): file content is end-to-end encrypted by WebRTC
// DTLS, so the only real risk is the WRONG device pairing. We mitigate with a high-entropy room id
// (≈46 bits), a 2-peer lock, a short unclaimed TTL, a per-slot resume token, and a per-IP join
// rate-limit.

// 9-char id from a case-insensitive alphanumeric alphabet (A–Z 0–9). 36^9 ≈ 1.0e14 ≈ 46 bits.
// Normalized to uppercase everywhere; the client displays it grouped 3-3-3 (AB3-7KP-9QZ) but the
// dashes are cosmetic — only the 9 chars are significant.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LEN = 9;
const TOKEN_LEN = 24;               // per-slot resume token (~124 bits) — proves re-attach identity
const ROOM_TTL_MS = 120_000;        // an unclaimed room expires after this
const DISCONNECT_GRACE_MS = 120_000; // a dropped peer may resume within this before the room ends
const JOIN_WINDOW_MS = 60_000;      // rate-limit window per ip
const JOIN_MAX = 30;                // max join attempts per ip per window (blunts code-guessing)

// roomId → {
//   id, createdAt,
//   host:  { client, token } | null,   guest: { client, token } | null,
//   hostDownAt, guestDownAt           // 0 = connected; else ms deadline after which the drop ends it
// }   (client is the per-connection object: { ws, fsRoom, fsRole, ... })
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

function newToken() {
  let t = '';
  for (let i = 0; i < TOKEN_LEN; i++) t += ALPHABET[(Math.random() * ALPHABET.length) | 0];
  return t;
}

const send = (ws, msg) => { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
const otherName = (role) => (role === 'host' ? 'guest' : 'host');
const otherSlot = (room, client) => (client.fsRole === 'host' ? room.guest : room.host);

// Tell both peers to (re)establish the WebRTC link. Sent on the initial pairing AND on every
// resume/repair — the client treats each as "build a fresh PeerLink now". The guest is the "polite"
// peer for perfect-negotiation (it yields on offer collisions); the host makes the initial offer.
// Carries each peer its room+resume token so the client can re-attach after a socket drop.
function pairUp(room) {
  if (!room.host || !room.guest) return;
  send(room.host.client.ws, { type: 'fs-peer', role: 'host', polite: false, room: room.id, token: room.host.token });
  send(room.guest.client.ws, { type: 'fs-peer', role: 'guest', polite: true, room: room.id, token: room.guest.token });
}

function rateOk(ip) {
  const now = Date.now();
  let h = joinHits.get(ip);
  if (!h || now > h.resetAt) { h = { count: 0, resetAt: now + JOIN_WINDOW_MS }; joinHits.set(ip, h); }
  h.count++;
  return h.count <= JOIN_MAX;
}

// EXPLICIT departure (fs-leave) or abandoning a previous room (fs-create/join/resume of another room):
// drop the client from its room, delete the room, and tell the surviving peer the link is gone.
function detach(client) {
  const id = client.fsRoom, role = client.fsRole;
  client.fsRoom = null; client.fsRole = null;
  const room = id && rooms.get(id);
  if (!room) return;
  // Bail if this client no longer occupies its slot (it already resumed elsewhere) — don't nuke a room
  // that's since been re-attached by a fresh socket.
  if (room[role] && room[role].client !== client) return;
  rooms.delete(id);
  const other = room[otherName(role)];
  if (other) send(other.client.ws, { type: 'fs-peer-gone' });
}

// Handle one fs-* message. `client` is the per-connection object (carries .ws); `ip` identifies the
// remote for rate-limiting. Returns true if it consumed the message.
function handleFs(client, msg, ip) {
  switch (msg.type) {
    case 'fs-create': {
      detach(client); // one room per client; abandon any previous
      const id = newCode();
      const room = { id, createdAt: Date.now(), host: { client, token: newToken() }, guest: null, hostDownAt: 0, guestDownAt: 0 };
      rooms.set(id, room);
      client.fsRoom = id; client.fsRole = 'host';
      // The host's resume token rides along on fs-created (it has no peer yet) so it can survive a drop
      // even before anyone joins; the guest gets its token on fs-peer.
      send(client.ws, { type: 'fs-created', room: id, token: room.host.token });
      return true;
    }
    case 'fs-join': {
      const id = normalizeCode(msg.room);
      if (!id) { send(client.ws, { type: 'fs-error', code: 'bad' }); return true; }
      if (!rateOk(ip)) { send(client.ws, { type: 'fs-error', code: 'rate' }); return true; }
      const room = rooms.get(id);
      if (!room) { send(client.ws, { type: 'fs-error', code: 'gone' }); return true; }
      if (room.guest || room.host.client === client) { send(client.ws, { type: 'fs-error', code: 'full' }); return true; }
      detach(client); // in case this client was hosting something else
      room.guest = { client, token: newToken() };
      room.guestDownAt = 0;
      client.fsRoom = id; client.fsRole = 'guest';
      pairUp(room); // both peers learn they're connected (delivers each its room+token)
      return true;
    }
    case 'fs-signal': {
      // Relay an opaque SDP/ICE blob to the other peer. The socket's room is authoritative — never
      // trust a room id on the wire for routing.
      const room = rooms.get(client.fsRoom);
      if (room) { const other = otherSlot(room, client); if (other) send(other.client.ws, { type: 'fs-signal', data: msg.data }); }
      return true;
    }
    case 'fs-resume': {
      // A peer whose socket dropped re-attaches to its room. Proven by the per-slot token.
      const id = normalizeCode(msg.room);
      const role = msg.role === 'host' ? 'host' : 'guest';
      const room = id && rooms.get(id);
      const slot = room && room[role];
      if (!room || !slot || slot.token !== msg.token) {
        send(client.ws, { type: 'fs-peer-gone' }); // session truly ended → client returns to landing
        return true;
      }
      detach(client); // leave any other room first
      slot.client = client;
      room[role + 'DownAt'] = 0;
      client.fsRoom = id; client.fsRole = role;
      if (room.host && room.guest && !room.hostDownAt && !room.guestDownAt) pairUp(room); // both back → rebuild RTC
      else send(client.ws, { type: 'fs-peer-stale' }); // peer still away → keep waiting
      return true;
    }
    case 'fs-repair': {
      // Both signaling sockets are up but the P2P link died (NAT rebind, etc). Re-issue the pairing so
      // both sides tear down the dead RTCPeerConnection and build a fresh one.
      const room = rooms.get(client.fsRoom);
      if (room && room.host && room.guest && !room.hostDownAt && !room.guestDownAt) pairUp(room);
      return true;
    }
    case 'fs-leave': {
      detach(client);
      return true;
    }
    default:
      return false;
  }
}

// Socket dropped WITHOUT an explicit fs-leave (the common case: iOS froze the page on lock/background).
// Don't end the session — keep the room and start a grace timer so the peer can resume; tell the
// surviving peer to show "重连中…". An unclaimed room (host dropped before anyone joined) is just
// discarded — there's nothing to resume.
function fsOnClose(client) {
  const id = client.fsRoom, role = client.fsRole;
  const room = id && rooms.get(id);
  if (!room) return;
  if (room[role] && room[role].client !== client) return; // this socket was already replaced by a resume
  if (!room.guest) { rooms.delete(id); return; }           // never claimed → nothing to resume
  room[role + 'DownAt'] = Date.now() + DISCONNECT_GRACE_MS;
  const other = room[otherName(role)];
  if (other && !room[otherName(role) + 'DownAt']) send(other.client.ws, { type: 'fs-peer-stale' });
}

// One sweep pass (extracted so tests can drive it with an injected `now`): expire unclaimed rooms,
// end sessions whose dropped peer never resumed within the grace window, and prune rate buckets.
function fsSweepOnce(now = Date.now()) {
  for (const [id, room] of rooms) {
    if (!room.guest && now - room.createdAt > ROOM_TTL_MS) {
      rooms.delete(id);
      if (room.host) send(room.host.client.ws, { type: 'fs-error', code: 'expired' });
      continue;
    }
    for (const role of ['host', 'guest']) {
      const deadline = room[role + 'DownAt'];
      if (deadline && now > deadline) {
        rooms.delete(id);
        const other = room[otherName(role)];
        if (other && !room[otherName(role) + 'DownAt']) send(other.client.ws, { type: 'fs-peer-gone' });
        break;
      }
    }
  }
  for (const [ip, h] of joinHits) if (now > h.resetAt) joinHits.delete(ip);
}

// Periodic sweep. Returns the interval so the caller can clear it on shutdown.
function startFsSweep() { return setInterval(() => fsSweepOnce(), 10_000); }

export { handleFs, fsOnClose, startFsSweep, fsSweepOnce, normalizeCode, rooms as _fsRooms };
