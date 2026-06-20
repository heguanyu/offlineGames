// Card selection for 掼蛋 — a small, swappable module. 掼蛋 combos lean on the ♥-level wildcards
// (逢人配), so the human needs PRECISE control over exactly which cards (and which wild) go into a
// play; an over-clever "build the combo for me" tap would fight that. So selection here is direct:
//   • tap a card → toggle it in/out of the selection
//   • swipe across cards → paint them on/off (direction set by the first card's state)
// main.js validates the selection against the engine (wild-aware) and only enables 出牌 when it
// forms a legal play; a 提示 button cycles through the actual legal moves for help.
export class SmartSelection {
  constructor() { this.selected = new Set(); this.hand = []; }
  setHand(hand) { this.hand = hand; }
  clear() { this.selected.clear(); }
  has(id) { return this.selected.has(id); }
  get ids() { return [...this.selected]; }
  set(ids) { this.selected = new Set(ids); }
  paint(id, on) { if (on) this.selected.add(id); else this.selected.delete(id); }
  tap(id) { if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id); }
}
