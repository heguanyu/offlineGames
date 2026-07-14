# 文件共享助手 (File Sharing Helper) — implementation plan

A new hub entry that moves files between a PC and the iPad (or any two devices) over the
local network, with the same backend that already runs the online lobby acting only as a
**pairing/signaling** broker. Files travel **device-to-device over WebRTC** (encrypted, never
stored on the server); the iPad saves received files through the **browser download flow**, so
they land in the iOS **Files app → Downloads** and are visible in "file explorer".

## Why this shape (the constraints that drove it)

- **A PWA cannot open a listening port.** Browser JS has no API to bind a socket / accept inbound
  connections — so the "iPad opens 10.0.0.88" model (like VLC's native WiFi share) is impossible.
  Our Azure Node server *can* broker a connection, so we use it purely for signaling.
- **WebRTC DataChannels are mandatorily encrypted (DTLS).** File bytes are end-to-end encrypted
  peer-to-peer; a passive sniffer on the LAN/router/path only sees ciphertext. When both devices
  are on the same WiFi, ICE keeps the bytes on the LAN.
- **iOS download = Files app.** On iOS 13+ a Blob download (`<a download>`) saves to
  Downloads (On My iPad / iCloud Drive), browsable in the Files app — covers txt/pdf/video/zip/photos
  uniformly since it's just bytes.
- **iOS source limits (sending from iPad):** photos/videos (Photo Library picker) and any Files-app
  file are reachable; **Apple Music / Music-app library songs are NOT** (DRM/sandboxed) — only loose
  audio files saved in Files. True drag-drop into a web page is desktop-only; iPad uses a tap picker.

## Threat model & mitigations (baked into the design)

- **Content interception:** covered for free by WebRTC DTLS + `wss://` signaling.
- **Wrong-device pairing (the real risk):** someone who sees the QR / guesses the room / races the
  join could become the peer. Mitigations:
  - High-entropy room id (≥50 bits, base32, no ambiguous chars) → un-guessable.
  - Room **locked at 2 peers** — server rejects any third joiner.
  - **Short TTL** — unclaimed room expires in 120s; swept.
  - **Join rate-limit** per IP.
  - **Explicit send action** — files only flow when the human picks files and presses send, so a
    racing peer can't silently pull data; both sides see the peer connect first.
- **Trust root = our signaling server** (it relays DTLS fingerprints). Acceptable (it's ours).
  *Optional hardening (phase 3):* a short verification "safety code" derived from a hash of both
  DTLS fingerprints, shown on both screens — defeats even a MITM'd server.

## Architecture

```
PC (host)                      Azure WS server                 iPad (guest)
  │  fs-create ───────────────────▶ make room {id}                  │
  │  ◀──────────── fs-created {id}                                   │
  │  show QR(url#r=id) + code                                        │
  │                                            scan QR (native cam)  │
  │                                   fs-join {id} ◀─────────────────│
  │  ◀── fs-peer (host)   lock room   fs-peer (guest) ──────────────▶│
  │  ══ WebRTC offer/answer/ICE relayed via fs-signal {id,data} ════ │
  │  ════════════ encrypted DataChannel (P2P, LAN if possible) ═════ │
  │   file-meta + binary chunks + file-end  ◀══════════════════════▶ │
  │                                              Blob → download → Files
```

Pairing is symmetric after connect: **both peers get the same transfer UI**, so either side can
send or receive (covers PC→iPad and iPad→PC, and iPad↔iPad).

## Files

New page (a Tools-section entry, sits at repo root):

- `fileshare/index.html` — page shell. Loads `app-nav.js` (nav rule), manifest, links the CSS/JS.
  Back button uses `onclick="event.preventDefault(); location.replace('../')"` like other tools.
- `fileshare/fileshare.css` — styles (dark theme matching the hub).
- `fileshare/main.js` — orchestrator: host vs guest mode (by `#r=` hash), UI wiring, picker buttons,
  received-files list + download, status. The receive panel is multi-select: each finished file gets a
  checkbox; "保存到相册 / 分享" hands the selected files to the native share sheet where
  `navigator.canShare({files})` is supported (iOS → "存储 N 张图像" into Photos, or 存储到文件 — files
  stay separate), and "打包 .zip" bundles them into one archive for desktop (one download; Photos isn't
  a desktop concept). A single selected file always saves as-is. Per-file one-tap "保存" links remain.
- `fileshare/zip.js` — minimal store-only (no-compression) ZIP writer, zero deps, for the desktop
  batch download. Builds the archive in memory from the received Blobs; per-file size is uint32 (< 4 GB).
- `fileshare/signaling.js` — thin WS client: `serverUrl()` from
  `../games/mahjong-common-online/server-url.js`; create/join/signal/leave; reconnect-tolerant.
- `fileshare/rtc.js` — `RTCPeerConnection` + DataChannel; chunked file send with backpressure
  (`bufferedAmountLowThreshold`); receive → reassemble Blob; control protocol
  (`file-meta` → binary chunks → `file-end`).
- `fileshare/qr.js` — vendored zero-dependency QR-code generator (offline, no CDN). Host renders the
  join URL into a `<canvas>`.

Server (signaling only — no file bytes touch it):

- `server/fileshare.js` — `fsRooms` Map, `handleFs(client, msg, send)` for
  `fs-create | fs-join | fs-signal | fs-resume | fs-repair | fs-leave`, `fsOnClose(client)` (grace,
  not teardown), and a TTL / disconnect-grace / rate-limit sweep.
- `server/index.js` — wire it: in `handle()` route `msg.type` starting with `fs-` to `handleFs`
  before the lobby switch (mirrors how `action` is handled early); call `fsOnClose` in `ws.on('close')`.
  No change to lobby/table/score plumbing.

Hub + caching:

- `index.html` — add a 文件共享助手 card to the 工具 (Tools) section, with `data-i18n` keys and
  zh/en strings in the `I18N` dict.
- `sw.js` — **bump `CACHE` patch version**; add the new `fileshare/*` files to `ASSETS` (qr.js +
  zip.js too), or offline load breaks. (server-url.js is already cached.)

## Signaling protocol (new `fs-*` message types, isolated from the lobby)

Client→server:
- `{type:'fs-create'}` → server makes a room, replies `{type:'fs-created', room, token}`.
- `{type:'fs-join', room}` → server validates (exists / not expired / not full / rate-ok); on success
  locks the room and sends both peers `{type:'fs-peer', role:'host'|'guest', polite, room, token}`;
  else `{type:'fs-error', code:'gone'|'full'|'rate'}`.
- `{type:'fs-signal', data}` → relayed verbatim to the *other* peer as `{type:'fs-signal', data}`.
- `{type:'fs-resume', room, role, token}` → re-attach after a socket reconnect (screen lock / brief
  background); valid token → both peers re-paired with a fresh `fs-peer`; bad/expired → `fs-peer-gone`.
- `{type:'fs-repair'}` → both sockets up but the P2P link died → server re-issues `fs-peer` to both.
- `{type:'fs-leave'}` → explicit teardown; peer gets `{type:'fs-peer-gone'}`.

**Connection lifetime ≠ socket lifetime.** A signaling-socket drop is benign — iOS freezes the page
(and its WebSocket) on screen-lock or while a download save-sheet is up. So a dropped socket does NOT
end the session: `fsOnClose` keeps the room for `DISCONNECT_GRACE_MS` (120s) and tells the surviving
peer `{type:'fs-peer-stale'}` ("重连中…"). The dropped side reconnects → `fs-resume` (proven by its
per-slot `token`) → both rebuild the WebRTC link. Only an explicit `fs-leave` or a grace timeout ends
the session with `fs-peer-gone`. The client treats every `fs-peer` as "(re)build a fresh PeerLink
now", preserving the transfer list across a recovery.

Server rules: **room id = 9-char case-insensitive alphanumeric** (A–Z 0–9, ≈ 46 bits), normalized to
uppercase server-side; displayed grouped **3-3-3 joined by `-`** (e.g. `AB3-7KP-9QZ`), input ignores
dashes/case. Unclaimed TTL 120s; locked once 2 peers; per-IP join attempts rate-limited; `fsOnClose`
tears down the room and notifies the surviving peer.

WebRTC negotiation uses the **perfect-negotiation** pattern (server tags one peer `polite`) so
either side can be the offerer without glare. ICE: a public STUN server + host candidates (LAN). No
TURN in phase 1 (note: some symmetric-NAT networks then won't connect — bytes never leak, the
connection just fails; TURN is a possible phase-3 add).

## DataChannel file protocol

1. Sender: for each file → `{t:'file-meta', id, name, size, mime}` (JSON), then binary chunks
   (~16 KB) gated on `bufferedAmount` backpressure, then `{t:'file-end', id}`.
2. Receiver: collect chunks per `id` → `Blob([...], {type:mime})` → offer download (`<a download=name>`),
   list it with size + a re-download button. Per-file progress on both ends.

**Large-file caveat:** phase 1 assembles the Blob in memory (a multi-GB video could OOM an iPad).
Phase 3 option: service-worker streaming download (StreamSaver-style) to avoid buffering whole files;
iOS SW-streaming support is imperfect, so it stays a follow-up.

## iPad picker UX

- 选择文件 — `<input type="file" multiple>` → iOS "Browse" (Files: iCloud Drive / On My iPad / providers).
- 选择照片/视频 — `<input type="file" accept="image/*,video/*" multiple>` → iOS "Photo Library".
- Note HEIC photos may arrive as converted JPEG via Safari's picker.
- Desktop also gets a drag-and-drop drop zone.

## Pairing UX — QR **and** code, both required

Two devices, three entry points on the landing page (no `#r=` hash):
- **创建共享 (host):** creates a room, shows **both** a **QR (canvas)** encoding
  `<origin>/fileshare/#r=<id>` **and** the 9-char code rendered uppercase as `AB3-7KP-9QZ`, plus a live
  status ("等待对方加入…").
- **扫码加入 (guest, has camera — iPad):** native iOS Camera scans the host's QR → opens Safari to the
  URL → page sees `#r=<id>` → auto `fs-join`. (Phase 2: in-app camera scan.)
- **输入配对码 (guest, no camera — PC):** since **a PC has no camera it cannot scan**, code entry is
  mandatory. A **9-box input laid out 3×3** (one char per box) with a literal `-` label between the
  three groups; boxes auto-advance on type, accept paste of the whole code, are case-insensitive and
  dash/whitespace-tolerant (the box layout is presentation only — the value sent is the 9 chars).

Either device can be host or guest, so PC↔iPad works both ways. After `fs-peer`: both screens show
"已连接" and reveal the (symmetric) transfer UI; the host's "等待…" panel collapses.

## Phasing

- **Phase 1 (this pass):** server signaling module + wiring; the page (host/guest, QR via canvas,
  native-camera pairing + manual code entry); WebRTC perfect-negotiation + chunked transfer with
  backpressure; receive → browser download; iPad file+photo pickers + desktop drop zone; hub card;
  sw.js bump + ASSETS. Symmetric (both directions).
- **Phase 2:** in-app QR scanning (BarcodeDetector / jsQR); desktop File System Access API
  (`showSaveFilePicker` / fixed Downloads folder).
- **Phase 3:** SAS verification code; TURN relay fallback; SW streaming download for huge files.

## Testing

- Node unit test for `server/fileshare.js`: room create → join locks → third join rejected (`full`);
  TTL expiry; `fs-signal` relays only to the peer; `fsOnClose` notifies + frees. Mirrors existing
  server tests (mute output per repo convention).
- Manual: PC (desktop browser) ↔ iPad on the same WiFi — create on PC, scan on iPad, send a photo
  iPad→PC and a pdf/zip PC→iPad, confirm the iPad file lands in Files → Downloads.

## Out of scope / explicit non-goals

- No server-side file storage (no `Downloads/` dir on Azure — ephemeral anyway).
- Cannot reach the iOS Apple Music library or write to an arbitrary iOS filesystem path.
- Not a true LAN-discovery broadcast (intentionally — avoids Snapdrop-style same-WiFi exposure).
```
