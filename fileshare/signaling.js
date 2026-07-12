// 文件共享助手 — signaling client. A thin auto-reconnecting WebSocket wrapper around the server's
// fs-* pairing relay (server/fileshare.js). It carries ONLY the pairing handshake + WebRTC SDP/ICE;
// no file bytes pass through here. The backend host is the single-source serverUrl() (shared with
// the online lobby) — same Azure origin, different message namespace.
import { serverUrl } from '../games/mahjong-common-online/server-url.js';

export class Signaling extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.url = serverUrl();
    this.retry = null;
    this.closed = false;
  }

  connect() {
    this.closed = false;
    this._open();
  }

  _open() {
    // Drop any prior socket cleanly first, so a forced reconnect() can't leave the old one's
    // onclose scheduling a duplicate retry alongside the fresh connection.
    if (this.ws) { try { this.ws.onclose = null; this.ws.onerror = null; this.ws.close(); } catch {} }
    clearTimeout(this.retry);
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => this.dispatchEvent(new Event('open'));
    this.ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (typeof m.type === 'string' && m.type.startsWith('fs-')) {
        this.dispatchEvent(new CustomEvent(m.type, { detail: m }));
      }
    };
    this.ws.onclose = () => {
      this.dispatchEvent(new Event('close'));
      if (!this.closed) { clearTimeout(this.retry); this.retry = setTimeout(() => this._open(), 1500); }
    };
    this.ws.onerror = () => { try { this.ws.close(); } catch {} };
  }

  send(msg) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }

  create() { this.send({ type: 'fs-create' }); }
  join(room) { this.send({ type: 'fs-join', room }); }
  signal(data) { this.send({ type: 'fs-signal', data }); }
  // re-attach to an existing room after the socket reconnected (screen lock / brief background)
  resume(room, role, token) { this.send({ type: 'fs-resume', room, role, token }); }
  // both sockets up but the P2P link died — ask the server to re-issue the pairing
  repair() { this.send({ type: 'fs-repair' }); }
  leave() { this.send({ type: 'fs-leave' }); }
  // liveness probe (server echoes fs-pong) — used to detect an iOS half-open socket on foreground
  ping() { this.send({ type: 'fs-ping' }); }
  // force a fresh socket now (return-to-foreground): tears down the possibly-dead one and reopens,
  // which fires 'open' → the app re-attaches via fs-resume.
  reconnect() { if (this.closed) return; this._open(); }

  close() { this.closed = true; clearTimeout(this.retry); try { this.ws && this.ws.close(); } catch {} }
}
