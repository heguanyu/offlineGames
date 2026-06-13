// The human's hand display order: 混儿 (wilds) grouped on the left, everything
// else sorted ascending, with the freshly drawn tile on the far right. Pure, so
// it's unit-testable in Node. (For 国标 there are no wilds, so this is just a
// sort with the drawn tile last.)
export function buildOrder(concealed, isWild, drawnTile) {
  const wilds = concealed.filter(isWild).sort((a, b) => a - b);
  const rest = concealed.filter((id) => !isWild(id)).sort((a, b) => a - b);
  if (drawnTile != null && !isWild(drawnTile)) {
    const i = rest.indexOf(drawnTile);
    if (i >= 0) { const [t] = rest.splice(i, 1); rest.push(t); } // newest tile to the right
  }
  return wilds.concat(rest);
}
