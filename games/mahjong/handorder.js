// Pure helpers for the human's hand display order. Non-混儿 tiles are ALWAYS
// shown sorted, with the freshly drawn tile on the far right; they can't be
// dragged. 混儿 (wilds) default to the left but can be dragged anywhere, and a
// dragged 混儿 keeps its spot (relative to the sorted tiles) across draws and
// discards. No DOM here so it's unit-testable in Node.

// Build the display order from the current hand, preserving where each 混儿 sits
// (derived from the previous order) and re-sorting everything else.
export function buildOrder(prevOrder, concealed, isWild, drawnTile) {
  const nonWild = concealed.filter((id) => !isWild(id)).sort((a, b) => a - b);
  if (drawnTile != null && !isWild(drawnTile)) {
    const i = nonWild.indexOf(drawnTile);
    if (i >= 0) { nonWild.splice(i, 1); nonWild.push(drawnTile); } // newest tile to the right
  }
  const wilds = concealed.filter(isWild).sort((a, b) => a - b);
  if (wilds.length === 0) return nonWild;

  // For each 混儿 in the previous order, remember the non-wild tile immediately to
  // its left (its anchor), so it can be re-placed after that tile.
  const priorAnchors = []; // { wildId, anchor }
  let lastNonWild = null;
  for (const id of (prevOrder || [])) {
    if (isWild(id)) priorAnchors.push({ wildId: id, anchor: lastNonWild });
    else lastNonWild = id;
  }
  const nonWildSet = new Set(nonWild);
  const used = new Array(priorAnchors.length).fill(false);
  const startWilds = [];           // 混儿 anchored to the very left
  const afterAnchor = new Map();   // anchorId -> [wildIds]
  for (const w of wilds) {
    let anchor = null, found = false;
    for (let i = 0; i < priorAnchors.length; i++) {
      if (!used[i] && priorAnchors[i].wildId === w) { used[i] = true; anchor = priorAnchors[i].anchor; found = true; break; }
    }
    // newly drawn 混儿, or one whose anchor was discarded → default to the left
    if (!found || (anchor != null && !nonWildSet.has(anchor))) anchor = null;
    if (anchor == null) startWilds.push(w);
    else { if (!afterAnchor.has(anchor)) afterAnchor.set(anchor, []); afterAnchor.get(anchor).push(w); }
  }

  const out = startWilds.slice();
  for (const nw of nonWild) {
    out.push(nw);
    const ws = afterAnchor.get(nw);
    if (ws) for (const w of ws) out.push(w);
  }
  return out;
}

// Move a 混儿 to index `target` (no-op for non-wild tiles — only 混儿 are
// draggable). Non-wild relative order is untouched, so it stays sorted.
export function moveWild(order, id, target, isWild) {
  const arr = order.slice();
  if (!isWild(id)) return arr;
  const from = arr.indexOf(id);
  if (from < 0) return arr;
  const t = Math.max(0, Math.min(arr.length - 1, target));
  if (t === from) return arr;
  arr.splice(from, 1);
  arr.splice(t, 0, id);
  return arr;
}
