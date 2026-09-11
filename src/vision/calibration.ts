/**
 * Board, queue, and hold region calibration.
 *
 * Board grid: re-uses the border-detection approach from the original game-hook
 * (find white border lines around the 10×20 play area).
 *
 * Queue/Hold ROI: instead of hardcoded Y offsets (the old approach broke on UI
 * changes), we scan a wide area and project filled-pixel density onto the Y
 * axis. Peaks in the projection are the centers of each preview slot.
 */

import { rgbToHsl, isFilledPixel } from './colors';

export interface BoardRect {
  x: number;
  y: number;
  cellW: number;
  cellH: number;
}

export interface SideROI {
  /** Center X of the column we sampled (e.g. just right of the board). */
  centerX: number;
  /** Y coordinate of each detected slot (1-5 entries for queue, 1 for hold). */
  slotYs: number[];
  /** Approximate slot height in pixels. */
  slotHeight: number;
}

/** Internal pixel helper — duplicates getPixel from game-hook to keep this module standalone. */
function getPixel(d: ImageData, x: number, y: number): [number, number, number, number] {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || ix >= d.width || iy < 0 || iy >= d.height) return [0, 0, 0, 0];
  const idx = (iy * d.width + ix) * 4;
  return [d.data[idx], d.data[idx + 1], d.data[idx + 2], d.data[idx + 3]];
}

/** Border = bright/near-white pixel used for the play-field outline. */
function isBorder(d: ImageData, x: number, y: number): boolean {
  if (x < 0 || x >= d.width || y < 0 || y >= d.height) return false;
  const [r, g, b, a] = getPixel(d, x, y);
  return a > 200 && r > 160 && g > 160 && b > 160;
}

function isDark(d: ImageData, x: number, y: number): boolean {
  const [r, g, b, a] = getPixel(d, x, y);
  return a > 100 && r + g + b < 150;
}

/**
 * Detect the play-field rectangle. Returns null if not found.
 */
export function calibrateBoard(imageData: ImageData): BoardRect | null {
  const w = imageData.width;
  const h = imageData.height;
  const cx = Math.floor(w / 2);

  for (let yFrac = 0.35; yFrac <= 0.65; yFrac += 0.05) {
    const sy = Math.floor(h * yFrac);
    if (!isDark(imageData, cx, sy)) continue;

    let leftBorder = -1;
    for (let x = cx - 1; x > Math.floor(w * 0.1); x--) {
      if (isBorder(imageData, x, sy)) { leftBorder = x; break; }
    }
    if (leftBorder < 0) continue;

    let rightBorder = -1;
    for (let x = cx + 1; x < Math.floor(w * 0.9); x++) {
      if (isBorder(imageData, x, sy)) { rightBorder = x; break; }
    }
    if (rightBorder < 0) continue;

    const innerWidth = rightBorder - leftBorder - 1;
    const cellW = innerWidth / 10;
    if (cellW < 15 || cellW > 200) continue;

    let bottomBorder = -1;
    const midX = Math.floor((leftBorder + rightBorder) / 2);
    for (let y = sy + 1; y < Math.floor(h * 0.95); y++) {
      if (isBorder(imageData, midX, y)) { bottomBorder = y; break; }
    }
    if (bottomBorder < 0) continue;

    const boardX = leftBorder + 1;
    const boardY = bottomBorder - 20 * cellW;
    if (boardY < 0) continue;

    const ratio = (bottomBorder - boardY) / innerWidth;
    if (Math.abs(ratio - 2.0) > 0.3) continue;

    // Verify the left/right borders run consistently along the play-field height
    let hits = 0, tests = 0;
    for (let testY = boardY + cellW * 2; testY < bottomBorder - cellW; testY += cellW * 3) {
      tests += 2;
      if (isBorder(imageData, leftBorder, testY)) hits++;
      if (isBorder(imageData, rightBorder, testY)) hits++;
    }
    if (tests > 0 && hits < tests * 0.6) continue;

    const rect: BoardRect = { x: boardX, y: boardY, cellW, cellH: cellW };
    if (validateBoard(imageData, rect)) return rect;
  }

  return null;
}

function validateBoard(d: ImageData, rect: BoardRect): boolean {
  const right = rect.x + 10 * rect.cellW;
  const bottom = rect.y + 20 * rect.cellH;
  if (right > d.width || bottom > d.height) return false;

  let dark = 0, opaque = 0;
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 10; col++) {
      const px = rect.x + (col + 0.5) * rect.cellW;
      const py = rect.y + (row + 0.5) * rect.cellH;
      const [r, g, b, a] = getPixel(d, px, py);
      if (a > 50) opaque++;
      if (r + g + b < 150) dark++;
    }
  }
  return dark > 25 && opaque > 30;
}

/**
 * Detect Y centers of preview/hold slots by projecting filled-pixel density.
 *
 * @param imageData full canvas pixels
 * @param rect board rectangle (used for cell-size scaling)
 * @param sideCenterX X coordinate of the column we sample (e.g. boardRight + 3*cellW)
 * @param yStart top Y of the search region (canvas pixels)
 * @param yEnd bottom Y of the search region (canvas pixels)
 * @param maxSlots stop after detecting this many peaks
 */
export function calibrateSlotYs(
  imageData: ImageData,
  rect: BoardRect,
  sideCenterX: number,
  yStart: number,
  yEnd: number,
  maxSlots: number,
): number[] {
  const cw = rect.cellW;
  const ch = rect.cellH;
  yStart = Math.max(0, yStart);
  yEnd = Math.min(imageData.height - 1, yEnd);
  if (yEnd <= yStart) return [];

  // 1. Build a per-Y density profile: at each Y row in the search range,
  //    count saturated pixels across a horizontal band centered on sideCenterX.
  const xStart = Math.max(0, sideCenterX - cw * 1.5);
  const xEnd = Math.min(imageData.width - 1, sideCenterX + cw * 1.5);
  const ySteps = Math.ceil(yEnd - yStart);
  const density = new Array(ySteps).fill(0);
  for (let i = 0; i < ySteps; i++) {
    const y = yStart + i;
    let count = 0;
    for (let x = xStart; x <= xEnd; x += Math.max(1, cw / 8)) {
      const [r, g, b, a] = getPixel(imageData, x, y);
      if (isFilledPixel(r, g, b, a, 0.35)) count++;
    }
    density[i] = count;
  }

  // 2. Smooth with a box filter of width ~cellH/2 so jitter doesn't fragment slots
  const smoothWindow = Math.max(3, Math.floor(ch / 2));
  const smoothed = boxSmooth(density, smoothWindow);

  // 3. Find peaks: local maxima with value > mean+std, separated by ~slot spacing
  const mean = smoothed.reduce((a, b) => a + b, 0) / smoothed.length;
  const variance = smoothed.reduce((a, v) => a + (v - mean) * (v - mean), 0) / smoothed.length;
  const std = Math.sqrt(variance);
  const threshold = Math.max(2, mean + std * 0.4);

  const minSpacing = ch * 1.5; // slots are at least ~1.5 cells apart
  const peaks: number[] = [];
  for (let i = 1; i < smoothed.length - 1; i++) {
    if (smoothed[i] < threshold) continue;
    if (smoothed[i] <= smoothed[i - 1] || smoothed[i] < smoothed[i + 1]) continue;
    const y = yStart + i;
    if (peaks.length && y - peaks[peaks.length - 1] < minSpacing) {
      // Replace previous peak if this one is higher
      if (smoothed[i] > smoothed[peaks[peaks.length - 1] - yStart]) {
        peaks[peaks.length - 1] = y;
      }
      continue;
    }
    peaks.push(y);
    if (peaks.length >= maxSlots) break;
  }

  return peaks;
}

function boxSmooth(arr: number[], window: number): number[] {
  const out = new Array(arr.length).fill(0);
  const half = Math.floor(window / 2);
  let sum = 0;
  for (let i = 0; i < arr.length + half; i++) {
    if (i < arr.length) sum += arr[i];
    if (i - window >= 0) sum -= arr[i - window];
    const target = i - half;
    if (target >= 0 && target < arr.length) {
      const count = Math.min(i + 1, window, arr.length - target + half);
      out[target] = sum / Math.max(1, count);
    }
  }
  return out;
}

/**
 * Calibrate queue ROI: find Y centers for the 5 preview slots to the right of the board.
 * Falls back to hardcoded spacing if peak detection produced fewer than 3 slots.
 */
export function calibrateQueueROI(imageData: ImageData, rect: BoardRect): SideROI {
  const centerX = rect.x + rect.cellW * (10 + 3);
  // The preview region spans roughly yOff -1 to 16 cells from board top
  const yStart = rect.y - rect.cellH * 0.5;
  const yEnd = rect.y + rect.cellH * 17;
  const detected = calibrateSlotYs(imageData, rect, centerX, yStart, yEnd, 5);
  if (detected.length >= 3) {
    return {
      centerX,
      slotYs: detected,
      slotHeight: detected.length > 1
        ? (detected[detected.length - 1] - detected[0]) / (detected.length - 1)
        : rect.cellH * 3,
    };
  }
  // Fallback to legacy fixed offsets
  const fallback = [1.5, 4.5, 7.5, 10.5, 13.5].map(yOff => rect.y + rect.cellH * yOff);
  return { centerX, slotYs: fallback, slotHeight: rect.cellH * 3 };
}

/**
 * Calibrate hold ROI: find the Y center of the single hold slot left of the board.
 */
export function calibrateHoldROI(imageData: ImageData, rect: BoardRect): SideROI {
  const centerX = rect.x - rect.cellW * 2.5;
  const yStart = rect.y - rect.cellH * 0.5;
  const yEnd = rect.y + rect.cellH * 5;
  const detected = calibrateSlotYs(imageData, rect, centerX, yStart, yEnd, 1);
  if (detected.length >= 1) {
    return { centerX, slotYs: detected, slotHeight: rect.cellH * 3 };
  }
  return {
    centerX,
    slotYs: [rect.y + rect.cellH * 1.5],
    slotHeight: rect.cellH * 3,
  };
}
