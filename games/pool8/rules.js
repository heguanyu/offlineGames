// 黑八 (American 8-ball, 15 balls) rules engine — pure logic, no DOM. Drives the shared
// pool-common app/physics. Simplified WPA rules for casual play vs the AI:
//   · open table after the break; the first LEGALLY potted ball assigns 实色/花色 groups
//   · fouls: no contact, wrong first contact, scratch, no rail after contact
//     → opponent gets BALL IN HAND, free placement ANYWHERE (自由球)
//   · 8-ball: pot it early → lose; pot it with a scratch → lose; pot it after clearing
//     your group → win. 8 potted on the break is respotted (casual), no called pockets.
import { buildTable } from '../pool-common/geometry.js';

const L = 2.54, W = 1.27, R = 0.028575;      // 9-ft table, 57.15 mm balls
const FOOT_X = L / 4;                        // rack apex spot

const COLORS = {
  1: '#fdb827', 2: '#1565c0', 3: '#e53935', 4: '#6a1b9a', 5: '#f57c00',
  6: '#2e7d32', 7: '#8d2c13', 8: '#141414',
};
const solidOf = (n) => (n > 8 ? n - 8 : n);
const isSolid = (n) => n >= 1 && n <= 7;
const isStripe = (n) => n >= 9 && n <= 15;
const GROUP_LABEL = { solid: '实色球', stripe: '花色球' };

export const rules = {
  id: 'pool8',
  title: '黑八台球',
  subtitle: '15 球 · 你 vs AI · 犯规自由球',
  maxSpeed: 7,
  spec: buildTable({
    L, W, ballR: R,
    cornerR: 0.070, sideR: 0.062, cornerGap: 0.095, sideGap: 0.075,
    kitchenX: -L / 4,                        // head string (break/placement line)
    feltColor: '#2f6e3f', railColor: '#5d3a22', clothLine: '#cfe3cf',
    markings: { kitchen: true, footSpot: FOOT_X },
  }),

  newGame(rand = Math.random) {
    const balls = [{ id: 0, x: -L / 4, y: 0, vx: 0, vy: 0, inPlay: true, color: '#f4f1ea', number: null, stripe: false }];
    // rack: 8 in the middle of row 3, back corners one solid + one stripe, rest shuffled
    const solids = [1, 2, 3, 4, 5, 6, 7], stripes = [9, 10, 11, 12, 13, 14, 15];
    const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    shuffle(solids); shuffle(stripes);
    const order = new Array(15).fill(0);
    order[4] = 8;                            // row-3 middle (position index 4 in row-major triangle)
    order[10] = solids.pop(); order[14] = stripes.pop();  // back-row corners, one of each
    const rest = shuffle([...solids, ...stripes]);
    for (let i = 0; i < 15; i++) if (!order[i]) order[i] = rest.pop();
    let k = 0;
    const step = R * 2 * 1.004, rowX = step * Math.sqrt(3) / 2;
    for (let row = 0; row < 5; row++) {
      for (let i = 0; i <= row; i++) {
        const n = order[k++];
        balls.push({
          id: n, x: FOOT_X + row * rowX, y: (i - row / 2) * step,
          vx: 0, vy: 0, inPlay: true,
          color: COLORS[solidOf(n)], number: n, stripe: isStripe(n),
        });
      }
    }
    return {
      balls,
      state: { turn: 0, groups: null, breakShot: true, inHand: 'kitchen', winner: null },
    };
  },

  // group of `player` (0/1): 'solid' | 'stripe' | null while the table is open
  groupOf(state, player) { return state.groups ? state.groups[player] : null; },

  remaining(state, balls, player) {
    const g = this.groupOf(state, player);
    if (!g) return balls.filter((b) => b.inPlay && b.number && b.number !== 8);
    const test = g === 'solid' ? isSolid : isStripe;
    return balls.filter((b) => b.inPlay && test(b.number));
  },

  // legal first-contact set for the player on turn
  ballOn(state, balls) {
    const mine = this.remaining(state, balls, state.turn);
    if (mine.length) {
      return { ids: mine.map((b) => b.id), label: state.groups ? GROUP_LABEL[this.groupOf(state, state.turn)] : '任意彩球' };
    }
    return { ids: [8], label: '黑8' };
  },

  aiWeight() { return () => 1; },

  // ev: {firstHit, potted[], cuePotted, railAfter}; `on` = ballOn captured BEFORE the shot.
  applyShot(state, balls, ev, on) {
    const me = state.turn, opp = 1 - me;
    const wasOn8 = on.ids.length === 1 && on.ids[0] === 8;
    const potted8 = ev.potted.includes(8);
    const pottedObj = ev.potted.filter((id) => id !== 0 && id !== 8);
    let foul = null;

    if (ev.firstHit === null) foul = '未击中任何球';
    else if (!on.ids.includes(ev.firstHit)) foul = `首先击中了非目标球（应打${on.label}）`;
    else if (ev.cuePotted) foul = '白球落袋';
    else if (!ev.potted.length && !ev.railAfter) foul = '击球后无球碰库';

    // ---- the 8 ball decides games ----
    if (potted8) {
      if (state.breakShot) {                 // casual: respot, play on
        state.breakShot = false;
        return this._next(state, balls, { foul, respot: [8], msg: '开球打进黑8：重置黑8' });
      }
      state.winner = (!wasOn8 || foul) ? opp : me;
      const msg = state.winner === me ? '打进黑8，获胜！' : (wasOn8 ? '打进黑8但犯规，判负' : '提前打进黑8，判负');
      return { msg, foul: !!foul, gameOver: { winner: state.winner, msg }, respot: [], switchTurn: false, ballInHand: null };
    }

    // ---- group assignment (first legal pot on a non-break shot while open) ----
    let msg = '';
    if (!state.groups && !state.breakShot && !foul && pottedObj.length) {
      const g = isSolid(pottedObj[0]) ? 'solid' : 'stripe';
      state.groups = { [me]: g, [opp]: g === 'solid' ? 'stripe' : 'solid' };
      msg = `你方确定为${GROUP_LABEL[g]}`;
      if (me === 1) msg = `AI 确定为${GROUP_LABEL[g]}`;
    }
    state.breakShot = false;

    // continue only after legally potting one of your OWN balls (or any, while open)
    const myGroup = this.groupOf(state, me);
    const pottedMine = pottedObj.some((n) => !myGroup || (myGroup === 'solid' ? isSolid(n) : isStripe(n)));
    return this._next(state, balls, { foul, respot: [], msg, keepTurn: !foul && pottedMine });
  },

  _next(state, balls, { foul, respot, msg, keepTurn = false }) {
    if (foul) {
      state.turn = 1 - state.turn;
      state.inHand = 'anywhere';
      return { msg: `犯规：${foul} → 对方自由球`, foul: true, respot, switchTurn: true, ballInHand: 'anywhere', gameOver: null };
    }
    if (!keepTurn) state.turn = 1 - state.turn;
    state.inHand = null;
    return { msg, foul: false, respot, switchTurn: !keepTurn, ballInHand: null, gameOver: null };
  },

  respotPos(spec, balls, id) {              // 8 back to the foot spot (nudged +x if blocked)
    return { x: FOOT_X, y: 0 };
  },

  scoreboard(state, balls, names) {
    return [0, 1].map((p) => {
      const g = this.groupOf(state, p);
      const left = this.remaining(state, balls, p).length;
      const on8 = state.groups && left === 0;
      return { name: names[p], info: g ? `${GROUP_LABEL[g]} 剩${left}${on8 ? ' · 打黑8' : ''}` : '未定组' };
    });
  },
};
