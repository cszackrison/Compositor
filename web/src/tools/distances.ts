// Pixel gaps the Move tool shows when View › Show › Distances is on (LayerDistances.swift):
// while dragging, from each side of the moving box to the nearest edge facing it; with Command held, between the selected box
// and the layer under the pointer (or the canvas).

export type Box = { x: number; y: number; w: number; h: number }
export type DistanceLine = { horizontal: boolean; from: number; to: number; across: number; length: number }

const overlap = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && a1 > b0

// Where a line between `box` and `other` runs across: the middle of the span they share, or of `box` if none.
function middle(box: Box, other: Box, horizontal: boolean): number {
  const low = horizontal ? Math.max(box.y, other.y) : Math.max(box.x, other.x)
  const high = horizontal ? Math.min(box.y + box.h, other.y + other.h) : Math.min(box.x + box.w, other.x + other.w)
  return high > low ? (low + high) / 2 : horizontal ? box.y + box.h / 2 : box.x + box.w / 2
}

// While `box` moves: from each of its sides to the nearest edge facing it, of a layer level with it or the canvas.
export function movingDistances(box: Box, others: Box[], canvas: [number, number]): DistanceLine[] {
  const page: Box = { x: 0, y: 0, w: canvas[0], h: canvas[1] }
  const lines: DistanceLine[] = []
  for (const horizontal of [true, false]) {
    const level = [...others, page].filter(r =>
      horizontal ? overlap(r.y, r.y + r.h, box.y, box.y + box.h) : overlap(r.x, r.x + r.w, box.x, box.x + box.w),
    )
    const low = horizontal ? box.x : box.y, high = horizontal ? box.x + box.w : box.y + box.h
    let before: { edge: number; rect: Box } | null = null
    let after: { edge: number; rect: Box } | null = null
    for (const rect of level) {
      const edges = horizontal ? [rect.x, rect.x + rect.w] : [rect.y, rect.y + rect.h]
      for (const edge of edges) {
        if (edge <= low && edge > (before?.edge ?? -Infinity)) before = { edge, rect }
        if (edge >= high && edge < (after?.edge ?? Infinity)) after = { edge, rect }
      }
    }
    if (before && low - before.edge >= 0.5) {
      lines.push({ horizontal, from: before.edge, to: low, across: middle(box, before.rect, horizontal), length: low - before.edge })
    }
    if (after && after.edge - high >= 0.5) {
      lines.push({ horizontal, from: high, to: after.edge, across: middle(box, after.rect, horizontal), length: after.edge - high })
    }
  }
  return lines
}

// Between the selected `box` and `other`: the gap across each axis they're apart on; where they overlap, from each side of one
// to the same side of the other.
export function distancesBetween(box: Box, other: Box): DistanceLine[] {
  const gaps: DistanceLine[] = [], insets: DistanceLine[] = []
  for (const horizontal of [true, false]) {
    const low = horizontal ? box.x : box.y, high = horizontal ? box.x + box.w : box.y + box.h
    const otherLow = horizontal ? other.x : other.y, otherHigh = horizontal ? other.x + other.w : other.y + other.h
    const across = middle(box, other, horizontal)
    if (otherLow >= high) {
      gaps.push({ horizontal, from: high, to: otherLow, across, length: otherLow - high })
    } else if (otherHigh <= low) {
      gaps.push({ horizontal, from: otherHigh, to: low, across, length: low - otherHigh })
    } else {
      for (const [a, b] of [[low, otherLow], [high, otherHigh]]) {
        if (Math.abs(a - b) >= 0.5) {
          const from = Math.min(a, b), to = Math.max(a, b)
          insets.push({ horizontal, from, to, across, length: to - from })
        }
      }
    }
  }
  return gaps.length ? gaps : insets
}
