/**
 * Game Hook v5 — Coordinator only.
 *
 * Runs in main world (manifest world="MAIN"). Responsibilities:
 *   1. Patch HTMLCanvasElement.getContext to force preserveDrawingBuffer
 *      (required to read WebGL pixels later).
 *   2. Override visibility/focus APIs so the game doesn't pause when DevTools
 *      is open or the window loses focus.
 *   3. Drive the main poll loop: capture pixels → calibrate → read board /
 *      queue / hold → detect active piece → emit GameState to content-script.
 *   4. Receive EXECUTE_MOVES messages from content-script and dispatch the
 *      keypress sequence in the main world (so TETR.IO's listeners receive them).
 *
 * Heavy lifting (palette learning, calibration, classification, executor) lives
 * in `src/vision/` and `src/input/`.
 */

import { PieceType, GameState, Board, BOARD_WIDTH, BOARD_HEIGHT } from '@/types';
import {
  AdaptivePalette,
} from '@/vision/colors';
import {
  BoardRect,
  SideROI,
  calibrateBoard,
  calibrateQueueROI,
  calibrateHoldROI,
} from '@/vision/calibration';
import {
  readBoard,
  readQueue,
  readHold,
  collectPaletteSamples,
} from '@/vision/board-reader';
import {
  detectActivePiece,
  stripActivePiece,
  fallbackSpawnDetection,
} from '@/vision/active-piece';
import { StateTracker } from '@/vision/state-tracker';
import { executeMoveSequence, MoveSequence } from '@/input/executor';

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log('[TETRIO-BOT Hook]', ...args);
}

// ===== Patch getContext BEFORE PIXI creates the WebGL context =====

const _origGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (
  this: HTMLCanvasElement,
  type: string,
  attrs?: Record<string, unknown>,
): RenderingContext | null {
  if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
    const newAttrs = { ...attrs, preserveDrawingBuffer: true };
    return _origGetContext.call(this, type, newAttrs) as RenderingContext | null;
  }
  return _origGetContext.call(this, type, attrs) as RenderingContext | null;
} as typeof HTMLCanvasElement.prototype.getContext;

// ===== Block focus/visibility detection so DevTools doesn't pause the game =====

Object.defineProperty(document, 'hidden', { get: () => false });
Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
document.addEventListener('visibilitychange', e => e.stopImmediatePropagation(), true);
window.addEventListener('blur', e => e.stopImmediatePropagation(), true);
Document.prototype.hasFocus = () => true;

// ===== Canvas capture =====

let gameCanvas: HTMLCanvasElement | null = null;
let readCanvas: HTMLCanvasElement | null = null;
let readCtx: CanvasRenderingContext2D | null = null;

function findGameCanvas(): HTMLCanvasElement | null {
  const canvases = document.querySelectorAll('canvas');
  let best: HTMLCanvasElement | null = null;
  let maxArea = 0;
  for (const c of canvases) {
    if (c.width === 256 && c.height === 256) continue; // texture atlas
    const rect = c.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > maxArea && rect.width > 400 && rect.height > 400) {
      maxArea = area;
      best = c;
    }
  }
  return best;
}

function ensureReadCanvas(w: number, h: number): void {
  if (!readCanvas || readCanvas.width !== w || readCanvas.height !== h) {
    readCanvas = document.createElement('canvas');
    readCanvas.width = w;
    readCanvas.height = h;
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
  readCtx.drawImage(gameCanvas, 0, 0);
  return readCtx.getImageData(0, 0, w, h);
}

// ===== Bot State =====

const palette = new AdaptivePalette();
const tracker = new StateTracker();

let boardRect: BoardRect | null = null;
let queueROI: SideROI | null = null;
let holdROI: SideROI | null = null;
let calibrationAttempt = 0;
let paletteFinalized = false;
let paletteSampleFrames = 0;

let lastEmittedQueue: PieceType[] = [];
let lastEmittedHold: PieceType | null = null;
let pieceCounter = 0;
let lastBoardEmpty = true;

let pollActive = false;
let rafId: number | null = null;
let frameCount = 0;
const FRAME_SKIP = 2;
let lastBoardForExecutor: Board = createEmptyBoard();

function createEmptyBoard(): Board {
  return Array.from({ length: BOARD_HEIGHT }, () =>
    Array<PieceType | null>(BOARD_WIDTH).fill(null),
  );
}

// ===== Game state pad (visible → 24-row with 4 buffer rows) =====

function padBoardWithBuffer(visible: Board): Board {
  return [
    ...Array.from({ length: 4 }, () => Array<PieceType | null>(BOARD_WIDTH).fill(null)),
    ...visible,
  ];
}

// ===== Palette bootstrap =====

/**
 * After we can read queue + hold via the fallback classifier, sample their
 * pixels into the adaptive palette. Once enough samples have accumulated,
 * finalize the palette so future classifications use it.
 */
function bootstrapPalette(
  imageData: ImageData,
  rect: BoardRect,
  qROI: SideROI,
  hROI: SideROI,
  queue: PieceType[],
  hold: PieceType | null,
): void {
  if (paletteFinalized) return;

  const samples: Array<{ piece: PieceType; x: number; y: number; w: number; h: number }> = [];
  const slotW = rect.cellW * 2.5;
  const slotH = qROI.slotHeight * 0.6;
  for (let i = 0; i < Math.min(queue.length, qROI.slotYs.length); i++) {
    samples.push({
      piece: queue[i],
      x: qROI.centerX,
      y: qROI.slotYs[i],
      w: slotW,
      h: slotH,
    });
  }
  if (hold && hROI.slotYs.length > 0) {
    samples.push({
      piece: hold,
      x: hROI.centerX,
      y: hROI.slotYs[0],
      w: slotW,
      h: hROI.slotHeight * 0.6,
    });
  }
  collectPaletteSamples(imageData, samples, palette);
  paletteSampleFrames++;

  // Try to finalize once we've collected from at least 8 frames (covers many piece types)
  if (paletteSampleFrames >= 8) {
    const learned = palette.finalize();
    if (palette.isReady()) {
      paletteFinalized = true;
      log(`Palette learned (${learned}/7 anchors): ${palette.describe()}`);
    } else if (paletteSampleFrames % 20 === 0) {
      const counts = palette.sampleCount();
      log(`Palette still learning (${learned}/7 anchors). Samples:`, counts);
    }
  }
}

// ===== Read snapshot helper (used by executor) =====

function readVisibleBoardOnly(): Board {
  if (!boardRect) return createEmptyBoard();
  const imageData = capturePixels();
  if (!imageData) return createEmptyBoard();
  const { board } = readBoard(imageData, boardRect, palette);
  return board;
}

// ===== Main poll =====

function pollOnce(): void {
  // Find or rediscover the game canvas
  const found = findGameCanvas();
  if (!found) return;
  if (found !== gameCanvas) {
    gameCanvas = found;
    boardRect = null;
    queueROI = null;
    holdROI = null;
    paletteFinalized = false;
    paletteSampleFrames = 0;
    palette.reset();
    log(`Game canvas found: ${gameCanvas.width}x${gameCanvas.height}`);
  }

  const imageData = capturePixels();
  if (!imageData) return;

  // Calibrate board
  if (!boardRect) {
    calibrationAttempt++;
    if (calibrationAttempt % 10 === 0) {
      boardRect = calibrateBoard(imageData);
      if (boardRect) {
        log(`Board calibrated: x=${boardRect.x.toFixed(0)} y=${boardRect.y.toFixed(0)} cell=${boardRect.cellW.toFixed(1)}`);
      } else if (calibrationAttempt >= 100) {
        log('Board calibration failed after 10s. Are you in a game?');
      }
    }
    return;
  }

  // Calibrate side ROIs (cheap; redo every 30s to catch UI re-layouts)
  if (!queueROI || !holdROI || frameCount % 900 === 0) {
    queueROI = calibrateQueueROI(imageData, boardRect);
    holdROI = calibrateHoldROI(imageData, boardRect);
    if (frameCount === 0 || !paletteFinalized) {
      log(`Queue ROI: ${queueROI.slotYs.length} slots y=[${queueROI.slotYs.map(y => y.toFixed(0)).join(',')}]`);
      log(`Hold ROI: y=${holdROI.slotYs[0]?.toFixed(0) ?? '?'}`);
    }
  }

  // Read raw board, queue, hold (using current palette state)
  const { board: visibleBoard, fallbackHits } = readBoard(imageData, boardRect, palette);
  const queue = readQueue(imageData, boardRect, queueROI, palette);
  const hold = readHold(imageData, boardRect, holdROI, palette);

  // Bootstrap palette while we can still see queue/hold pieces
  if (!paletteFinalized && queue.length >= 3) {
    bootstrapPalette(imageData, boardRect, queueROI, holdROI, queue, hold);
  }

  // Track hold observation
  tracker.observeHold(hold, pieceCounter);

  // Detect queue shift = new piece spawned (piece counter increments)
  const queueChanged =
    queue.length > 0 && lastEmittedQueue.length > 0 &&
    queue.join(',') !== lastEmittedQueue.join(',');

  let currentPieceType: PieceType | null = null;
  if (queueChanged) {
    currentPieceType = lastEmittedQueue[0] ?? null;
    if (currentPieceType) {
      pieceCounter++;
      tracker.onPieceSpawn();
    }
  } else if (lastBoardEmpty && queue.length >= 1) {
    // First piece: queue is established and board is empty → the active piece is queue[0]?
    // Actually queue[0] is the NEXT piece. The active piece on the board can be inferred
    // from the spawn area. For the very first piece, we wait for the queue to shift once.
  }

  lastEmittedQueue = [...queue];
  lastEmittedHold = hold;

  if (!currentPieceType) {
    // Still emit periodic diagnostic
    if (frameCount % 60 === 0) {
      log(`Idle: queue=[${queue.join(',')}] hold=${hold ?? '-'} fbHits=${fallbackHits}`);
    }
    return;
  }

  // Locate the actual active piece via shape matching in the spawn region
  const detection = detectActivePiece(visibleBoard, currentPieceType, 8)
    ?? fallbackSpawnDetection(currentPieceType);

  // Strip the active piece from the visible board to get the locked state
  const lockedVisible = stripActivePiece(
    visibleBoard,
    currentPieceType,
    detection.rotation,
    detection.x,
    detection.y,
  );
  lastBoardForExecutor = lockedVisible;
  lastBoardEmpty = lockedVisible.every(row => row.every(c => c === null));

  // Pad to 24 rows (4 buffer + 20 visible) for the AI engine's coordinate system.
  // detection.y is in the visible-board frame; the engine uses buffer-padded y,
  // so add 4 to express the active piece's y in the same frame.
  const paddedBoard = padBoardWithBuffer(lockedVisible);

  const state: GameState = {
    board: paddedBoard,
    currentPiece: {
      type: currentPieceType,
      rotation: detection.rotation,
      x: detection.x,
      y: detection.y + 4,
    },
    nextQueue: queue,
    holdPiece: hold,
    canHold: tracker.canHold(),
    isPlaying: true,
  };

  window.postMessage(
    {
      type: 'TETRIO_GAME_STATE',
      state,
      pieceCounter,
      confidence: detection.confidence,
      fallbackHits,
    },
    '*',
  );

  if (frameCount % 60 === 0) {
    log(
      `State: piece=${currentPieceType} rot=${detection.rotation} x=${detection.x} ` +
      `y=${detection.y} conf=${detection.confidence} queue=[${queue.join(',')}] ` +
      `hold=${hold ?? '-'} canHold=${tracker.canHold()} fbHits=${fallbackHits}`,
    );
  }
}

function rafLoop(): void {
  if (!pollActive) return;
  frameCount++;
  if (frameCount % FRAME_SKIP === 0) {
    try { pollOnce(); }
    catch (e) { log('pollOnce error', e); }
  }
  rafId = requestAnimationFrame(rafLoop);
}

function startPolling(): void {
  if (pollActive) return;
  log('Starting (canvas reader v5)...');
  pollActive = true;
  frameCount = 0;
  calibrationAttempt = 0;
  pieceCounter = 0;
  lastEmittedQueue = [];
  lastEmittedHold = null;
  lastBoardEmpty = true;
  boardRect = null;
  queueROI = null;
  holdROI = null;
  paletteFinalized = false;
  paletteSampleFrames = 0;
  palette.reset();
  tracker.reset();
  rafId = requestAnimationFrame(rafLoop);
}

function stopPolling(): void {
  if (!pollActive) return;
  pollActive = false;
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  log('Stopped.');
}

// ===== Move execution =====

let isExecuting = false;

async function handleExecuteMoves(seq: MoveSequence, keyDelay: number): Promise<void> {
  if (isExecuting) return;
  if (!boardRect) {
    log('Cannot execute: board not calibrated');
    window.postMessage({ type: 'MOVES_COMPLETE', verified: false, reason: 'no-calibration' }, '*');
    return;
  }
  isExecuting = true;
  try {
    const result = await executeMoveSequence(seq, {
      keyDelay,
      readBoard: readVisibleBoardOnly,
      tracker,
      onHoldPressed: () => tracker.markHoldPressed(pieceCounter),
    });
    window.postMessage(
      {
        type: 'MOVES_COMPLETE',
        verified: result.verified,
        finalFilled: result.finalFilled,
        postDropMs: result.postDropMs,
      },
      '*',
    );
    if (!result.verified) {
      log(`Move unverified: ${result.postDropMs.toFixed(0)}ms timeout, filled=${result.finalFilled}`);
    }
  } catch (e) {
    log('Execute error', e);
    window.postMessage({ type: 'MOVES_COMPLETE', verified: false, reason: 'exception' }, '*');
  } finally {
    isExecuting = false;
  }
}

// ===== Messages =====

window.addEventListener('message', event => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'BOT_START') startPolling();
  else if (data.type === 'BOT_STOP') stopPolling();
  else if (data.type === 'EXECUTE_MOVES') {
    handleExecuteMoves(data.sequence, data.keyDelay ?? 50);
  }
});

log('Game hook v5 (modular) injected.');
startPolling();
