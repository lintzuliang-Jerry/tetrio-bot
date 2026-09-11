/**
 * Read the play-field board, next queue, and hold piece from a captured ImageData.
 *
 * Uses the AdaptivePalette for classification and the auto-calibrated ROIs for
 * queue/hold sampling. Pieces returned reflect what's currently visible on
 * screen — including the active piece and its ghost, which the active-piece
 * detector strips off later.
 */

import { PieceType, BOARD_WIDTH, BOARD_HEIGHT, ALL_PIECE_TYPES } from '@/types';
import { AdaptivePalette, isFilledPixel } from './colors';
import { BoardRect, SideROI } from './calibration';

function getPixel(d: ImageData, x: number, y: number): [number, number, number, number] {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || ix >= d.width || iy < 0 || iy >= d.height) return [0, 0, 0, 0];
  const idx = (iy * d.width + ix) * 4;
  return [d.data[idx], d.data[idx + 1], d.data[idx + 2], d.data[idx + 3]];
}

export interface ReadBoardResult {
  /** 20 visible rows × 10 cols. */
  board: (PieceType | null)[][];
  /** Cells that needed the lenient fallback pass (diagnostic). */
  fallbackHits: number;
}

/**
 * Sample one cell and return its piece type (or null). Uses a 5×5 grid of
 * subsamples centered on the cell, with majority voting.
 */
function classifyCell(
  d: ImageData,
  cx: number,
  cy: number,
  cw: number,
  ch: number,
  palette: AdaptivePalette,
  minSat: number,
): { piece: PieceType | null; confidence: number } {
  const counts: Record<PieceType, number> = { I: 0, O: 0, T: 0, S: 0, Z: 0, J: 0, L: 0 };
  let emptyVotes = 0;
  let totalVotes = 0;

  const margin = 0.22;
  const startX = cx - cw * margin;
  const startY = cy - ch * margin;
  const stepX = (cw * margin * 2) / 4;
  const stepY = (ch * margin * 2) / 4;

  for (let dx = 0; dx <= 4; dx++) {
    for (let dy = 0; dy <= 4; dy++) {
      const px = startX + dx * stepX;
      const py = startY + dy * stepY;
      const [r, g, b, a] = getPixel(d, px, py);
      totalVotes++;
      const result = palette.classify(r, g, b, a, minSat);
      if (result.piece) {
        counts[result.piece]++;
      } else if (a < 50 || (a > 100 && r + g + b < 80)) {
        emptyVotes++;
      }
    }
  }

  let bestPiece: PieceType | null = null;
  let bestCount = 0;
  let secondCount = 0;
  for (const p of ALL_PIECE_TYPES) {
    if (counts[p] > bestCount) {
      secondCount = bestCount;
      bestCount = counts[p];
      bestPiece = p;
    } else if (counts[p] > secondCount) {
      secondCount = counts[p];
    }
  }

  // Need clear majority over empties AND second-best
  if (bestCount >= 8 && bestCount > emptyVotes && bestCount >= secondCount * 2) {
    return { piece: bestPiece, confidence: bestCount / totalVotes };
  }
  return { piece: null, confidence: 0 };
}

export function readBoard(
  imageData: ImageData,
  rect: BoardRect,
  palette: AdaptivePalette,
): ReadBoardResult {
  const board: (PieceType | null)[][] = [];
  let fallbackHits = 0;

  for (let row = 0; row < BOARD_HEIGHT; row++) {
    const rowCells: (PieceType | null)[] = [];
    for (let col = 0; col < BOARD_WIDTH; col++) {
      const px = rect.x + (col + 0.5) * rect.cellW;
      const py = rect.y + (row + 0.5) * rect.cellH;
      const { piece, confidence } = classifyCell(
        imageData, px, py, rect.cellW, rect.cellH, palette, 0.35,
      );
      rowCells.push(piece);
      if (piece && confidence < 0.4) fallbackHits++;
    }
    board.push(rowCells);
  }

  return { board, fallbackHits };
}

/** Sample a side-panel slot (queue or hold). Same logic as cell but wider sampling. */
function sampleSlot(
  d: ImageData,
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  palette: AdaptivePalette,
): PieceType | null {
  const counts: Record<PieceType, number> = { I: 0, O: 0, T: 0, S: 0, Z: 0, J: 0, L: 0 };
  let totalHits = 0;

  const xStart = centerX - width * 0.45;
  const xEnd = centerX + width * 0.45;
  const yStart = centerY - height * 0.35;
  const yEnd = centerY + height * 0.35;

  for (let x = xStart; x <= xEnd; x += Math.max(2, width / 12)) {
    for (let y = yStart; y <= yEnd; y += Math.max(2, height / 10)) {
      const [r, g, b, a] = getPixel(d, x, y);
      if (!isFilledPixel(r, g, b, a, 0.25)) continue;
      // Queue/hold pieces render dimmer — use a lower minSat for classification
      const result = palette.classify(r, g, b, a, 0.30);
      if (result.piece) {
        counts[result.piece]++;
        totalHits++;
      }
    }
  }

  if (totalHits < 4) return null;

  let bestPiece: PieceType | null = null;
  let bestCount = 0;
  let secondCount = 0;
  for (const p of ALL_PIECE_TYPES) {
    if (counts[p] > bestCount) {
      secondCount = bestCount;
      bestCount = counts[p];
      bestPiece = p;
    } else if (counts[p] > secondCount) {
      secondCount = counts[p];
    }
  }
  if (bestCount < 3 || bestCount < secondCount * 1.6) return null;
  return bestPiece;
}

/** Read next queue from auto-calibrated slot Y centers. Returns up to 5 pieces. */
export function readQueue(
  imageData: ImageData,
  rect: BoardRect,
  roi: SideROI,
  palette: AdaptivePalette,
): PieceType[] {
  const queue: PieceType[] = [];
  // Sample width: pieces span ~3 cells wide
  const sampleW = rect.cellW * 3;
  const sampleH = roi.slotHeight * 0.7;

  for (const y of roi.slotYs) {
    const piece = sampleSlot(imageData, roi.centerX, y, sampleW, sampleH, palette);
    if (!piece) break; // contiguous queue — gap ends it
    queue.push(piece);
  }

  return queue;
}

/** Read the hold piece from auto-calibrated hold ROI. */
export function readHold(
  imageData: ImageData,
  rect: BoardRect,
  roi: SideROI,
  palette: AdaptivePalette,
): PieceType | null {
  if (roi.slotYs.length === 0) return null;
  const sampleW = rect.cellW * 3;
  const sampleH = roi.slotHeight * 0.7;
  return sampleSlot(imageData, roi.centerX, roi.slotYs[0], sampleW, sampleH, palette);
}

/**
 * Bootstrap the palette by sampling pixels from areas we know contain a piece
 * of the given type. Caller supplies one (x, y) per known piece.
 *
 * Sample density: returns ~25 pixels per piece centered on the given coords.
 */
export function collectPaletteSamples(
  imageData: ImageData,
  knownPieces: Array<{ piece: PieceType; x: number; y: number; w: number; h: number }>,
  palette: AdaptivePalette,
): void {
  for (const { piece, x, y, w, h } of knownPieces) {
    const xStart = x - w * 0.4;
    const xEnd = x + w * 0.4;
    const yStart = y - h * 0.3;
    const yEnd = y + h * 0.3;
    for (let px = xStart; px <= xEnd; px += Math.max(2, w / 8)) {
      for (let py = yStart; py <= yEnd; py += Math.max(2, h / 8)) {
        const [r, g, b, a] = getPixel(imageData, px, py);
        if (isFilledPixel(r, g, b, a, 0.30)) {
          palette.addSample(piece, r, g, b);
        }
      }
    }
  }
}
