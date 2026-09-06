export const ENDMARKER = 0

export type Orientation = 'forward' | 'reverse'

export function encodeNode(id: number, orientation: Orientation) {
  return 2 * id + (orientation === 'reverse' ? 1 : 0)
}

export function nodeId(handle: number) {
  return Math.floor(handle / 2)
}

export function nodeOrientation(handle: number): Orientation {
  return handle % 2 === 0 ? 'forward' : 'reverse'
}

export function isReverse(handle: number) {
  return handle % 2 === 1
}

export function flipNode(handle: number) {
  return handle % 2 === 0 ? handle + 1 : handle - 1
}

export type NodeSide = 'left' | 'right'

export function flipSide(side: NodeSide): NodeSide {
  return side === 'left' ? 'right' : 'left'
}

export function entrySide(orientation: Orientation): NodeSide {
  return orientation === 'forward' ? 'left' : 'right'
}

export function exitSide(orientation: Orientation): NodeSide {
  return orientation === 'forward' ? 'right' : 'left'
}

export function entryOrientation(side: NodeSide): Orientation {
  return side === 'left' ? 'forward' : 'reverse'
}

export function exitOrientation(side: NodeSide): Orientation {
  return side === 'right' ? 'forward' : 'reverse'
}

export function edgeIsCanonical(from: number, to: number) {
  const fromId = nodeId(from)
  const toId = nodeId(to)
  return isReverse(from)
    ? toId > fromId || (toId === fromId && !isReverse(to))
    : toId >= fromId
}

export function pathIsCanonical(path: number[]) {
  return pathEndsAreCanonical(path[0], path[path.length - 1])
}

export function pathEndsAreCanonical(
  first: number | undefined,
  last: number | undefined,
) {
  if (first === undefined || last === undefined) {
    return true
  }
  return isReverse(first) === isReverse(last)
    ? !isReverse(first)
    : edgeIsCanonical(first, last)
}
