// Unit test for the 斗地主 RemoteBackend client mappers (games/doudizhu/backend.js): seat ROTATION
// (server absolute seats → my-relative, seat 0 = me) and the GameView methods the UI relies on
// (validatePlay / roleOf). Drives the shared transport's frame pipeline (RemoteBackendBase._process)
// directly — no socket, no browser. Usage: node test/doudizhu-online-mappers-test.mjs
import { RemoteBackend } from '../games/doudizhu/backend.js';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('  FAIL:', m); fails++; } };

// I am ABSOLUTE seat 1. Relative rotation r(s) = (s - 1 + 3) % 3 → seat1→0(me), seat2→1, seat0→2.
const rb = new RemoteBackend({ url: 'ws://test', uid: 'u', name: '阿斗' });
let lastEv = null;
rb.onEvent((ev) => { lastEv = ev; });

const baseView = {
  yourSeat: 1, phase: 'play', turn: 1, bidTurn: -1, highBid: 0, bid: 2, landlord: 1,
  lead: null, leadSeat: 1, bombs: 0, landlordPlays: 1, peasantPlayed: false,
  handCounts: [5, 6, 7],                              // absolute: seat0=5, seat1(me)=6, seat2=7
  hands: { 1: [{ id: 10, rank: 5, suit: 0 }, { id: 11, rank: 5, suit: 1 }, { id: 12, rank: 9, suit: 2 }] },
  bottom: null, scores: [3, -1, -2], playLog: [{ seat: 0, move: { type: 'single' }, ranks: [7] }],
  result: null,
};

// ---- a 'play' by absolute seat 2 → relative seat 1 -------------------------
await rb._process({ view: { ...baseView }, ev: { t: 'play', seat: 2, cardIds: [], cards: [], move: { type: 'single', rank: 9 } } });
ok(lastEv && lastEv.type === 'play', "play event mapped");
ok(lastEv && lastEv.seat === 1, `play seat rotated 2→1 (got ${lastEv && lastEv.seat})`);

const g = rb.getState();
ok(g.hands[0] && g.hands[0][0].rank === 5, "my hand is at relative index 0");
ok(g.turn === 0, `turn rotated 1→0 (got ${g.turn})`);
ok(g.landlord === 0, `landlord rotated 1→0 (got ${g.landlord})`);
ok(g.leadSeat === 0, `leadSeat rotated 1→0 (got ${g.leadSeat})`);
ok(g.handCounts[0] === 6 && g.handCounts[1] === 7 && g.handCounts[2] === 5, `handCounts rotated to [me,next,prev] (got ${JSON.stringify(g.handCounts)})`);
ok(g.scores[0] === -1 && g.scores[1] === -2 && g.scores[2] === 3, `scores rotated (got ${JSON.stringify(g.scores)})`);
ok(g.playLog[0].seat === 2, `playLog seat rotated 0→2 (got ${g.playLog[0].seat})`);

// ---- view methods: roleOf + validatePlay ----------------------------------
ok(g.roleOf(0) === 1, "roleOf(me)=landlord (1)");
ok(g.roleOf(1) === 0, "roleOf(other)=peasant (0)");
// it IS my turn (rel turn 0) and I lead (leadSeat 0) → a pair of 5s is legal; a non-held card is not
ok(g.validatePlay(0, [10, 11]) && g.validatePlay(0, [10, 11]).type === 'pair', "validatePlay accepts my pair of 5s");
ok(g.validatePlay(0, [10, 12]) === null, "validatePlay rejects a non-pair (5+9)");
ok(g.validatePlay(0, [999]) === null, "validatePlay rejects a card not in hand");

// ---- a 'bid' await for ME (absolute seat 1) → an 'askBid' UI event ---------
await rb._process({ view: { ...baseView, phase: 'bid', bidTurn: 1 }, ev: { t: 'await', who: 'bid', seat: 1, highBid: 0, timeout: 30000, total: 30000 } });
ok(lastEv && lastEv.type === 'askBid', `my bid-await → askBid (got ${lastEv && lastEv.type})`);
// an await for ANOTHER seat → a 'turn' hint (not askBid/await)
await rb._process({ view: { ...baseView, phase: 'bid', bidTurn: 2 }, ev: { t: 'await', who: 'bid', seat: 2, highBid: 1, timeout: 30000, total: 30000 } });
ok(lastEv && lastEv.type === 'turn' && lastEv.seat === 1, `other seat's bid-await → turn hint (got ${JSON.stringify(lastEv)})`);

// ---- 'over' result rotation -----------------------------------------------
const result = { winner: 1, landlord: 1, landlordWon: true, bid: 2, bombs: 0, spring: false, antiSpring: false, multiplier: 1, total: 2, delta: [-2, 4, -2] };
await rb._process({ view: { ...baseView, phase: 'over', result, hands: { 0: [], 1: [], 2: [] } }, ev: { t: 'over', result, matchEnd: true } });
ok(lastEv && lastEv.type === 'over', "over event mapped");
ok(lastEv && lastEv.matchEnd === true, "over carries matchEnd");
ok(lastEv && lastEv.result && lastEv.result.winner === 0 && lastEv.result.landlord === 0, `result seats rotated (winner ${lastEv && lastEv.result && lastEv.result.winner})`);
ok(lastEv && lastEv.result && lastEv.result.delta[0] === 4, `result delta rotated to me (got ${lastEv && lastEv.result && JSON.stringify(lastEv.result.delta)})`);

rb.dispose();
if (fails) { console.error(`DOU ONLINE MAPPERS TEST FAIL (${fails})`); process.exit(1); }
console.log('DOU ONLINE MAPPERS TEST PASS');
