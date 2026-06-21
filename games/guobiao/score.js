// 国标麻将 (Chinese Official / MCR) fan scoring. Pure + Node-testable.
//
// This implements a substantial, commonly-occurring SUBSET of the official 81
// fans (not all 81), with the major non-repeat exclusions applied. The minimum
// to win is 8 fan (起和8番) — enforced by the engine, not here. Tile ids follow
// the shared model in ../mahjong-common/engine-core.js.
import { suitOf, rankOf, isNumberSuit } from '../mahjong-common/engine-core.js';

const isHonor = (id) => id >= 27;
const isWind = (id) => id >= 27 && id < 31;       // 东南西北 = 0..3
const isDragon = (id) => id >= 31;                 // 中發白
const isTerminal = (id) => isNumberSuit(id) && (rankOf(id) === 1 || rankOf(id) === 9);
const isTermHonor = (id) => isHonor(id) || isTerminal(id);
const windRank = (id) => id - 27;                  // 0=东.. for round/seat compare

// A "meld" here: { type: 'chow'|'pung'|'kong', tiles:[ids], concealed:bool }.
// `pair` is a single kind id. ctx: { selfDraw, winningTile, roundWind, seatWind,
// lastTile, afterKong, concealedHand (no claimed melds), winByDiscard }.
export function scoreStandard(melds, pair, ctx) {
  const fans = [];
  const add = (name, points) => fans.push({ name, points });
  const has = (n) => fans.some((f) => f.name === n);
  const drop = (...names) => { for (const n of names) { const i = fans.findIndex((f) => f.name === n); if (i >= 0) fans.splice(i, 1); } };

  const chows = melds.filter((m) => m.type === 'chow');
  const pungs = melds.filter((m) => m.type === 'pung' || m.type === 'kong');
  const kongs = melds.filter((m) => m.type === 'kong');
  const concealedPungs = pungs.filter((m) => m.concealed);
  const allTiles = melds.flatMap((m) => m.tiles).concat([pair, pair]);

  const numSuits = new Set(allTiles.filter(isNumberSuit).map(suitOf));
  const hasHonorTile = allTiles.some(isHonor);
  const cats = new Set(allTiles.map((id) => (isWind(id) ? 'w' : isDragon(id) ? 'd' : suitOf(id))));

  // ---- suit composition ----
  if (allTiles.every(isHonor)) add('字一色', 88);
  else if (numSuits.size === 1 && !hasHonorTile) add('清一色', 24);
  else if (numSuits.size === 1 && hasHonorTile) add('混一色', 6);

  // ---- terminal / honor composition ----
  const allTermHonor = allTiles.every(isTermHonor);
  if (allTermHonor && !has('字一色')) {
    if (allTiles.every((id) => isNumberSuit(id))) add('清幺九', 88);     // pure terminals
    else add('混幺九', 16);
  } else if (allTiles.every((id) => isNumberSuit(id) && rankOf(id) >= 2 && rankOf(id) <= 8)) {
    add('断幺', 2);
  }
  // 全带幺: every set + pair has a terminal/honor (and not the stronger all-termhonor)
  if (!allTermHonor && melds.every((m) => m.tiles.some(isTermHonor)) && isTermHonor(pair)) add('全带幺', 4);

  // ---- pungs: dragons / winds / terminals ----
  const dragonPungs = pungs.filter((m) => isDragon(m.tiles[0]));
  const windPungs = pungs.filter((m) => isWind(m.tiles[0]));
  if (dragonPungs.length === 3) add('大三元', 88);
  else if (dragonPungs.length === 2 && isDragon(pair)) add('小三元', 64);
  if (windPungs.length === 4) add('大四喜', 88);
  else if (windPungs.length === 3 && isWind(pair)) add('小四喜', 64);

  // 碰碰和 (all pungs)
  if (chows.length === 0 && pungs.length === 4) add('碰碰和', 6);

  // concealed pungs
  if (concealedPungs.length === 4) add('四暗刻', 64);
  else if (concealedPungs.length === 3) add('三暗刻', 16);
  else if (concealedPungs.length === 2) add('双暗刻', 2);

  // individual honor/terminal pungs (counted unless absorbed by the big honors)
  if (!has('大三元')) {
    let jian = 0;
    for (const m of dragonPungs) jian++;
    if (has('小三元')) jian = Math.max(0, jian - 0); // 小三元 already includes the 2 dragon pungs' value
    else for (let i = 0; i < jian; i++) add('箭刻', 2);
  }
  if (!has('大四喜') && !has('小四喜')) {
    for (const m of windPungs) {
      if (windRank(m.tiles[0]) === ctx.roundWind) add('圈风刻', 2);
      else if (windRank(m.tiles[0]) === ctx.seatWind) add('门风刻', 2);
      else add('幺九刻', 1);
    }
  }
  if (!has('清幺九') && !has('混幺九')) {
    for (const m of pungs) if (isTerminal(m.tiles[0])) add('幺九刻', 1);
  }

  // ---- chow patterns ----
  const cinfo = chows.map((m) => ({ suit: suitOf(m.tiles[0]), start: rankOf(m.tiles[0]) }));
  const bySuit = { m: [], p: [], s: [] };
  for (const c of cinfo) bySuit[c.suit].push(c.start);
  for (const s of ['m', 'p', 's']) bySuit[s].sort((a, b) => a - b);
  // 三色三同顺: same start in all three suits
  for (let st = 1; st <= 7; st++) {
    if (bySuit.m.includes(st) && bySuit.p.includes(st) && bySuit.s.includes(st)) { add('三色三同顺', 8); break; }
  }
  // 三色三步高: one chow per suit, starts consecutive (step 1)
  if (!has('三色三同顺')) {
    outer: for (const a of bySuit.m) for (const b of bySuit.p) for (const c of bySuit.s) {
      const ss = [a, b, c].sort((x, y) => x - y);
      if (ss[1] === ss[0] + 1 && ss[2] === ss[1] + 1) { add('三色三步高', 6); break outer; }
    }
  }
  // 花龙: 1-2-3 / 4-5-6 / 7-8-9 spread across the three suits (one each, any order)
  {
    const starts = { m: new Set(bySuit.m), p: new Set(bySuit.p), s: new Set(bySuit.s) };
    const perms = [['m', 'p', 's'], ['m', 's', 'p'], ['p', 'm', 's'], ['p', 's', 'm'], ['s', 'm', 'p'], ['s', 'p', 'm']];
    if (perms.some(([a, b, c]) => starts[a].has(1) && starts[b].has(4) && starts[c].has(7))) add('花龙', 8);
  }
  // 一色三同顺 / 一色三步高 (same suit)
  for (const s of ['m', 'p', 's']) {
    const arr = bySuit[s];
    const counts = {};
    for (const st of arr) counts[st] = (counts[st] || 0) + 1;
    if (Object.values(counts).some((n) => n >= 3)) { add('一色三同顺', 24); }
    else if (arr.length >= 3) {
      for (let st = 1; st <= 5; st++) if (arr.includes(st) && arr.includes(st + 1) && arr.includes(st + 2)) { add('一色三步高', 16); break; }
    }
  }
  // small chow fans (count once each occurrence, lightly)
  for (const s of ['m', 'p', 's']) {
    const arr = bySuit[s];
    const seen = new Set();
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const d = arr[j] - arr[i];
      if (d === 0 && !has('一色三同顺') && !seen.has('1' + arr[i])) { add('一般高', 1); seen.add('1' + arr[i]); }
      else if (d === 3 && arr[i] === 1 && arr[j] === 7) add('老少副', 1);  // 123 + 789
      else if (d === 3) add('连六', 1);                                     // 123 + 456 etc.
    }
  }
  // 喜相逢: identical chow in two different suits
  for (let st = 1; st <= 7; st++) {
    const k = ['m', 'p', 's'].filter((s) => bySuit[s].includes(st)).length;
    if (k === 2) add('喜相逢', 1);
  }

  // ---- structure / concealment ----
  if (chows.length === 4 && !isDragon(pair) && !(isWind(pair) && (windRank(pair) === ctx.roundWind || windRank(pair) === ctx.seatWind))) add('平和', 2);
  if (ctx.concealedHand && ctx.selfDraw) add('不求人', 4);
  else if (ctx.concealedHand && ctx.winByDiscard) add('门前清', 2);
  if (melds.length === 4 && melds.every((m) => !m.concealed) && ctx.winByDiscard) add('全求人', 6);
  if (cats.size === 5) add('五门齐', 6);
  if (numSuits.size === 2 && hasHonorTile && !has('清一色') && !has('混一色')) add('缺一门', 1);
  if (!hasHonorTile && !has('清一色') && !has('断幺') && !has('清幺九')) add('无字', 1);

  // ---- kongs ----
  for (const m of kongs) add(m.concealed ? '暗杠' : '明杠', m.concealed ? 2 : 1);

  // ---- winning condition ----
  if (ctx.lastTile) add('海底捞月', 8);
  if (ctx.afterKong) add('杠上开花', 8);
  if (ctx.selfDraw && !has('不求人')) add('自摸', 1);

  // ---- wait type (single small fan) ----
  if (ctx.winningTile === pair) add('单钓将', 1);
  else {
    const inChow = chows.find((m) => m.tiles.includes(ctx.winningTile));
    if (inChow) {
      const r = rankOf(ctx.winningTile), st = rankOf(inChow.tiles[0]);
      if (r === st + 1) add('坎张', 1);                                   // middle
      else if ((st === 1 && r === 3) || (st === 7 && r === 7)) add('边张', 1); // edge
    }
  }

  // ---- non-repeat: drop fans implied by stronger ones ----
  if (has('大三元')) drop('箭刻', '小三元', '双暗刻');
  if (has('字一色')) drop('混幺九', '碰碰和', '全带幺', '混一色', '缺一门');
  if (has('清幺九')) drop('碰碰和', '全带幺', '无字', '幺九刻', '断幺');
  if (has('混幺九')) drop('全带幺', '幺九刻');
  if (has('四暗刻')) drop('三暗刻', '双暗刻', '碰碰和', '门前清', '不求人');
  if (has('清一色')) drop('无字', '缺一门');
  if (has('一色三同顺')) drop('一般高');

  const total = fans.reduce((a, f) => a + f.points, 0);
  return { fan: total, fans };
}

// 七对 / 十三幺 (don't fit the meld structure). Returns {fan,fans} or null.
export function scoreSpecial(concealed, ctx) {
  const counts = new Array(34).fill(0);
  for (const id of concealed) counts[id]++;
  // 十三幺
  const orphans = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
  if (concealed.length === 14) {
    const isOrphanHand = concealed.every((id) => orphans.includes(id)) &&
      orphans.every((o) => counts[o] >= 1) && orphans.filter((o) => counts[o] === 2).length === 1;
    if (isOrphanHand) {
      const fans = [{ name: '十三幺', points: 88 }];
      if (ctx.selfDraw) fans.push({ name: '自摸', points: 1 });
      if (ctx.lastTile) fans.push({ name: '海底捞月', points: 8 });
      return { fan: fans.reduce((a, f) => a + f.points, 0), fans };
    }
    // 七对 (7 distinct pairs)
    if (counts.every((c) => c === 0 || c === 2) && counts.filter((c) => c === 2).length === 7) {
      const fans = [{ name: '七对', points: 24 }];
      if (concealed.every(isTermHonor)) { fans.length = 0; fans.push({ name: '七对', points: 24 }, { name: '混幺九', points: 16 }); }
      if (new Set(concealed.filter(isNumberSuit).map(suitOf)).size === 1 && !concealed.some(isHonor)) fans.push({ name: '清一色', points: 24 });
      if (ctx.selfDraw) fans.push({ name: '自摸', points: 1 });
      if (ctx.lastTile) fans.push({ name: '海底捞月', points: 8 });
      fans.push({ name: '门前清', points: 2 });
      return { fan: fans.reduce((a, f) => a + f.points, 0), fans };
    }
  }
  return null;
}
