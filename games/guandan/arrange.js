// Hand arrangement helpers for the Guandan UI. Every returned stack is an array of card ids;
// stacks run left-to-right and cards inside one stack fan vertically.
import { classify } from './engine.js';
import { bestPartition } from './ai.js';

// The default arrangement: one vertical stack per printed rank, in the hand's existing
// level-aware sort order.
export function rankStacks(hand) {
  const byRank = new Map();
  for (const card of hand) {
    if (!byRank.has(card.rank)) byRank.set(card.rank, []);
    byRank.get(card.rank).push(card.id);
  }
  return [...byRank.values()];
}

// Keep the user's ordering as cards leave the hand. If a played card makes a mixed-rank stack no
// longer legal, split the remainder back into rank stacks rather than displaying a fake combo.
export function normalizeStacks(hand, stacks, level) {
  if (!hand.length) return [];
  if (!stacks || !stacks.length) return rankStacks(hand);
  const byId = new Map(hand.map((card) => [card.id, card]));
  const seen = new Set();
  const out = [];
  for (const stack of stacks) {
    const cards = [];
    for (const id of stack) {
      const card = byId.get(id);
      if (card && !seen.has(id)) { cards.push(card); seen.add(id); }
    }
    if (!cards.length) continue;
    if (cards.length === 1 || classify(cards, level)) out.push(cards.map((card) => card.id));
    else out.push(...rankStacks(cards));
  }
  const missing = hand.filter((card) => !seen.has(card.id));
  if (missing.length) out.push(...rankStacks(missing));
  return out;
}

// Returns the selected descriptor only when it can actually be made into a multi-card stack.
export function selectionCombo(hand, ids, level) {
  if (!ids || ids.length < 2 || new Set(ids).size !== ids.length) return null;
  const byId = new Map(hand.map((card) => [card.id, card]));
  const cards = ids.map((id) => byId.get(id)).filter(Boolean);
  return cards.length === ids.length ? classify(cards, level) : null;
}

// Pull selected cards out of their old stacks and insert the new stack where the first selected
// card used to be. Card order follows the current visual layout, making swipe-to-group predictable.
export function groupSelection(hand, stacks, ids, level) {
  if (!selectionCombo(hand, ids, level)) return normalizeStacks(hand, stacks, level);
  const selected = new Set(ids);
  const visual = normalizeStacks(hand, stacks, level);
  const grouped = visual.flat().filter((id) => selected.has(id));
  const out = [];
  let inserted = false;
  for (const stack of visual) {
    const touched = stack.some((id) => selected.has(id));
    if (touched && !inserted) { out.push(grouped); inserted = true; }
    const rest = stack.filter((id) => !selected.has(id));
    if (rest.length) out.push(rest);
  }
  return normalizeStacks(hand, out, level);
}

// Reuse the AI's wild-aware fewest-play decomposition so 自动理牌 and the bot agree about the
// hand's strongest structure.
export function bestStacks(hand, level) {
  return bestPartition(hand, level);
}
