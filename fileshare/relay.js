// 文件共享助手 — server-RELAY fallback transport. When WebRTC can't punch through (client/AP
// isolation on the router, symmetric NAT with no reachable STUN, hotel/guest WiFi …) the file
// bytes travel through the signaling WebSocket instead: base64 chunks inside the same opaque
// fs-signal envelope the server already relays verbatim — NO server changes needed. Slower than
// P2P and the bytes do transit the server (still TLS on both legs), but it always connects.
//
// Same event surface as PeerLink (open/queued/sent/sendfail/incoming/received/progress), so
// main.js swaps one for the other. Flow control is a simple ack window: the receiver acks every
// chunk, the sender keeps at most WINDOW chunks in flight.

import { FileSink, INLINE_MAX } from './recv-store.js';

const CHUNK = 32 * 1024;
const WINDOW = 6;

function b64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}

let nextFileId = 1000000; // separate id-space from PeerLink so a mid-session switch can't collide

export class RelayLink extends EventTarget {
  constructor(signaling) {
    super();
    this.sig = signaling;
    this.queue = [];
    this.sending = false;
    this.incoming = null;
    this._inflight = 0;
    this._ackWait = null;      // resolver the pump parks on while the window is full
    this._onSignal = (ev) => this._handle(ev.detail.data);
    signaling.addEventListener('fs-signal', this._onSignal);
    setTimeout(() => this.dispatchEvent(new Event('open')), 0);  // no handshake — usable at once
  }

  _handle(data) {
    const m = data && data.relay;
    if (!m) return;
    if (m.t === 'meta') {
      const mime = m.mime || 'application/octet-stream';
      const inline = !(m.size > INLINE_MAX); // large files stream to IndexedDB, not memory (see rtc.js)
      this.incoming = {
        id: m.id, name: m.name, size: m.size, mime, received: 0, inline,
        parts: inline ? [] : null,
        sink: inline ? null : new FileSink({ id: m.id, name: m.name, size: m.size, mime }),
      };
      this.dispatchEvent(new CustomEvent('incoming', { detail: { id: m.id, name: m.name, size: m.size, mime } }));
    } else if (m.t === 'chunk' && this.incoming) {
      const buf = unb64(m.d);
      if (this.incoming.inline) this.incoming.parts.push(buf);
      else this.incoming.sink.push(buf);
      this.incoming.received += buf.byteLength;
      this.sig.signal({ relay: { t: 'ack', id: m.id, seq: m.seq } });
      this.dispatchEvent(new CustomEvent('progress', { detail: { id: this.incoming.id, dir: 'in', done: this.incoming.received, total: this.incoming.size } }));
    } else if (m.t === 'end' && this.incoming) {
      const f = this.incoming; this.incoming = null;
      this._finish(f);
    } else if (m.t === 'ack') {
      this._inflight--;
      if (this._ackWait) { const r = this._ackWait; this._ackWait = null; r(); }
    }
  }

  // Finalize a received file: inline → Blob; streamed → flush to IndexedDB (saved via the SW stream).
  async _finish(f) {
    if (f.inline) {
      const blob = new Blob(f.parts, { type: f.mime });
      this.dispatchEvent(new CustomEvent('received', { detail: { id: f.id, name: f.name, mime: f.mime, size: f.size, blob } }));
      return;
    }
    try {
      await f.sink.finish();
      this.dispatchEvent(new CustomEvent('received', { detail: { id: f.id, name: f.name, mime: f.mime, size: f.size } }));
    } catch (e) {
      this.dispatchEvent(new CustomEvent('received', { detail: { id: f.id, name: f.name, mime: f.mime, size: f.size, error: true } }));
    }
  }

  send(file) {
    const id = nextFileId++;
    this.queue.push({ id, file });
    this.dispatchEvent(new CustomEvent('queued', { detail: { id, name: file.name, size: file.size } }));
    this._pump();
    return id;
  }

  async _pump() {
    if (this.sending) return;
    const job = this.queue.shift();
    if (!job) return;
    this.sending = true;
    const { id, file } = job;
    this.sig.signal({ relay: { t: 'meta', id, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' } });
    let offset = 0, seq = 0;
    try {
      while (offset < file.size) {
        while (this._inflight >= WINDOW) await new Promise((r) => { this._ackWait = r; });
        if (this._dead || !(this.sig.ws && this.sig.ws.readyState === WebSocket.OPEN)) throw new Error('relay socket down');
        const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
        this.sig.signal({ relay: { t: 'chunk', id, seq: seq++, d: b64(buf) } });
        this._inflight++;
        offset += buf.byteLength;
        this.dispatchEvent(new CustomEvent('progress', { detail: { id, dir: 'out', done: offset, total: file.size } }));
      }
      while (this._inflight > 0) await new Promise((r) => { this._ackWait = r; });  // drain
      this.sig.signal({ relay: { t: 'end', id } });
      this.dispatchEvent(new CustomEvent('sent', { detail: { id, name: file.name } }));
    } catch (e) {
      this.dispatchEvent(new CustomEvent('sendfail', { detail: { id, name: file.name } }));
    } finally {
      this.sending = false;
      this._pump();
    }
  }

  close() {
    this._dead = true;
    this.sig.removeEventListener('fs-signal', this._onSignal);
    if (this._ackWait) { const r = this._ackWait; this._ackWait = null; r(); }
  }
}
