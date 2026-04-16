import { PieceType } from '@/types';

/**
 * SRS piece shapes: each piece has 4 rotation states.
 * Each state is an array of [row, col] offsets relative to the piece center.
 * Coordinates: row increases downward, col increases rightward.
 */

type Shape = [number, number][];

// Piece shapes for all 4 rotation states (0, R, 2, L)
// Based on https://tetris.wiki/Super_Rotation_System

const SHAPES: Record<PieceType, Shape[]> = {
  I: [
    // 0
    [[0, 0], [0, 1], [0, 2], [0, 3]],
    // R
    [[0, 2], [1, 2], [2, 2], [3, 2]],
    // 2
    [[2, 0], [2, 1], [2, 2], [2, 3]],
    // L
    [[0, 1], [1, 1], [2, 1], [3, 1]],
  ],
  O: [
    [[0, 0], [0, 1], [1, 0], [1, 1]],
    [[0, 0], [0, 1], [1, 0], [1, 1]],
    [[0, 0], [0, 1], [1, 0], [1, 1]],
    [[0, 0], [0, 1], [1, 0], [1, 1]],
  ],
  T: [
    [[0, 1], [1, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [1, 2], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 1]],
    [[0, 1], [1, 0], [1, 1], [2, 1]],
  ],
  S: [
    [[0, 1], [0, 2], [1, 0], [1, 1]],
    [[0, 1], [1, 1], [1, 2], [2, 2]],
    [[1, 1], [1, 2], [2, 0], [2, 1]],
    [[0, 0], [1, 0], [1, 1], [2, 1]],
  ],
  Z: [
    [[0, 0], [0, 1], [1, 1], [1, 2]],
    [[0, 2], [1, 1], [1, 2], [2, 1]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
    [[0, 1], [1, 0], [1, 1], [2, 0]],
  ],
  J: [
    [[0, 0], [1, 0], [1, 1], [1, 2]],
    [[0, 1], [0, 2], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[0, 1], [1, 1], [2, 0], [2, 1]],
  ],
  L: [
    [[0, 2], [1, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [2, 2]],
    [[1, 0], [1, 1], [1, 2], [2, 0]],
    [[0, 0], [0, 1], [1, 1], [2, 1]],
  ],
};

/**
 * SRS Wall Kick data.
 * Key format: "fromRotation>toRotation"
 * Each entry is an array of [col, row] offsets to test.
 * (col positive = right, row positive = up in game terms, but we use row-down internally
 *  so we negate the row offsets from the wiki)
 */

// Wall kicks for J, L, S, T, Z pieces
const WALL_KICK_JLSTZ: Record<string, [number, number][]> = {
  '0>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '1>0': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '1>2': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '2>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '2>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '3>2': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '3>0': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '0>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
};

// Wall kicks for I piece
const WALL_KICK_I: Record<string, [number, number][]> = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
};

export function getShape(type: PieceType, rotation: number): Shape {
  return SHAPES[type][rotation & 3];
}

export function getWallKicks(
  type: PieceType,
  fromRotation: number,
  toRotation: number,
): [number, number][] {
  const key = `${fromRotation & 3}>${toRotation & 3}`;
  if (type === 'I') {
    return WALL_KICK_I[key] ?? [[0, 0]];
  }
  if (type === 'O') {
    return [[0, 0]];
  }
  return WALL_KICK_JLSTZ[key] ?? [[0, 0]];
}

/** Get the bounding box width of a piece shape */
export function getShapeWidth(type: PieceType, rotation: number): number {
  const shape = getShape(type, rotation);
  let minCol = Infinity;
  let maxCol = -Infinity;
  for (const [, col] of shape) {
    if (col < minCol) minCol = col;
    if (col > maxCol) maxCol = col;
  }
  return maxCol - minCol + 1;
}

/** Get the spawn position for a piece (centered at top) */
export function getSpawnPosition(type: PieceType): { x: number; y: number } {
  // Standard SRS spawn: centered at row 0 (top of visible area = row 0 in buffer)
  // Most pieces spawn at x=3, I piece also at x=3
  return { x: 3, y: 0 };
}
