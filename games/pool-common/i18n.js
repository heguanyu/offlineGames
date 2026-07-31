// i18n for the billiards games (pool8 + snooker).
//
// Chinese is the DEFAULT and stays the default: the E2E suite matches on Chinese
// strings, and so does every existing player's muscle memory. English is opt-in via
//   ?lang=en           one-off (this is what the demo recorder uses)
//   localStorage['og-lang'] = 'en'    sticky
//
// Usage:
//   import { t, lang, applyDom } from '../pool-common/i18n.js';
//   t('foul.noHit')                 → '未击中任何球' | 'no ball was hit'
//   t('group.assigned', 'solids')   → positional {0}, {1}, … substitution
//   applyDom()                      → fills every [data-i18n] element in the page
//
// Adding a string: put it in BOTH dictionaries. A missing key renders as the key
// itself, loudly, rather than silently falling back to the other language.

function detect() {
  const ok = (v) => (v === 'en' || v === 'zh' ? v : null);
  try {
    const q = ok(new URLSearchParams(location.search).get('lang'));
    if (q) { localStorage.setItem('og-lang', q); return q; }
    // 'hub-lang' is the hub's own language switch (index.html). Falling back to it
    // means a player who set the hub to English gets English games too, instead of
    // an English menu handing off to a Chinese table.
    return ok(localStorage.getItem('og-lang')) || ok(localStorage.getItem('hub-lang')) || 'zh';
  } catch { /* no storage (private mode) */ }
  return 'zh';
}

export const lang = detect();

const ZH = {
  // chrome
  'menu.title': '菜单',
  'menu.continue': '继续',
  'menu.restart': '重开（清零比分）',
  'menu.home': '← 返回大厅',
  'result.again': '再来一局',
  'btn.start': '开始',
  'btn.placeDone': '放好了 ✓',
  'diff.0': '新手',
  'diff.1': '普通',
  'diff.2': '高手',
  'aria.spin': '杆法：上下=高低杆，左右=侧塞，双击复位',
  'aria.fineLeft': '微调左',
  'aria.fineRight': '微调右',
  // titles
  'pool8.title': '黑八台球',
  'pool8.subtitle': '15 球 · 你 vs AI · 犯规自由球',
  'snooker.title': '斯诺克',
  'snooker.subtitle': '15 红球 + 6 彩球 · 你 vs AI',
  // players + turn line
  'player.you': '你',
  'player.ai': 'AI',
  'turn.you': '你的回合',
  'turn.ai': 'AI 回合',
  'turn.target': '目标：{0}',
  // hints
  'hint.ballInHandD': '自由球：拖动白球在 D 区内放置',
  'hint.breakKitchen': '开球：可在开球线后拖动白球',
  'hint.ballInHandAny': '自由球：拖动白球到任意位置',
  'hint.cue': '拉杆击球：按住拖动，越拉越远力度越大，松手击球（拖回白球取消）',
  // result
  'result.youWin': '🎉 你赢了！',
  'result.aiWin': 'AI 获胜',
  'result.match': '总比分 {0} : {1}',
  // 8-ball
  'p8.solids': '实色球',
  'p8.stripes': '花色球',
  'p8.anyColour': '任意彩球',
  'p8.black8': '黑8',
  'p8.groupUndecided': '未定组',
  'p8.groupLeft': '{0} 剩{1}',
  'p8.onBlack': ' · 打黑8',
  'p8.breakPotted8': '开球打进黑8：重置黑8',
  'p8.win8': '打进黑8，获胜！',
  'p8.lose8Foul': '打进黑8但犯规，判负',
  'p8.lose8Early': '提前打进黑8，判负',
  'p8.youAre': '你方确定为{0}',
  'p8.aiIs': 'AI 确定为{0}',
  // snooker
  'sn.red': '红',
  'sn.yellow': '黄',
  'sn.green': '绿',
  'sn.brown': '棕',
  'sn.blue': '蓝',
  'sn.pink': '粉',
  'sn.black': '黑',
  'sn.ball': '{0}球',
  'sn.colours': '彩球',
  'sn.reds': '红球',
  'sn.redsLeft': '红球×{0}',
  'sn.points': '{0} 分',
  'sn.plusPoints': '+{0} 分',
  'sn.scoreOn': '{0} 分 · 打{1}',
  'sn.tieBlackRespot': '（平分：黑球重置）',
  // fouls
  'foul.noHit': '未击中任何球',
  'foul.wrongFirst': '首先击中了非目标球（应打{0}）',
  'foul.wrongFirstBall': '首先击中了{0}（应打{1}）',
  'foul.cuePotted': '白球落袋',
  'foul.noRail': '击球后无球碰库',
  'foul.pottedWrong': '打进了非目标球',
  'foul.line': '犯规：{0} → 对方自由球',
  'foul.points': '犯规：{0} → 对方 +{1} 分',
  'foul.join': '，',
};

const EN = {
  'menu.title': 'Menu',
  'menu.continue': 'Resume',
  'menu.restart': 'Restart (clear score)',
  'menu.home': '← Back to hub',
  'result.again': 'Play again',
  'btn.start': 'Start',
  'btn.placeDone': 'Placed ✓',
  'diff.0': 'Easy',
  'diff.1': 'Normal',
  'diff.2': 'Hard',
  'aria.spin': 'Cue tip: up/down = follow/draw, left/right = side spin, double-tap to reset',
  'aria.fineLeft': 'Aim left',
  'aria.fineRight': 'Aim right',
  'pool8.title': 'Eight-ball',
  'pool8.subtitle': '15 balls · you vs AI · ball in hand on a foul',
  'snooker.title': 'Snooker',
  'snooker.subtitle': '15 reds + 6 colours · you vs AI',
  'player.you': 'You',
  'player.ai': 'AI',
  'turn.you': 'Your turn',
  'turn.ai': "AI's turn",
  'turn.target': 'on: {0}',
  'hint.ballInHandD': 'Ball in hand — drag the cue ball inside the D',
  'hint.breakKitchen': 'Break — drag the cue ball behind the baulk line',
  'hint.ballInHandAny': 'Ball in hand — drag the cue ball anywhere',
  'hint.cue': 'Press and drag back to aim and build power, release to shoot (drag onto the cue ball to cancel)',
  'result.youWin': '🎉 You win!',
  'result.aiWin': 'AI wins',
  'result.match': 'Match {0} : {1}',
  'p8.solids': 'solids',
  'p8.stripes': 'stripes',
  'p8.anyColour': 'any object ball',
  'p8.black8': 'the 8',
  'p8.groupUndecided': 'table open',
  'p8.groupLeft': '{0}, {1} left',
  'p8.onBlack': ' · on the 8',
  'p8.breakPotted8': 'the 8 went down on the break — re-spotted',
  'p8.win8': 'the 8 is down — you win!',
  'p8.lose8Foul': 'the 8 went down on a foul — you lose',
  'p8.lose8Early': 'the 8 went down early — you lose',
  'p8.youAre': 'you are {0}',
  'p8.aiIs': 'AI is {0}',
  'sn.red': 'red',
  'sn.yellow': 'yellow',
  'sn.green': 'green',
  'sn.brown': 'brown',
  'sn.blue': 'blue',
  'sn.pink': 'pink',
  'sn.black': 'black',
  'sn.ball': 'the {0}',
  'sn.colours': 'a colour',
  'sn.reds': 'a red',
  'sn.redsLeft': 'reds ×{0}',
  'sn.points': '{0} pts',
  'sn.plusPoints': '+{0}',
  'sn.scoreOn': '{0} pts · on {1}',
  'sn.tieBlackRespot': ' (tied — black re-spotted)',
  'foul.noHit': 'no ball was hit',
  'foul.wrongFirst': 'hit the wrong ball first (on {0})',
  'foul.wrongFirstBall': 'hit {0} first (on {1})',
  'foul.cuePotted': 'cue ball potted',
  'foul.noRail': 'no ball reached a cushion',
  'foul.pottedWrong': 'potted the wrong ball',
  'foul.line': 'Foul: {0} → ball in hand',
  'foul.points': 'Foul: {0} → {1} to opponent',
  'foul.join': ', ',
};

const DICT = lang === 'en' ? EN : ZH;

/** t('key', a, b) — positional {0}/{1} substitution. Unknown keys render as the key. */
export function t(key, ...args) {
  const s = DICT[key];
  if (s === undefined) return key;
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (args[i] === undefined ? m : args[i])) : s;
}

/**
 * Fill every [data-i18n] element and [data-i18n-aria] attribute in the document.
 * Call once, after DOM parse. Keeps the markup readable: the HTML still carries a
 * default Chinese label, and this replaces it when the page is in English.
 */
export function applyDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const v = t(el.getAttribute('data-i18n'));
    if (v) el.textContent = v;
  }
  for (const el of root.querySelectorAll('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
  }
  const title = root.querySelector('[data-i18n-title]');
  if (title) document.title = t(title.getAttribute('data-i18n-title'));
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh';
}
