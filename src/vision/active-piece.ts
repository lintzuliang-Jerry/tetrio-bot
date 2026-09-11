/**
 * Detect the active (currently controllable) piece on the board.
 *
 * Strategy: we already know the active piece TYPE (from queue inference).
 * We scan the top rows of the visible board for cells classified as that type
 * and look for a 4-cell shape match. The match tells us the real rotation
 * and (x, y), so we don't have to assume the piece is at the spawn position.
 *
 * Note: TETR.IO renders the ghost piece (drop preview) with a dimmed/outline
 * rendering — the cell interior is background colour. Our cell classifier
 * samples the cell *interior*, so ghost cells naturally read as empty. That
 * means raw board reads typically contain only "locked + active" cells, and
 * we just need to strip the active piece.
 */

import { PieceType, Board, BOARD_WIDTH, BOARD_HEIGHT } from '@/types';
import { getShape } from '@/ai/piece';

export interface ActivePieceDetection {
  rotation: number;
  x: number;
  y: number;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Try to find a 4-cell shape of `type` at any (rotation, x, y) inside `board`.
 * `board` here is the raw 20×10 visible board with the active piece's cells
 * marked as that piece's type. We search only the top `searchRows` rows because
 * the active piece can't have fallen past that without locking.
 *
 * Returns the best-matching placement, or null if no clean match.
 */
export function detectActivePiece(
  rawBoard: Board,
  type: PieceType,
  searchRows = 8,
): ActivePieceDetection | null {
  // Collect candidate cells matching the type in the search region
  const candidates: Array<[number, number]> = [];
  const maxRow = Math.min(searchRows, rawBoard.length);
  for (let row = 0; row < maxRow; row++) {
    for (let col = 0; col < BOARD_WIDTH; col++) {
      if (rawBoard[row][col] === type) candidates.push([row, col]);
    }
  }
  if (candidates.length < 4) return null;

  // Try each rotation × each x position. For each, check if all 4 shape cells
  // match a candidate. Score = "exact match of all 4 cells and no extras nearby".
  let bestMatch: ActivePieceDetection | null = null;
  let bestScore = -Infinity;

  for (let rotation = 0; rotation < 4; rotation++) {
    const shape = getShape(type, rotation);
    let minCol = Infinity, maxCol = -Infinity;
    let minDr = Infinity, maxDr = -Infinity;
    for (const [dr, dc] of shape) {
      if (dc < minCol) minCol = dc;
      if (dc > maxCol) maxCol = dc;
      if (dr < minDr) minDr = dr;
      if (dr > maxDr) maxDr = dr;
    }
    const minX = -minCol;
    const maxX = BOARD_WIDTH - 1 - maxCol;

    for (let x = minX; x <= maxX; x++) {
      // y is the top of the piece's bounding box. The piece can be at row 0..searchRows-piece height
      for (let y = 0; y < searchRows - (maxDr - minDr); y++) {
        let hits = 0;
        for (const [dr, dc] of shape) {
          const r = y + dr;
          const c = x + dc;
          if (r < 0 || r >= BOARD_HEIGHT || c < 0 || c >= BOARD_WIDTH) {
            hits = -1;
            break;
          }
          if (rawBoard[r][c] === type) hits++;
        }
        if (hits === 4) {
          // Score: prefer higher up (smaller y) so we don't accidentally match a
          // locked piece deeper down. Also prefer rotation 0 (spawn) when tied.
          const score = -y * 100 + (rotation === 0 ? 5 : 0);
          if (score > bestScore) {
            bestScore = score;
            bestMatch = { rotation, x, y, confidence: 'high' };
          }
        }
      }
    }
  }

  return bestMatch;
}

/**
 * Subtract the active piece's cells from the board. Returns a NEW board (the
 * locked-pieces-only state) suitable for AI evaluation.
 */
export function stripActivePiece(
  board: Board,
  type: PieceType,
  rotation: number,
  x: number,
  y: number,
): Board {
  const out: Board = board.map(row => [...row]);
  const shape = getShape(type, rotation);
  for (const [dr, dc] of shape) {
    const r = y + dr;
    const c = x + dc;
    if (r >= 0 && r < BOARD_HEIGHT && c >= 0 && c < BOARD_WIDTH) {
      if (out[r][c] === type) out[r][c] = null;
    }
  }
  return out;
}

/**
 * Fallback when shape match fails: assume the piece is at SRS spawn position
 * (x=3 for I/J/L/T/S/Z, x=4 for O, y=0, rotation=0).
 */
export function fallbackSpawnDetection(type: PieceType): ActivePieceDetection {
  return {
    rotation: 0,
    x: type === 'O' ? 4 : 3,
    y: 0,
    confidence: 'low',
  };
}
