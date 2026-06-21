// The human's hand display order: 混儿 (wilds) grouped on the left, everything
// else sorted ascending. The freshly drawn tile is NOT pulled out here — it
// sorts into its natural place; the renderer sets it apart with a small margin
// on each side. Pure, so it's unit-testable in Node. (For 国标 there are no
// wilds, so this is just a plain sort.)
export function buildOrder(concealed, isWild) {
  const wilds = concealed.filter(isWild).sort((a, b) => a - b);
  const rest = concealed.filter((id) => !isWild(id)).sort((a, b) => a - b);
  return wilds.concat(rest);
}
