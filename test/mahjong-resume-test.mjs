// Unit test for Game.serialize() / Game.restore() — the online server's mid-hand resume across a
// restart (Option B). Drives a deterministic (seeded) hand to mid-play, round-trips the live state
// through JSON, and asserts the restored Game is byte-identical AND keeps playing identically.
// Usage: node test/mahjong-resume-test.mjs
import { Game, PHASE } from '../games/mahjong-tianjin/engine.js';

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.error('  FAIL:', msg); } };
const fp = (g) => JSON.stringify(g.serialize());                 // full-state fingerprint
const roundTrip = (g) => Game.restore(JSON.parse(JSON.stringify(g.serialize()))); // through the wire

// deterministic rng so the deal (and thus the whole drive) is reproducible
function mulberry32(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// one ply on g with a FIXED policy (discard the first non-wild; pass every claim; never declare a
// win) so two copies of the same game advance identically. Returns false once the hand is over.
function ply(g) {
  if (g.phase === PHASE.OVER) return false;
  if (g.phase === PHASE.AWAIT_CLAIM) { g.passClaim(); return true; }
  const tile = g.hands[g.turn].find((t) => !g.isWild(t));
  if (tile == null) return false; // (all wilds — vanishingly unlikely; stop)
  g.discard(g.turn, tile);
  return true;
}

console.log('serialize/restore round-trip:');
const g = new Game({ rng: mulberry32(1), dealer: 1, prevailingWind: 2, scores: [3, -1, 5, -7], seatBase: 1, laZhuang: [0, 3] });

// drive a handful of plies into the hand, capturing the first AWAIT_CLAIM we pass through (seed 1
// reaches one at ply 5), and stopping mid-hand.
let sawClaim = null;
for (let i = 0; i < 8; i++) {
  if (g.phase === PHASE.AWAIT_CLAIM && !sawClaim) sawClaim = fp(g);   // capture a claim-pending moment
  if (!ply(g)) break;
}

// we should be mid-hand (a real in-progress decision point), not over
ok(g.phase === PHASE.AWAIT_DISCARD || g.phase === PHASE.AWAIT_CLAIM, `mid-hand after the drive (phase=${g.phase})`);
ok(g.drawnTile != null || g.phase === PHASE.AWAIT_CLAIM, 'a fresh draw is pending (or a claim is)');

// 1) round-trip is byte-identical
const before = fp(g);
const r = roundTrip(g);
ok(fp(r) === before, 'restored full state is byte-identical to the original');

// 2) the transient decision state (NOT serialized — recomputed) is reproduced
ok((g.claim == null) === (r.claim == null), 'claim presence matches');
if (g.claim && r.claim) ok(g.claim.player === r.claim.player && g.claim.options.join() === r.claim.options.join(), 'claim player/options match');
ok((g.selfDrawWin == null) === (r.selfDrawWin == null), 'pending self-draw 胡 presence matches');
ok(JSON.stringify(g.selfKongOptions(g.turn)) === JSON.stringify(r.selfKongOptions(r.turn)), 'self-kong options match');
ok(g.seatWind(0) === r.seatWind(0) && g.isWild(g.wilds[0]) === r.isWild(r.wilds[0]), 'derived seatWind/isWild match');

// 3) the restored game keeps playing IDENTICALLY (continued play is rng-free → must stay in lockstep)
let lockstep = true;
for (let i = 0; i < 20; i++) {
  const a = ply(g), b = ply(r);
  if (a !== b || fp(g) !== fp(r)) { lockstep = false; break; }
  if (!a) break;
}
ok(lockstep, 'original and restored advance in lockstep through continued play');

// 4) a restore from an AWAIT_CLAIM moment also round-trips byte-identically
if (sawClaim) {
  const rc = roundTrip(Game.restore(JSON.parse(sawClaim)));
  ok(fp(rc) === sawClaim, 'AWAIT_CLAIM moment round-trips byte-identically');
} else {
  console.log('  (no AWAIT_CLAIM encountered with this seed — skipped that sub-check)');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error('MAHJONG RESUME TEST FAIL'); process.exit(1); }
console.log('MAHJONG RESUME TEST PASS');
