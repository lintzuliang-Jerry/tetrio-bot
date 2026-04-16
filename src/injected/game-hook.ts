/**
 * Game Hook v4 — Canvas Pixel Reading approach.
 *
 * TETR.IO keeps all game state in webpack closures (inaccessible).
 * We read the game state from the rendered WebGL canvas instead.
 *
 * Steps:
 * 1. Find the game canvas
 * 2. Read pixels from the canvas
 * 3. Detect the board grid position
 * 4. Sample each cell's color to determine piece type
 * 5. Detect current piece, queue, and hold piece
 */

type PieceType = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';

interface GameState {
  board: (PieceType | null)[][];
  currentPiece: { type: PieceType; rotation: number; x: number; y: number };
  nextQueue: PieceType[];
  holdPiece: PieceType | null;
  canHold: boolean;
  isPlaying: boolean;
}

function log(...args: unknown[]): void {
  console.log('[TETRIO-BOT Hook]', ...args);
}

// ===== CRITICAL: Force preserveDrawingBuffer BEFORE PIXI creates context =====
// Without this, WebGL clears the buffer after each frame and we read all-transparent pixels.

const _origGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (
  this: HTMLCanvasElement,
  type: string,
  attrs?: Record<string, unknown>,
): RenderingContext | null {
  if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
    const newAttrs = { ...attrs, preserveDrawingBuffer: true };
    log(`Intercepted getContext('${type}') — forcing preserveDrawingBuffer: true`);
    return _origGetContext.call(this, type, newAttrs) as RenderingContext | null;
  }
  return _origGetContext.call(this, type, attrs) as RenderingContext | null;
} as typeof HTMLCanvasElement.prototype.getContext;

log('getContext patched for preserveDrawingBuffer.');

// ===== CRITICAL: Prevent TETR.IO from detecting focus loss (DevTools, alt-tab) =====
// TETR.IO pauses when it detects the window is out of focus.
// Override visibility API and block blur events so the game keeps running.

// Override document.hidden and document.visibilityState
Object.defineProperty(document, 'hidden', { get: () => false });
Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });

// Block visibilitychange events
document.addEventListener('visibilitychange', (e) => { e.stopImmediatePropagation(); }, true);

// Block blur events on window (TETR.IO uses these to detect focus loss)
window.addEventListener('blur', (e) => { e.stopImmediatePropagation(); }, true);

// Ensure document.hasFocus() always returns true
Document.prototype.hasFocus = () => true;

log('Focus/visibility overrides applied — DevTools will not pause the game.');

// ===== Color-to-Piece Mapping (Hue-based) =====

/**
 * Convert RGB to HSL. Returns [h: 0-360, s: 0-1, l: 0-1]
 */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return [h, s, l];
}

/**
 * Classify a pixel color to a piece type using hue.
 * Standard Tetris piece hues:
 *   Z (red):    H ≈ 0-15 or 345-360
 *   L (orange): H ≈ 15-45
 *   O (yellow): H ≈ 45-70
 *   S (green):  H ≈ 70-170
 *   I (cyan):   H ≈ 170-200
 *   J (blue):   H ≈ 200-260
 *   T (purple): H ≈ 260-345
 */
function colorToPiece(r: number, g: number, b: number, minSat = 0.50): PieceType | null {
  const [h, s, l] = rgbToHsl(r, g, b);

  // Board bg can have s~40%, so board uses 0.50; queue/hold are dimmed, use 0.30
  // Lightness gate: board bg has l~14%, pieces have l>25%
  if (s < minSat || l < 0.20 || l > 0.75) return null;

  if (h >= 345 || h < 15) return 'Z';   // red
  if (h >= 15 && h < 45) return 'L';    // orange
  if (h >= 45 && h < 70) return 'O';    // yellow
  if (h >= 70 && h < 170) return 'S';   // green
  if (h >= 170 && h < 200) return 'I';  // cyan
  if (h >= 200 && h < 260) return 'J';  // blue
  if (h >= 260 && h < 345) return 'T';  // purple/magenta

  return null;
}

function isEmptyCell(r: number, g: number, b: number, a: number, minSat = 0.50): boolean {
  if (a < 50) return true;
  const [, s, l] = rgbToHsl(r, g, b);
  // Board bg: l~14%, s~1-42%. Pieces: l>25%, s>45%.
  if (l < 0.20) return true;   // very dark = empty (board bg, grid lines)
  if (s < minSat) return true;  // desaturated = empty
  return false;
}

function isFilledCell(r: number, g: number, b: number, a: number, minSat = 0.50): boolean {
  if (a < 100) return false;
  const [, s, l] = rgbToHsl(r, g, b);
  if (l < 0.20) return false;  // too dark
  if (l > 0.75) return false;  // too bright (wallpaper / UI text)
  return s >= minSat;
}

// ===== Canvas Reading =====

let gameCanvas: HTMLCanvasElement | null = null;
let readCanvas: HTMLCanvasElement | null = null;
let readCtx: CanvasRenderingContext2D | null = null;

// Board grid position (in canvas pixels)
let boardRect = { x: 0, y: 0, cellW: 0, cellH: 0 };
let calibrated = false;

function findGameCanvas(): HTMLCanvasElement | null {
  const canvases = document.querySelectorAll('canvas');
  // TETR.IO has 2 canvases; game canvas is the large visible one
  // The 256x256 canvas is a texture atlas — skip it
  let best: HTMLCanvasElement | null = null;
  let maxArea = 0;

  for (const c of canvases) {
    const rect = c.getBoundingClientRect();
    const area = rect.width * rect.height;
    // Skip the texture atlas (exactly 256x256) and other small canvases
    if (c.width === 256 && c.height === 256) continue;
    if (area > maxArea && rect.width > 400 && rect.height > 400) {
      maxArea = area;
      best = c;
    }
  }
  return best;
}

function ensureReadCanvas(width: number, height: number): void {
  if (!readCanvas || readCanvas.width !== width || readCanvas.height !== height) {
    readCanvas = document.createElement('canvas');
    readCanvas.width = width;
    readCanvas.height = height;
    readCtx = readCanvas.getContext('2d', { willReadFrequently: true });
  }
}

function capturePixels(): ImageData | null {
  if (!gameCanvas) return null;

  const w = gameCanvas.width;
  const h = gameCanvas.height;
  if (w === 0 || h === 0) return null;

  ensureReadCanvas(w, h);
  if (!readCtx) return null;

  // Draw WebGL canvas to 2D canvas
  readCtx.drawImage(gameCanvas, 0, 0);
  return readCtx.getImageData(0, 0, w, h);
}

function getPixel(imageData: ImageData, x: number, y: number): [number, number, number, number] {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || ix >= imageData.width || iy < 0 || iy >= imageData.height) {
    return [0, 0, 0, 0];
  }
  const idx = (iy * imageData.width + ix) * 4;
  return [
    imageData.data[idx],
    imageData.data[idx + 1],
    imageData.data[idx + 2],
    imageData.data[idx + 3],
  ];
}

// ===== Board Calibration =====

/**
 * Auto-detect the board grid position.
 *
 * Strategy: scan outward from the canvas center to find the white border lines
 * that surround the playing field. The board sits between two vertical white
 * lines (shared with HOLD on the left, NEXT on the right) and has a horizontal
 * white line at the bottom. The top is open (no border — pieces enter from above).
 * Board height is inferred from width assuming square cells (10 wide × 20 tall).
 */
function calibrateBoard(imageData: ImageData): boolean {
  const w = imageData.width;
  const h = imageData.height;

  log(`Calibrating board on ${w}x${h} canvas (border detection)...`);

  // A "border" pixel is white/near-white (the UI frame lines)
  function isBorder(x: number, y: number): boolean {
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    const [r, g, b, a] = getPixel(imageData, x, y);
    return a > 200 && r > 160 && g > 160 && b > 160;
  }

  // A "dark" pixel is low-brightness with high alpha (board interior)
  function isDark(x: number, y: number): boolean {
    const [r, g, b, a] = getPixel(imageData, x, y);
    return a > 100 && (r + g + b) < 150;
  }

  const cx = Math.floor(w / 2);

  // Try multiple horizontal scan lines across the middle of the canvas.
  // The board center should be near canvas center; try several Y values.
  for (let yFrac = 0.35; yFrac <= 0.65; yFrac += 0.05) {
    const sy = Math.floor(h * yFrac);

    // The scan point must be inside a dark region (the board interior)
    if (!isDark(cx, sy)) continue;

    // --- Find left border: scan left from center ---
    let leftBorder = -1;
    for (let x = cx - 1; x > Math.floor(w * 0.1); x--) {
      if (isBorder(x, sy)) { leftBorder = x; break; }
    }
    if (leftBorder < 0) continue;

    // --- Find right border: scan right from center ---
    let rightBorder = -1;
    for (let x = cx + 1; x < Math.floor(w * 0.9); x++) {
      if (isBorder(x, sy)) { rightBorder = x; break; }
    }
    if (rightBorder < 0) continue;

    // Board interior is between the border lines
    const boardInnerWidth = rightBorder - leftBorder - 1;
    const cellW = boardInnerWidth / 10;

    if (cellW < 15 || cellW > 200) continue;

    // --- Find bottom border: scan down from the scan line ---
    let bottomBorder = -1;
    const midX = Math.floor((leftBorder + rightBorder) / 2);
    for (let y = sy + 1; y < Math.floor(h * 0.95); y++) {
      if (isBorder(midX, y)) { bottomBorder = y; break; }
    }
    if (bottomBorder < 0) continue;

    // Derive board top from bottom and cell size (no top border in TETR.IO)
    const boardX = leftBorder + 1;
    const boardY = bottomBorder - 20 * cellW;
    if (boardY < 0) continue;

    // Aspect ratio sanity: height / width should be ≈ 2.0
    const ratio = (bottomBorder - boardY) / boardInnerWidth;
    if (Math.abs(ratio - 2.0) > 0.3) continue;

    log(`Border scan at y=${sy}: left=${leftBorder}, right=${rightBorder}, bottom=${bottomBorder}, top=${boardY.toFixed(0)}, cellW=${cellW.toFixed(1)}, ratio=${ratio.toFixed(2)}`);

    // --- Verify borders are consistent along their full length ---
    let borderHits = 0;
    let borderTests = 0;
    for (let testY = boardY + cellW * 2; testY < bottomBorder - cellW; testY += cellW * 3) {
      borderTests += 2;
      if (isBorder(leftBorder, testY)) borderHits++;
      if (isBorder(rightBorder, testY)) borderHits++;
    }
    if (borderTests > 0 && borderHits < borderTests * 0.6) {
      log(`  Border verification failed: ${borderHits}/${borderTests} hits`);
      continue;
    }

    boardRect = { x: boardX, y: boardY, cellW, cellH: cellW };

    if (validateBoard(imageData)) {
      log('Board calibrated successfully!');
      return true;
    }
  }

  log('Border detection failed at all scan lines.');
  return false;
}

function validateBoard(imageData: ImageData): boolean {
  const boardBottom = boardRect.y + 20 * boardRect.cellH;
  const boardRight = boardRect.x + 10 * boardRect.cellW;
  if (boardBottom > imageData.height || boardRight > imageData.width) {
    log(`  Validation failed: extends outside canvas`);
    return false;
  }

  // Sample top 5 rows — most should be dark/empty and opaque
  let darkCount = 0;
  let opaqueCount = 0;
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 10; col++) {
      const px = boardRect.x + (col + 0.5) * boardRect.cellW;
      const py = boardRect.y + (row + 0.5) * boardRect.cellH;
      const [r, g, b, a] = getPixel(imageData, px, py);
      if (a > 50) opaqueCount++;
      // Board bg is ~rgb(20,24,49) = sum ~93; allow up to 150 for slightly brighter themes
      if (r + g + b < 150) darkCount++;
    }
  }
  log(`  Validation: ${darkCount}/50 dark, ${opaqueCount}/50 opaque`);
  return darkCount > 25 && opaqueCount > 30;
}

// ===== Board State Reading =====

interface CellResult {
  piece: PieceType | null;
  logs: string;
  maxCount: number;
  emptyVotes: number;
  /** True when this cell only resolved via the lenient secondary pass. */
  fromFallback: boolean;
}

function pickMaxPiece(counts: Record<PieceType, number>): { piece: PieceType | null; count: number; second: number } {
  let maxPiece: PieceType | null = null;
  let maxCount = 0;
  let secondCount = 0;
  for (const p of Object.keys(counts) as PieceType[]) {
    const c = counts[p];
    if (c > maxCount) {
      secondCount = maxCount;
      maxCount = c;
      maxPiece = p;
    } else if (c > secondCount) {
      secondCount = c;
    }
  }
  return { piece: maxPiece, count: maxCount, second: secondCount };
}

function sampleCellVotes(
  imageData: ImageData,
  cellCenterX: number,
  cellCenterY: number,
  cw: number,
  ch: number,
  minSat: number,
): {
  counts: Record<PieceType, number>;
  emptyVotes: number;
  unrecogVotes: number;
  firstUnrecog: string;
} {
  const counts: Record<PieceType, number> = { Z: 0, L: 0, O: 0, S: 0, I: 0, J: 0, T: 0 };
  let emptyVotes = 0;
  let unrecogVotes = 0;
  let firstUnrecog = '';

  const marginX = cw * 0.2;
  const marginY = ch * 0.2;
  const startX = cellCenterX - marginX;
  const startY = cellCenterY - marginY;
  const stepX = (marginX * 2) / 4;
  const stepY = (marginY * 2) / 4;

  for (let dx = 0; dx <= 4; dx++) {
    for (let dy = 0; dy <= 4; dy++) {
      const px = startX + dx * stepX;
      const py = startY + dy * stepY;
      const [r, g, b, a] = getPixel(imageData, px, py);

      if (a < 50 || isEmptyCell(r, g, b, a, minSat)) {
        emptyVotes++;
      } else {
        const piece = colorToPiece(r, g, b, minSat);
        if (piece) {
          counts[piece]++;
        } else {
          unrecogVotes++;
          if (!firstUnrecog) firstUnrecog = `?${r},${g},${b}`;
        }
      }
    }
  }

  return { counts, emptyVotes, unrecogVotes, firstUnrecog };
}

/**
 * Classify a single board cell. First runs the strict pass (original thresholds)
 * so well-rendered cells keep their prior behaviour, then falls back to a
 * looser pass for animation frames where saturation briefly drops.
 */
function getCellPiece(
  imageData: ImageData,
  cellCenterX: number,
  cellCenterY: number,
  cw: number,
  ch: number,
  minSat: number,
): CellResult {
  const strict = sampleCellVotes(imageData, cellCenterX, cellCenterY, cw, ch, minSat);
  const strictBest = pickMaxPiece(strict.counts);

  if (
    strictBest.count >= 10 &&
    strictBest.count > strict.emptyVotes &&
    strictBest.count > strict.unrecogVotes
  ) {
    return {
      piece: strictBest.piece,
      logs: ` ${strictBest.piece} `,
      maxCount: strictBest.count,
      emptyVotes: strict.emptyVotes,
      fromFallback: false,
    };
  }

  // Fallback pass: lower saturation gate + lower vote count. This saves the
  // spawn-animation frames where pieces render with reduced saturation.
  const lenientSat = Math.max(0.22, minSat - 0.13);
  const lenient = sampleCellVotes(imageData, cellCenterX, cellCenterY, cw, ch, lenientSat);
  const lenientBest = pickMaxPiece(lenient.counts);

  // Require a clearer win in fallback (count >= 6 AND dominates empties AND
  // 2× the second-best piece) to keep false positives low on background pixels.
  if (
    lenientBest.count >= 6 &&
    lenientBest.count > lenient.emptyVotes &&
    lenientBest.count >= lenient.unrecogVotes &&
    lenientBest.count >= lenientBest.second * 2
  ) {
    return {
      piece: lenientBest.piece,
      logs: ` ${lenientBest.piece}*`,
      maxCount: lenientBest.count,
      emptyVotes: lenient.emptyVotes,
      fromFallback: true,
    };
  }

  const logs =
    strict.unrecogVotes > strict.emptyVotes && strictBest.count < 10
      ? strict.firstUnrecog || ' ? '
      : ' . ';
  return {
    piece: null,
    logs,
    maxCount: strictBest.count,
    emptyVotes: strict.emptyVotes,
    fromFallback: false,
  };
}

function readBoard(imageData: ImageData): { board: (PieceType | null)[][]; fallbackHits: number } {
  const board: (PieceType | null)[][] = [];
  let fallbackHits = 0;

  for (let row = 0; row < 20; row++) {
    const boardRow: (PieceType | null)[] = [];
    for (let col = 0; col < 10; col++) {
      const px = boardRect.x + (col + 0.5) * boardRect.cellW;
      const py = boardRect.y + (row + 0.5) * boardRect.cellH;
      const result = getCellPiece(imageData, px, py, boardRect.cellW, boardRect.cellH, 0.35);
      boardRow.push(result.piece);
      if (result.fromFallback) fallbackHits++;
    }
    board.push(boardRow);
  }

  return { board, fallbackHits };
}

/**
 * Read the next queue (5 pieces to the right of the board).
 * Scans a wide area to the right of the board, finds colored pixels,
 * and clusters them by Y position to determine queue slots.
 */
function readQueue(imageData: ImageData): PieceType[] {
  const cw = boardRect.cellW;
  const ch = boardRect.cellH;
  const rightEdge = boardRect.x + cw * 10;

  // Scan a wide area: 1-7 cells right of board, -1 to 22 cells from board top.
  // Extended Y range to reliably capture the 5th preview piece.
  // Lowered saturation threshold because preview pieces are dimmer than board pieces.
  const found: { piece: PieceType; y: number }[] = [];

  for (let xOff = 0.5; xOff <= 7; xOff += 0.5) {
    for (let yOff = -1; yOff <= 30; yOff += 0.25) {
      const sx = rightEdge + cw * xOff;
      const sy = boardRect.y + ch * yOff;
      if (sx >= imageData.width || sy >= imageData.height || sy < 0) continue;
      const [r, g, b, a] = getPixel(imageData, sx, sy);
      if (isFilledCell(r, g, b, a, 0.20)) {
        const piece = colorToPiece(r, g, b, 0.20);
        if (piece) {
          found.push({ piece, y: sy });
        }
      }
    }
  }

  if (found.length === 0) return [];

  // Cluster by Y position. Preview slots are spaced ~3 cells apart in TETR.IO,
  // so 2.2 cell tolerance merges samples within one slot without bleeding into
  // the next — more forgiving than the prior 1.5, which split thin preview icons.
  found.sort((a, b) => a.y - b.y);
  const clusters: typeof found[] = [];
  let currentCluster: typeof found = [found[0]];

  for (let i = 1; i < found.length; i++) {
    if (found[i].y - currentCluster[currentCluster.length - 1].y < ch * 2.2) {
      currentCluster.push(found[i]);
    } else {
      clusters.push(currentCluster);
      currentCluster = [found[i]];
    }
  }
  clusters.push(currentCluster);

  // For each cluster, determine piece type by majority vote. Require ≥3 matching
  // pixels — lower thresholds let UI blue/dark pixels near the hold box and
  // board edges get classified as I and hijack the queue reads.
  const queue: PieceType[] = [];
  for (const cluster of clusters) {
    if (queue.length >= 5) break;
    const counts: Partial<Record<PieceType, number>> = {};
    for (const item of cluster) {
      counts[item.piece] = (counts[item.piece] || 0) + 1;
    }
    let bestPiece: PieceType | null = null;
    let bestCount = 0;
    for (const [p, c] of Object.entries(counts)) {
      if (c! > bestCount) { bestCount = c!; bestPiece = p as PieceType; }
    }
    if (bestPiece && bestCount >= 3) queue.push(bestPiece);
  }

  return queue;
}

/**
 * ROI-based queue reader: samples 5 fixed regions at yOff 1.5 / 4.5 / 7.5 / 10.5 / 13.5
 * (TETR.IO preview slots are spaced ~3 cells apart). This bypasses the sensitive
 * Y-clustering logic in readQueue, so a single slot whose pixels are sparse can
 * still be classified.
 */
function readQueueByROI(imageData: ImageData): PieceType[] {
  const cw = boardRect.cellW;
  const ch = boardRect.cellH;
  const rightEdge = boardRect.x + cw * 10;

  const slotCenters = [1.5, 4.5, 7.5, 10.5, 13.5];
  const queue: PieceType[] = [];

  for (const yOff of slotCenters) {
    const counts: Record<PieceType, number> = { Z: 0, L: 0, O: 0, S: 0, I: 0, J: 0, T: 0 };
    let totalHits = 0;

    // Sample 30 points within the ROI box: 6 xOff * 5 yOff subsamples.
    for (let xOff = 1.5; xOff <= 5; xOff += 0.7) {
      for (let dy = -1; dy <= 1; dy += 0.5) {
        const sx = rightEdge + cw * xOff;
        const sy = boardRect.y + ch * (yOff + dy);
        if (sx >= imageData.width || sy >= imageData.height || sy < 0) continue;
        const [r, g, b, a] = getPixel(imageData, sx, sy);
        if (isFilledCell(r, g, b, a, 0.20)) {
          const piece = colorToPiece(r, g, b, 0.20);
          if (piece) {
            counts[piece]++;
            totalHits++;
          }
        }
      }
    }

    const { piece, count, second } = pickMaxPiece(counts);
    // Accept a slot when it has at least 2 matching samples AND clearly beats
    // the runner-up. This keeps UI tint bleeds from being classified as I.
    if (piece && count >= 2 && count >= Math.max(2, second * 2) && totalHits >= 2) {
      queue.push(piece);
    } else {
      break; // Preview slots are contiguous; a missing slot ends the queue.
    }
  }

  return queue;
}

/**
 * Read the hold piece (to the left of the board).
 * Scans a wide area to the left of the board for any colored piece.
 */
function readHoldPiece(imageData: ImageData): PieceType | null {
  const cw = boardRect.cellW;
  const ch = boardRect.cellH;

  // The hold box sits just to the left of the board, spanning roughly
  // yOff -0.5 to 4 cells from the board top. Constrained Y range avoids
  // picking up the blue "HOLD" label or other UI elements below the box.
  const found: { piece: PieceType }[] = [];

  for (let xOff = 0.5; xOff <= 5; xOff += 0.5) {
    for (let yOff = -0.5; yOff <= 4; yOff += 0.4) {
      const sx = boardRect.x - cw * xOff;
      const sy = boardRect.y + ch * yOff;
      if (sx < 0 || sy < 0 || sy >= imageData.height) continue;
      const [r, g, b, a] = getPixel(imageData, sx, sy);
      if (isFilledCell(r, g, b, a, 0.20)) {
        const piece = colorToPiece(r, g, b, 0.20);
        if (piece) found.push({ piece });
      }
    }
  }

  // Require a strong signal — an actual held piece occupies a 2×2+ area inside
  // the hold box and produces dozens of matching pixels in our sweep. Anything
  // under 6 is almost certainly UI chrome (label text, border gradients) and
  // would have caused the bot to "hold" a phantom piece.
  if (found.length < 6) return null;

  const counts: Partial<Record<PieceType, number>> = {};
  for (const f of found) {
    counts[f.piece] = (counts[f.piece] || 0) + 1;
  }
  let bestPiece: PieceType | null = null;
  let bestCount = 0;
  let secondCount = 0;
  for (const [p, c] of Object.entries(counts)) {
    if (c! > bestCount) {
      secondCount = bestCount;
      bestCount = c!;
      bestPiece = p as PieceType;
    } else if (c! > secondCount) {
      secondCount = c!;
    }
  }

  // Reject ambiguous reads: the winner must dominate by 3× to filter out
  // mixed UI colour noise across hue boundaries.
  if (bestCount < 6 || bestCount < secondCount * 3) return null;
  return bestPiece;
}

/**
 * Verify current piece type by scanning spawn rows (rows 0-2 of visible board).
 * Returns the dominant piece type found near the top, or null if no piece detected.
 * This is a lightweight verification — no flood-fill, no board mutation.
 */
function detectSpawnRowPiece(imageData: ImageData): PieceType | null {
  const counts: Record<PieceType, number> = { Z: 0, L: 0, O: 0, S: 0, I: 0, J: 0, T: 0 };
  let totalHits = 0;

  // Sample the top 3 visible rows (spawn area), all 10 columns
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 10; col++) {
      const px = boardRect.x + (col + 0.5) * boardRect.cellW;
      const py = boardRect.y + (row + 0.5) * boardRect.cellH;
      const [r, g, b, a] = getPixel(imageData, px, py);
      if (a < 50) continue;
      const piece = colorToPiece(r, g, b, 0.30);
      if (piece) {
        counts[piece]++;
        totalHits++;
      }
    }
  }

  if (totalHits < 2) return null;

  let bestPiece: PieceType | null = null;
  let bestCount = 0;
  for (const p of Object.keys(counts) as PieceType[]) {
    if (counts[p] > bestCount) {
      bestCount = counts[p];
      bestPiece = p;
    }
  }

  return bestCount >= 2 ? bestPiece : null;
}

// ===== Game Active Detection =====

function isGameActive(imageData: ImageData): boolean {
  if (!calibrated) return false;

  // Check multiple points across the board — if most are opaque, game is active
  let opaqueCount = 0;
  const checkPoints = [
    [0.5, 0.25], [0.5, 0.50], [0.5, 0.75],  // center column at 25%, 50%, 75% height
    [0.25, 0.50], [0.75, 0.50],              // left and right at center height
  ];
  for (const [fx, fy] of checkPoints) {
    const px = boardRect.x + boardRect.cellW * 10 * fx;
    const py = boardRect.y + boardRect.cellH * 20 * fy;
    const [, , , a] = getPixel(imageData, px, py);
    if (a > 50) opaqueCount++;
  }
  return opaqueCount >= 3;
}

// ===== Input Execution (Main World) =====
// Keyboard events MUST be dispatched from main world (not isolated content script)
// so that TETR.IO's event listeners can receive them.

const INPUT_KEY_MAP: Record<string, string> = {
  moveLeft: 'ArrowLeft',
  moveRight: 'ArrowRight',
  softDrop: 'ArrowDown',
  hardDrop: 'Space',
  rotateCW: 'ArrowUp',
  rotateCCW: 'KeyZ',
  rotate180: 'KeyA',
  hold: 'KeyC',
};

let isExecutingMoves = false;

// Map KeyboardEvent.code → KeyboardEvent.key (character the key produces)
const CODE_TO_KEY: Record<string, string> = {
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ArrowDown: 'ArrowDown',
  ArrowUp: 'ArrowUp',
  Space: ' ',
  KeyZ: 'z',
  KeyA: 'a',
  KeyC: 'c',
};

function dispatchGameKey(code: string, eventType: 'keydown' | 'keyup'): void {
  const target = document.activeElement || document.body;
  target.dispatchEvent(
    new KeyboardEvent(eventType, {
      code,
      key: CODE_TO_KEY[code] ?? code,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function pressGameKey(code: string): Promise<void> {
  return new Promise(resolve => {
    dispatchGameKey(code, 'keydown');
    setTimeout(() => {
      dispatchGameKey(code, 'keyup');
      resolve();
    }, 2);
  });
}

function inputDelay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function executeMovesFromMessage(data: {
  sequence: { hold: boolean; rotations: number; horizontalMoves: number; use180: boolean };
  keyDelay?: number;
}): Promise<void> {
  if (isExecutingMoves) return;
  isExecutingMoves = true;

  const seq = data.sequence;
  const kd = data.keyDelay ?? 50;

  try {
    if (seq.hold) {
      await pressGameKey(INPUT_KEY_MAP.hold);
      // Hold swap needs a short extra pause for TETR.IO to process the swap.
      // One frame (~16ms) plus a small buffer is enough with ARR=0.
      await inputDelay(kd + 20);
    }

    if (seq.use180) {
      await pressGameKey(INPUT_KEY_MAP.rotate180);
      await inputDelay(kd);
    } else if (seq.rotations > 0) {
      for (let i = 0; i < seq.rotations; i++) {
        await pressGameKey(INPUT_KEY_MAP.rotateCW);
        await inputDelay(kd);
      }
    } else if (seq.rotations < 0) {
      for (let i = 0; i < Math.abs(seq.rotations); i++) {
        await pressGameKey(INPUT_KEY_MAP.rotateCCW);
        await inputDelay(kd);
      }
    }

    if (seq.horizontalMoves > 0) {
      for (let i = 0; i < seq.horizontalMoves; i++) {
        await pressGameKey(INPUT_KEY_MAP.moveRight);
        await inputDelay(kd);
      }
    } else if (seq.horizontalMoves < 0) {
      for (let i = 0; i < Math.abs(seq.horizontalMoves); i++) {
        await pressGameKey(INPUT_KEY_MAP.moveLeft);
        await inputDelay(kd);
      }
    }

    await pressGameKey(INPUT_KEY_MAP.hardDrop);
    // Brief cooldown for lock animation + line-clear + next-piece spawn.
    postDropCooldown = 1;
  } finally {
    isExecutingMoves = false;
    window.postMessage({ type: 'MOVES_COMPLETE' }, '*');
  }
}

// ===== Debug: Dump color samples =====

function dumpColorSamples(imageData: ImageData): void {
  log('=== COLOR SAMPLES FROM CANVAS ===');
  log(`Canvas size: ${imageData.width}x${imageData.height}`);

  const w = imageData.width;
  const h = imageData.height;

  // Sample a grid of points across the canvas
  for (let yi = 0; yi < 10; yi++) {
    const y = Math.floor(h * (yi + 0.5) / 10);
    const rowSamples: string[] = [];
    for (let xi = 0; xi < 20; xi++) {
      const x = Math.floor(w * (xi + 0.5) / 20);
      const [r, g, b, a] = getPixel(imageData, x, y);
      if (a < 10) {
        rowSamples.push('.....');
      } else {
        rowSamples.push(`${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`);
      }
    }
    log(`  y=${y}: ${rowSamples.join(' ')}`);
  }
}

// ===== Main Loop =====

let pollActive = false;
let rafId: number | null = null;
let phase = 0;
let debugDumped = false;
let boardDebugDumped = false;
let lastQueue: PieceType[] = [];
let lastBoardKey = '';
let lastFilledCount = 0;
let globalPieceCounter = 0;
/** Polls remaining during which we suppress state emits after a hard-drop so
 *  the lock animation + potential line-clear settles before the next read. */
let postDropCooldown = 0;
/** Process every Nth rAF frame (2 = ~30fps effective rate, saves CPU). */
const FRAME_SKIP = 2;
let frameCount = 0;
const queueHistory: PieceType[][] = [];
const QUEUE_HISTORY_SIZE = 5;
/** A slot must appear with the same piece in ≥ this many of the last N frames. */
const QUEUE_STABILITY_MIN = 3;

/** Per-position majority vote across recent queue reads to suppress flicker. */
function smoothQueue(history: PieceType[][]): PieceType[] {
  if (history.length === 0) return [];
  const maxLen = Math.max(...history.map(q => q.length));
  const result: PieceType[] = [];
  for (let i = 0; i < maxLen; i++) {
    const counts: Partial<Record<PieceType, number>> = {};
    for (const q of history) {
      if (q[i]) counts[q[i]] = (counts[q[i]] || 0) + 1;
    }
    let best: PieceType | null = null;
    let bestC = 0;
    for (const [p, c] of Object.entries(counts)) {
      if (c! > bestC) { bestC = c!; best = p as PieceType; }
    }
    // Require stability: only append the slot if the majority hit the minimum
    // threshold. Missing a single slot ends the reliable prefix.
    const needed = Math.min(QUEUE_STABILITY_MIN, history.length);
    if (best && bestC >= needed) result.push(best);
    else break;
  }
  return result;
}

function pollOnce(): void {
    phase++;

    // Find/re-find the game canvas
    const foundCanvas = findGameCanvas();
    if (!foundCanvas) return;
    if (foundCanvas !== gameCanvas) {
      gameCanvas = foundCanvas;
      calibrated = false;
      log(`Game canvas found: ${gameCanvas.width}x${gameCanvas.height} (display: ${gameCanvas.getBoundingClientRect().width.toFixed(0)}x${gameCanvas.getBoundingClientRect().height.toFixed(0)})`);
    }

    // Capture pixels
    const imageData = capturePixels();
    if (!imageData) return;

    // Debug: dump color samples once
    if (!debugDumped && phase >= 30) {
      debugDumped = true;
      dumpColorSamples(imageData);
    }

    // Calibrate board position
    if (!calibrated) {
      if (phase % 10 === 0) { // Try every second
        calibrated = calibrateBoard(imageData);
        if (!calibrated && phase >= 100) {
          log('Board calibration failed after 10s. Are you in a game?');
        }
      }
      return;
    }

    // Check if game is active
    const active = isGameActive(imageData);

    // Debug: dump board reading once after calibration
    if (calibrated && !boardDebugDumped) {
      boardDebugDumped = true;
      log('=== POST-CALIBRATION DEBUG v3 (dual-track + diagnostics) ===');
      log(`boardRect: x=${boardRect.x.toFixed(1)} y=${boardRect.y.toFixed(1)} cellW=${boardRect.cellW.toFixed(2)} cellH=${boardRect.cellH.toFixed(2)}`);

      // Show board center pixel
      const cx = boardRect.x + boardRect.cellW * 5;
      const cy = boardRect.y + boardRect.cellH * 10;
      const [cr, cg, cb, ca] = getPixel(imageData, cx, cy);
      const [ch, cs, cl] = rgbToHsl(cr, cg, cb);
      log(`Board center: rgba(${cr},${cg},${cb},${ca}) hsl(${ch.toFixed(0)},${(cs*100).toFixed(0)}%,${(cl*100).toFixed(0)}%) bright=${cr+cg+cb} — active: ${active}`);

      // Phase 1.4: dump each expected queue ROI centre so a UI-theme change can
      // be diagnosed without a full run. Also dump the hold centre + bottom
      // board rows (likely to contain locked cells mid-game).
      log('=== QUEUE ROI SAMPLES (5 slots) ===');
      for (const [i, yOff] of [1.5, 4.5, 7.5, 10.5, 13.5].entries()) {
        const sx = boardRect.x + boardRect.cellW * (10 + 3);
        const sy = boardRect.y + boardRect.cellH * yOff;
        const [pr, pg, pb, pa] = getPixel(imageData, sx, sy);
        const [ph, ps, pl] = rgbToHsl(pr, pg, pb);
        const piece = colorToPiece(pr, pg, pb, 0.20);
        log(`  slot ${i + 1} (y=${sy.toFixed(0)}): rgba(${pr},${pg},${pb},${pa}) hsl(${ph.toFixed(0)},${(ps * 100).toFixed(0)}%,${(pl * 100).toFixed(0)}%) → ${piece ?? '-'}`);
      }
      log('=== HOLD ROI SAMPLE ===');
      {
        const sx = boardRect.x - boardRect.cellW * 3;
        const sy = boardRect.y + boardRect.cellH * 1.5;
        const [pr, pg, pb, pa] = getPixel(imageData, sx, sy);
        const [ph, ps, pl] = rgbToHsl(pr, pg, pb);
        const piece = colorToPiece(pr, pg, pb, 0.20);
        log(`  hold (y=${sy.toFixed(0)}): rgba(${pr},${pg},${pb},${pa}) hsl(${ph.toFixed(0)},${(ps * 100).toFixed(0)}%,${(pl * 100).toFixed(0)}%) → ${piece ?? '-'}`);
      }
      log('=== BOARD BOTTOM ROWS (18,19) ===');
      for (const row of [18, 19]) {
        const samples: string[] = [];
        for (let col = 0; col < 10; col++) {
          const px = boardRect.x + (col + 0.5) * boardRect.cellW;
          const py = boardRect.y + (row + 0.5) * boardRect.cellH;
          const [rr, gg, bb] = getPixel(imageData, px, py);
          const [hh, ss, ll] = rgbToHsl(rr, gg, bb);
          samples.push(`${rr},${gg},${bb}(s${(ss * 100).toFixed(0)}l${(ll * 100).toFixed(0)}h${hh.toFixed(0)})`);
        }
        log(`  row${row}: ${samples.join(' | ')}`);
      }

      // Sample each cell with robust voting mechanism
      log('=== BOARD CELLS (first 8 rows) ===');
      for (let row = 0; row < 8; row++) {
        const cells: string[] = [];
        for (let col = 0; col < 10; col++) {
          const px = boardRect.x + (col + 0.5) * boardRect.cellW;
          const py = boardRect.y + (row + 0.5) * boardRect.cellH;
          const result = getCellPiece(imageData, px, py, boardRect.cellW, boardRect.cellH, 0.55);
          cells.push(result.logs);
        }
        log(`  row ${row}: [${cells.join('|')}]`);
      }

      // Queue area: scan wider area to find queue pieces
      log('=== QUEUE SCAN (right of board) ===');
      const queueBaseX = boardRect.x + boardRect.cellW * 10; // right edge of board
      for (let xOff = 1; xOff <= 5; xOff++) {
        const scanX = queueBaseX + boardRect.cellW * xOff;
        const samples: string[] = [];
        for (let yOff = 0; yOff < 20; yOff++) {
          const scanY = boardRect.y + boardRect.cellH * yOff;
          const [r, g, b, a] = getPixel(imageData, scanX, scanY);
          if (a < 10 || r + g + b < 50) {
            samples.push('.');
          } else {
            const piece = colorToPiece(r, g, b);
            if (piece) {
              samples.push(piece);
            } else {
              samples.push('-');
            }
          }
        }
        log(`  x+${xOff}cells: ${samples.join('')}`);
      }

      // Also scan hold area (left of board)
      log('=== HOLD SCAN (left of board) ===');
      const holdBaseX = boardRect.x; // left edge of board
      for (let xOff = 1; xOff <= 5; xOff++) {
        const scanX = holdBaseX - boardRect.cellW * xOff;
        const samples: string[] = [];
        for (let yOff = 0; yOff < 8; yOff++) {
          const scanY = boardRect.y + boardRect.cellH * yOff;
          const [r, g, b, a] = getPixel(imageData, scanX, scanY);
          if (a < 10 || r + g + b < 50) {
            samples.push('.');
          } else {
            const piece = colorToPiece(r, g, b);
            if (piece) {
              samples.push(piece);
            } else {
              samples.push('-');
            }
          }
        }
        log(`  x-${xOff}cells: ${samples.join('')}`);
      }
    }

    if (!active) return;

    // Read raw board (includes active piece + ghost piece — no flood-fill mutation).
    // Content-script will subtract active piece cells using known spawn position.
    const { board: boardVisible, fallbackHits } = readBoard(imageData);
    const board: (PieceType | null)[][] = [
      ...Array.from({ length: 4 }, () => Array(10).fill(null) as (PieceType | null)[]),
      ...boardVisible,
    ];

    // Queue reading: use ROI-based reader (more stable) with contiguous-scan fallback
    const queueROI = readQueueByROI(imageData);
    const queueOld = readQueue(imageData);
    const rawQueue = queueROI.length >= queueOld.length ? queueROI : queueOld;
    queueHistory.push(rawQueue);
    if (queueHistory.length > QUEUE_HISTORY_SIZE) queueHistory.shift();
    const nextQueue = smoothQueue(queueHistory);
    const holdPiece = readHoldPiece(imageData);

    if (fallbackHits > 100 && phase % 50 === 0) {
      log(`[vision] Board fallback hits ${fallbackHits}/200 cells — many cells needed the lenient pass`);
    }

    // --- Current piece detection: queue-based inference (primary) ---
    // When the queue shifts, the piece that left queue[0] is now the active piece.
    // This is far more reliable than flood-fill, which merges active + ghost piece.
    const queueChanged = nextQueue.length > 0 && lastQueue.length > 0 &&
      nextQueue.join(',') !== lastQueue.join(',');

    const boardKey = board.flat().map(c => c ?? '.').join('');
    const boardChanged = boardKey !== lastBoardKey;
    lastBoardKey = boardKey;
    const filledCount = board.flat().filter(c => c !== null).length;

    if (postDropCooldown > 0) {
      postDropCooldown--;
      lastFilledCount = filledCount;
      lastQueue = [...nextQueue];
      return;
    }

    // Determine current piece type
    let currentPieceType: PieceType | null = null;
    let pieceSource: 'queue' | 'spawn' | 'none' = 'none';

    if (queueChanged) {
      // Primary: queue shifted — the old queue[0] is now the active piece
      globalPieceCounter++;
      currentPieceType = lastQueue[0];
      pieceSource = 'queue';
    } else if (boardChanged && lastQueue.length > 0) {
      // Fallback: board changed but queue didn't update yet — still count it
      globalPieceCounter++;
      currentPieceType = lastQueue[0] ?? null;
      pieceSource = currentPieceType ? 'queue' : 'none';
    }

    // Verification: check spawn rows for a colored piece as secondary confirmation
    if (!currentPieceType) {
      const spawnPiece = detectSpawnRowPiece(imageData);
      if (spawnPiece) {
        currentPieceType = spawnPiece;
        pieceSource = 'spawn';
        // Only increment counter if this looks like a genuinely new piece
        if (boardChanged) globalPieceCounter++;
      }
    }

    lastQueue = [...nextQueue];
    lastFilledCount = filledCount;

    if (phase % 50 === 0) {
      log(`State: ${filledCount} filled, piece=${currentPieceType ?? 'none'}(${pieceSource}), queue=[${nextQueue.join(',')}], hold=${holdPiece ?? 'none'}`);
    }

    if (currentPieceType && nextQueue.length >= 1) {
      const currentPiece = {
        type: currentPieceType,
        rotation: 0,
        x: currentPieceType === 'O' ? 4 : 3,
        y: 4, // row 4 = top of visible area (after 4 buffer rows)
      };

      const state: GameState = {
        board,
        currentPiece,
        nextQueue,
        holdPiece,
        canHold: true,
        isPlaying: true,
      };

      window.postMessage(
        {
          type: 'TETRIO_GAME_STATE',
          state,
          pieceCounter: globalPieceCounter,
          pieceSource,
          filledCount,
          rawBoard: true, // Signal that board includes active piece cells
        },
        '*',
      );
    }
}

function rafLoop(): void {
  if (!pollActive) return;
  frameCount++;
  // Only do full processing every FRAME_SKIP frames (~30fps at 60hz)
  if (frameCount % FRAME_SKIP === 0) {
    pollOnce();
  }
  rafId = requestAnimationFrame(rafLoop);
}

function startPolling(): void {
  if (pollActive) return;
  log('Starting canvas pixel reading (rAF)...');
  pollActive = true;
  phase = 0;
  frameCount = 0;
  globalPieceCounter = 0;
  calibrated = false;
  debugDumped = false;
  boardDebugDumped = false;
  lastFilledCount = 0;
  lastBoardKey = '';
  lastQueue = [];
  queueHistory.length = 0;
  rafId = requestAnimationFrame(rafLoop);
}

function stopPolling(): void {
  if (pollActive) {
    pollActive = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    phase = 0;
    calibrated = false;
    log('Polling stopped.');
  }
}

// ===== Messages =====

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type === 'BOT_START') startPolling();
  else if (event.data?.type === 'BOT_STOP') stopPolling();
  else if (event.data?.type === 'EXECUTE_MOVES') executeMovesFromMessage(event.data);
});

log('Game hook v4 (canvas reader) injected.');
startPolling();
