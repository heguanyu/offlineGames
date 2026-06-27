// 文件共享助手 — the peer link. Wraps an RTCPeerConnection + a single bidirectional DataChannel and
// moves files over it. Bytes go PEER-TO-PEER and are encrypted by WebRTC's mandatory DTLS; the
// signaling server only relayed the handshake. When both devices share a LAN, ICE keeps the transfer
// local.
//
// Uses the "perfect negotiation" pattern so either side can (re)negotiate without glare: the server
// tags one peer `polite` (it yields on an offer collision). The host (impolite) creates the channel,
// which kicks off the initial offer; the guest receives the channel via ondatachannel. Once open the
// channel is symmetric — either side can send files.

const CHUNK = 16 * 1024;          // 16 KB messages — safely under every browser's SCTP message cap
const HIGH_WATER = 8 * 1024 * 1024; // pause sending when this much is buffered
const LOW_WATER = 1 * 1024 * 1024;  // resume once it drains below this
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }]; // public STUN for cross-NAT; LAN uses host candidates

let nextFileId = 1;

export class PeerLink extends EventTarget {
  constructor(signaling, { polite }) {
    super();
    this.sig = signaling;
    this.polite = polite;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.queue = [];          // files awaiting send (one transfer at a time)
    this.sending = false;
    this.incoming = null;     // { id, name, size, mime, parts, received }

    const pc = this.pc = new RTCPeerConnection({ iceServers: ICE });

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.sig.signal({ description: pc.localDescription });
      } catch (e) { /* renegotiation is best-effort */ } finally { this.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.sig.signal({ candidate }); };
    pc.onconnectionstatechange = () => this.dispatchEvent(new CustomEvent('peerstate', { detail: pc.connectionState }));
    pc.ondatachannel = (e) => this._bindChannel(e.channel);

    // The impolite peer (host) opens the channel → triggers the first offer.
    if (!polite) this._bindChannel(pc.createDataChannel('files', { ordered: true }));

    // route relayed SDP/ICE from the other peer
    this._onSignal = (ev) => this._handleSignal(ev.detail.data);
    signaling.addEventListener('fs-signal', this._onSignal);
  }

  async _handleSignal(data) {
    const pc = this.pc;
    try {
      if (data.description) {
        const desc = data.description;
        const collision = desc.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(desc);
        if (desc.type === 'offer') { await pc.setLocalDescription(); this.sig.signal({ description: pc.localDescription }); }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!this.ignoreOffer) throw e; }
      }
    } catch (e) { /* swallow — a failed candidate during glare is expected */ }
  }

  _bindChannel(ch) {
    this.channel = ch;
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = LOW_WATER;
    ch.onopen = () => this._opened();
    ch.onclose = () => this.dispatchEvent(new Event('channelclose'));
    ch.onmessage = (e) => this._onMessage(e.data);
    // A channel arriving via ondatachannel (the receiving peer) can ALREADY be open by the time we
    // attach onopen — in that case the event never fires, so signal 'open' ourselves.
    if (ch.readyState === 'open') this._opened();
  }

  _opened() {
    if (this._openFired) return;
    this._openFired = true;
    this.dispatchEvent(new Event('open'));
    this._pump();
  }

  _onMessage(data) {
    if (typeof data === 'string') {
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.t === 'meta') {
        this.incoming = { id: m.id, name: m.name, size: m.size, mime: m.mime || 'application/octet-stream', parts: [], received: 0 };
        this.dispatchEvent(new CustomEvent('incoming', { detail: { id: m.id, name: m.name, size: m.size, mime: this.incoming.mime } }));
      } else if (m.t === 'end' && this.incoming) {
        const f = this.incoming; this.incoming = null;
        const blob = new Blob(f.parts, { type: f.mime });
        this.dispatchEvent(new CustomEvent('received', { detail: { id: f.id, name: f.name, mime: f.mime, blob } }));
      }
      return;
    }
    // binary chunk → current incoming file
    if (!this.incoming) return;
    this.incoming.parts.push(data);
    this.incoming.received += data.byteLength || data.length || 0;
    this.dispatchEvent(new CustomEvent('progress', { detail: { id: this.incoming.id, dir: 'in', done: this.incoming.received, total: this.incoming.size } }));
  }

  // queue a File/Blob (with .name) for sending; transfers run one at a time
  send(file) {
    const id = nextFileId++;
    this.queue.push({ id, file });
    this.dispatchEvent(new CustomEvent('queued', { detail: { id, name: file.name, size: file.size } }));
    this._pump();
    return id;
  }

  async _pump() {
    if (this.sending || !this.channel || this.channel.readyState !== 'open') return;
    const job = this.queue.shift();
    if (!job) return;
    this.sending = true;
    const { id, file } = job;
    const ch = this.channel;
    ch.send(JSON.stringify({ t: 'meta', id, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' }));
    let offset = 0;
    try {
      while (offset < file.size) {
        if (ch.bufferedAmount > HIGH_WATER) await new Promise((r) => { ch.addEventListener('bufferedamountlow', r, { once: true }); });
        if (ch.readyState !== 'open') throw new Error('channel closed mid-transfer');
        const slice = file.slice(offset, offset + CHUNK);
        const buf = await slice.arrayBuffer();
        ch.send(buf);
        offset += buf.byteLength;
        this.dispatchEvent(new CustomEvent('progress', { detail: { id, dir: 'out', done: offset, total: file.size } }));
      }
      ch.send(JSON.stringify({ t: 'end', id }));
      this.dispatchEvent(new CustomEvent('sent', { detail: { id, name: file.name } }));
    } catch (e) {
      this.dispatchEvent(new CustomEvent('sendfail', { detail: { id, name: file.name } }));
    } finally {
      this.sending = false;
      this._pump(); // next queued file
    }
  }

  close() {
    this.sig.removeEventListener('fs-signal', this._onSignal);
    try { this.channel && this.channel.close(); } catch {}
    try { this.pc.close(); } catch {}
  }
}
