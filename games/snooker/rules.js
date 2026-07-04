// 斯诺克 (snooker) rules engine — pure logic, no DOM, on the shared pool-common engine.
// Full-size 12-ft table (bigger than 黑八's 9-ft — the shared geometry is parameterized),
// smaller balls, tighter pockets. Casual simplifications, noted inline:
//   · red → colour alternation; colours respot while reds remain; then colours in order
//   · fouls score max(4, ball-on value, ball involved) to the opponent; play continues
//     from where the balls lie; a potted cue ball returns IN-HAND IN THE D
//   · no "free ball" nomination and no miss-rule re-plays (casual)
//   · tie after the black → black respots, next pot wins
import { buildTable } from '../pool-common/geometry.js';

const L = 3.569, W = 1.778, R = 0.02625;     // 12-ft table, 52.5 mm balls
const BAULK_X = -L / 2 + 0.737, D_R = 0.292;
const PINK_X = L / 4, BLACK_X = L / 2 - 0.324;

// colours: id → {value, color, label, spot}
const COLOURS = {
  16: { value: 2, color: '#f2c235', label: '黄', spot: { x: BAULK_X, y: +D_R } },
  17: { value: 3, color: '#1f7a33', label: '绿', spot: { x: BAULK_X, y: -D_R } },
  18: { value: 4, color: '#7b4a21', label: '棕', spot: { x: BAULK_X, y: 0 } },
  19: { value: 5, color: '#1c56c7', label: '蓝', spot: { x: 0, y: 0 } },
  20: { value: 6, color: '#e0559b', label: '粉', spot: { x: PINK_X, y: 0 } },
  21: { value: 7, color: '#181818', label: '黑', spot: { x: BLACK_X, y: 0 } },
};
const isRed = (id) => id >= 1 && id <= 15;
const val = (id) => (isRed(id) ? 1 : (COLOURS[id] ? COLOURS[id].value : 0));

export const rules = {
  id: 'snooker',
  title: '斯诺克',
  subtitle: '15 红球 + 6 彩球 · 你 vs AI',
  maxSpeed: 6.5,
  spec: buildTable({
    L, W, ballR: R,
    cornerR: 0.056, sideR: 0.052, cornerGap: 0.082, sideGap: 0.068,
    baulkX: BAULK_X, dR: D_R,
    feltColor: '#1e7a41', railColor: '#4a2c16', clothLine: '#d9ead9',
    markings: { baulk: true, spots: Object.values(COLOURS).map((c) => c.spot) },
  }),

  newGame(rand = Math.random) {
    const balls = [{ id: 0, x: BAULK_X - D_R * 0.4, y: D_R * 0.5, vx: 0, vy: 0, inPlay: true, color: '#f4f1ea', number: null, stripe: false }];
    const step = R * 2 * 1.005, rowX = step * Math.sqrt(3) / 2;
    let id = 1;
    const apexX = PINK_X + R * 2 + 0.006;    // reds racked just behind the pink
    for (let row = 0; row < 5; row++) {
      for (let i = 0; i <= row; i++) {
        balls.push({ id: id++, x: apexX + row * rowX, y: (i - row / 2) * step, vx: 0, vy: 0, inPlay: true, color: '#b71c1c', number: null, stripe: false, red: true });
      }
    }
    for (const [cid, c] of Object.entries(COLOURS)) {
      balls.push({ id: +cid, x: c.spot.x, y: c.spot.y, vx: 0, vy: 0, inPlay: true, color: c.color, number: null, stripe: false, label: c.label });
    }
    return {
      balls,
      state: {
        turn: 0, scores: [0, 0], breakShot: true, winner: null,
        phase: 'reds',            // 'reds' → red/colour alternation; 'colours' → in order
        mustColour: false,        // a red was just potted → a colour is on
        colourIdx: 16,            // next colour on in the 'colours' phase
        inHand: 'D',
      },
    };
  },

  redsLeft(balls) { return balls.filter((b) => b.inPlay && isRed(b.id)); },

  ballOn(state, balls) {
    if (state.phase === 'reds') {
      if (state.mustColour) return { ids: Object.keys(COLOURS).map(Number).filter((id) => balls.find((b) => b.id === id).inPlay), label: '彩球' };
      return { ids: this.redsLeft(balls).map((b) => b.id), label: '红球' };
    }
    return { ids: [state.colourIdx], label: COLOURS[state.colourIdx].label + '球' };
  },

  aiWeight(state) { return (id) => val(id); },  // when a colour is on, prefer the big ones

  applyShot(state, balls, ev, on) {
    const me = state.turn, opp = 1 - me;
    const onValue = state.phase === 'colours' ? val(state.colourIdx) : (state.mustColour ? 7 : 1);
    let foulVal = 0;
    const reasons = [];

    if (ev.firstHit === null) { foulVal = Math.max(4, onValue); reasons.push('未击中任何球'); }
    else if (!on.ids.includes(ev.firstHit)) {
      foulVal = Math.max(4, onValue, val(ev.firstHit));
      reasons.push(`首先击中了${isRed(ev.firstHit) ? '红球' : COLOURS[ev.firstHit]?.label + '球'}（应打${on.label}）`);
    }
    if (ev.cuePotted) { foulVal = Math.max(foulVal, 4, onValue); reasons.push('白球落袋'); }
    const wrongPots = ev.potted.filter((id) => id !== 0 && !on.ids.includes(id));
    if (wrongPots.length) {
      foulVal = Math.max(foulVal, 4, ...wrongPots.map(val));
      reasons.push('打进了非目标球');
    }
    const foul = foulVal > 0;

    const pottedReds = ev.potted.filter(isRed);
    const pottedColours = ev.potted.filter((id) => COLOURS[id]);
    const respot = [];
    let msg = '', points = 0;

    if (!foul) {
      if (state.phase === 'reds') {
        if (state.mustColour) {              // a colour was on
          if (pottedColours.length) {
            points = val(pottedColours[0]);
            if (this.redsLeft(balls).length) respot.push(pottedColours[0]);
            else { state.phase = 'colours'; state.colourIdx = 16; respot.push(pottedColours[0]); }
          }
          state.mustColour = false;
        } else if (pottedReds.length) {      // reds stay down, 1 each
          points = pottedReds.length;
          state.mustColour = true;
        }
        if (!this.redsLeft(balls).length && !state.mustColour && !pottedColours.length && state.phase === 'reds') {
          state.phase = 'colours'; state.colourIdx = 16;   // reds ran out on a miss
        }
      } else {                               // colours in order
        if (pottedColours.includes(state.colourIdx)) {
          points = val(state.colourIdx);
          state.colourIdx += 1;
        }
      }
      state.scores[me] += points;
      if (points) msg = `+${points} 分`;
    } else {
      // foul: reds potted stay down; colours potted come back
      for (const c of pottedColours) respot.push(c);
      if (state.mustColour) state.mustColour = false;      // a foul ends the red→colour chain
      // reds may have been wiped out by the foul shot — advance the phase
      if (state.phase === 'reds' && !this.redsLeft(balls).length) { state.phase = 'colours'; state.colourIdx = 16; }
      state.scores[opp] += foulVal;
      msg = `犯规：${reasons.join('，')} → 对方 +${foulVal} 分`;
    }
    state.breakShot = false;

    // frame over: the black is down (colourIdx past 21) — or it went down legally
    if (state.phase === 'colours' && state.colourIdx > 21) {
      if (state.scores[0] === state.scores[1]) {           // tie → respot the black, next pot wins
        respot.push(21); state.colourIdx = 21;
        msg += '（平分：黑球重置）';
      } else {
        state.winner = state.scores[0] > state.scores[1] ? 0 : 1;
        return { msg, foul, respot, switchTurn: false, ballInHand: null, gameOver: { winner: state.winner, msg: `${state.scores[0]} : ${state.scores[1]}` } };
      }
    }

    const keepTurn = !foul && points > 0;
    if (!keepTurn) state.turn = opp;
    const ballInHand = ev.cuePotted ? 'D' : null;
    state.inHand = ballInHand;
    return { msg, foul, respot, switchTurn: !keepTurn, ballInHand, gameOver: null };
  },

  respotPos(spec, balls, id) {
    return COLOURS[id] ? COLOURS[id].spot : { x: PINK_X, y: 0 };
  },

  scoreboard(state, balls, names) {
    const reds = this.redsLeft(balls).length;
    const on = state.phase === 'reds' ? (state.mustColour ? '彩球' : `红球×${reds}`)
      : (COLOURS[state.colourIdx] ? COLOURS[state.colourIdx].label + '球' : '');
    return [0, 1].map((p) => ({
      name: names[p],
      info: `${state.scores[p]} 分${state.winner == null && state.turn === p && on ? ' · 打' + on : ''}`,
    }));
  },
};
