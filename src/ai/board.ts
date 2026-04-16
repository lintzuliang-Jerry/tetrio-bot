import { Board, PieceType, PieceState, Placement, BOARD_WIDTH, BOARD_TOTAL_HEIGHT } from '@/types';
import { getShape } from './piece';

/** Create an empty board */
export function createEmptyBoard(): Board {
  return Array.from({ length: BOARD_TOTAL_HEIGHT }, () =>
    Array(BOARD_WIDTH).fill(null),
  );
}

/** Deep-clone a board */
export function cloneBoard(board: Board): Board {
  return board.map(row => [...row]);
}

/** Check if a piece at (x, y) with given rotation collides with walls or placed blocks */
export function collides(
  board: Board,
  type: PieceType,
  rotation: number,
  x: number,
  y: number,
): boolean {
  const shape = getShape(type, rotation);
  for (const [dr, dc] of shape) {
    const row = y + dr;
    const col = x + dc;
    if (col < 0 || col >= BOARD_WIDTH || row >= BOARD_TOTAL_HEIGHT) return true;
    if (row < 0) continue; // above board is ok
    if (board[row][col] !== null) return true;
  }
  return false;
}

/** Hard-drop: find the lowest y where the piece can be placed */
export function hardDropY(
  board: Board,
  type: PieceType,
  rotation: number,
  x: number,
  startY: number,
): number {
  let y = startY;
  while (!collides(board, type, rotation, x, y + 1)) {
    y++;
  }
  return y;
}

/** Place a piece on the board (mutates the board) */
export function placePiece(board: Board, placement: Placement): void {
  const shape = getShape(placement.type, placement.rotation);
  for (const [dr, dc] of shape) {
    const row = placement.y + dr;
    const col = placement.x + dc;
    if (row >= 0 && row < BOARD_TOTAL_HEIGHT && col >= 0 && col < BOARD_WIDTH) {
      board[row][col] = placement.type;
    }
  }
}

/** Clear completed lines. Returns the number of lines cleared. Mutates the board. */
export function clearLines(board: Board): number {
  let linesCleared = 0;
  for (let row = BOARD_TOTAL_HEIGHT - 1; row >= 0; row--) {
    if (board[row].every(cell => cell !== null)) {
      board.splice(row, 1);
      board.unshift(Array(BOARD_WIDTH).fill(null));
      linesCleared++;
      row++; // recheck same index since rows shifted down
    }
  }
  return linesCleared;
}

/**
 * Simulate placing a piece and clearing lines.
 * Returns a new board, the number of lines cleared, the final placement,
 * and the Dellacherie landing height (row of the piece's center of mass,
 * counted from the bottom of the board).
 */
export function simulatePlacement(
  board: Board,
  type: PieceType,
  rotation: number,
  x: number,
): { board: Board; linesCleared: number; placement: Placement; landingHeight: number } {
  const dropY = hardDropY(board, type, rotation, x, 0);
  const newBoard = cloneBoard(board);
  const placement: Placement = { type, rotation, x, y: dropY };
  placePiece(newBoard, placement);

  const shape = getShape(type, rotation);
  let sumRow = 0;
  for (const [dr] of shape) sumRow += dropY + dr;
  const landingHeight = BOARD_TOTAL_HEIGHT - sumRow / shape.length;

  const linesCleared = clearLines(newBoard);
  return { board: newBoard, linesCleared, placement, landingHeight };
}

/**
 * Generate all valid placements for a given piece type on the board.
 * Tests all rotations (0-3) and all x positions.
 * Deduplicates by final landing position (rotation, x, dropY) so the AI
 * doesn't evaluate identical end-states reached via different (rotation, x) combos.
 */
export function generatePlacements(
  board: Board,
  type: PieceType,
): { rotation: number; x: number }[] {
  const placements: { rotation: number; x: number }[] = [];
  const seen = new Set<string>();

  for (let rotation = 0; rotation < 4; rotation++) {
    const shape = getShape(type, rotation);
    // Find column bounds of the shape
    let minCol = Infinity;
    let maxCol = -Infinity;
    for (const [, dc] of shape) {
      if (dc < minCol) minCol = dc;
      if (dc > maxCol) maxCol = dc;
    }

    const minX = -minCol;
    const maxX = BOARD_WIDTH - 1 - maxCol;

    for (let x = minX; x <= maxX; x++) {
      const dropY = hardDropY(board, type, rotation, x, 0);
      if (!collides(board, type, rotation, x, dropY)) {
        // Deduplicate by final position: same (rotation, x, y) = same result
        const key = `${rotation},${x},${dropY}`;
        if (!seen.has(key)) {
          seen.add(key);
          placements.push({ rotation, x });
        }
      }
    }
  }

  return placements;
}
