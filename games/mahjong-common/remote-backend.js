// The reusable client network layer, shared by every mahjong variant. One WebSocket carries
// server → client { type:'game', ev, view } frames; each is queued and fed through an AWAITED
// handler so the UI finishes its animation before the next frame lands (a fast server can't
// outrun the table). The transport, reconnect-by-uid, spectator gating and the action senders
// are game-agnostic; the ONLY per-game parts are how a server view is rebuilt into the GameView
// the UI renders and how a server event is mapped to the UI event — injected as `mappers`.
//
//   new RemoteBackendBase(config, { buildView, mapEvent })
//
// 天津 (games/mahjong-tianjin/backend.js) and 国标 each pass their own mappers; everything else —
// connect/dispose/reconnect, getState/onEvent, and discard/claim/pass/selfKong/declareWin/
// decideLaZhuang/next/unready/dealDone — is identical, so a new game reuses this verbatim.
export class RemoteBackendBase {
  constructor(config = {}, mappers = {}) {
    this.url = config.url;
    this.uid = config.uid;
    this.name = config.name || '';
    // Spectator (viewer mode): { table, seat } of the human seat to watch. hello asks the server to
    // spectate that seat and EVERY action is suppressed — a pure, read-only viewer.
    this.spectate = config.spectate || null;
    this._buildView = mappers.buildView;
    this._mapEvent = mappers.mapEvent;
    this._handler = null;
    this._view = null;       // last GameView, rotated to our seat
    this._ws = null;
    this._seat = 0;          // our absolute seat at the table
    this._closed = false;
    this._reconnect = null;
    this._queue = Promise.resolve();
  }

  onEvent(handler) { this._handler = handler; }
  getState() { return this._view; }
  get yourSeat() { return this._seat; }

  connect() {
    this._closed = false;
    const ws = this._ws = new WebSocket(this.url);
    ws.onopen = () => this._send({ type: 'hello', uid: this.uid, name: this.name, ...(this.spectate ? { spectate: this.spectate } : {}) });
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'noGame') { if (this._handler) this._handler({ type: 'gameGone' }); return; } // no live game on this socket → the UI returns to the lobby
      if (m.type === 'game') this._queue = this._queue.then(() => this._process(m)).catch((err) => console.error('[remote] frame processing failed:', err));
    };
    ws.onclose = () => { if (!this._closed) { clearTimeout(this._reconnect); this._reconnect = setTimeout(() => this.connect(), 1500); if (this._handler) this._handler({ type: 'disconnected' }); } };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  dispose() { this._closed = true; clearTimeout(this._reconnect); if (this._ws) try { this._ws.close(); } catch {} this._ws = null; this._handler = null; }

  _send(m) { if (this._ws && this._ws.readyState === 1) this._ws.send(JSON.stringify(m)); }
  // A spectator never acts — gating here makes every action method a no-op, so the viewer can click
  // the live UI without ever affecting the game.
  _act(a) { if (this.spectate) return; this._send({ type: 'action', ...a }); }

  async _process(frame) {
    this._seat = frame.view.yourSeat;
    this._view = this._buildView(frame.view, this._seat);
    const ev = this._mapEvent(frame.ev, this._seat, this._view);
    if (ev && this._handler) await this._handler(ev);
  }

  // Actions — tiles/kinds aren't seat-relative, so they pass through; only seat indices rotate
  // (server-side). `option` carries a 吃 (chow) choice for games that have it; 天津 ignores it.
  async discard(tile) { this._act({ do: 'discard', tile }); }
  async claim(type, option) { this._act({ do: 'claim', claim: type, ...(option ? { option } : {}) }); }
  async pass() { this._act({ do: 'pass' }); }
  async selfKong(kind) { this._act({ do: 'selfKong', kind }); }
  async declareWin() { this._act({ do: 'win' }); }
  decideLaZhuang(yes) { this._act({ do: 'lazhuang', yes }); }
  next() { this._act({ do: 'next' }); }
  unready() { this._act({ do: 'unready' }); } // cancel "我准备好了" before the next hand deals
  dealDone() { this._act({ do: 'dealDone' }); } // my deal animation finished — the server may now drive the bots
}
