/**
 * Content Script — runs in tetr.io page (isolated world).
 *
 * Responsibilities:
 * 1. Inject the game-hook script into the page's main world
 * 2. Receive game state from game-hook via postMessage
 * 3. Run AI engine to find best placement
 * 4. Send move commands back to game-hook (main world) for execution
 * 5. Communicate with popup/background via chrome.runtime messages
 */

import { GameState, AIDecision, Board, WeightProfile, BOARD_HEIGHT_BUFFER, BOARD_TOTAL_HEIGHT, BOARD_WIDTH } from '@/types';
import { findBestPlacement } from '@/ai/engine';
import { calculateMoveSequence } from '@/controller/input';
import { getShape } from '@/ai/piece';
import { getWeightProfile } from '@/ai/evaluator';

// ===== Board Cleaning =====

/**
 * Remove active piece cells from the raw board at the known spawn position.
 * The game-hook sends the raw board (including active piece + ghost), so we
 * subtract the piece at spawn (rotation=0, standard x, y=4) before sending to AI.
 */
function cleanRawBoard(board: Board, pieceType: string, spawnX: number, spawnY: number): Board {
  const shape = getShape(pieceType as import('@/types').PieceType, 0);
  // Deep copy the board so we don't mutate the original
  const cleaned: Board = board.map(row => [...row]);
  for (const [dr, dc] of shape) {
    const r = spawnY + dr;
    const c = spawnX + dc;
    if (r >= 0 && r < BOARD_TOTAL_HEIGHT && c >= 0 && c < BOARD_WIDTH) {
      // Only clear cells that match the piece type (don't clear locked cells of other types)
      if (cleaned[r][c] === pieceType || cleaned[r][c] !== null) {
        // If the cell matches the active piece type at spawn location, clear it.
        // Also clear any cell at spawn position since the active piece always renders there.
        cleaned[r][c] = null;
      }
    }
  }
  return cleaned;
}

// ===== Bot State =====

let isRunning = false;
let lastState: GameState | null = null;
let isExecutingMove = false;
/** Monotonic piece counter from game-hook, avoids acting on same piece twice */
let lastActedPieceCounter = -1;
let stats = {
  piecesPlaced: 0,
  linesCleared: 0,
  startTime: 0,
};

/** AI strength — controls beam search width. */
type AiStrength = 'fast' | 'balanced' | 'strong';
let aiStrength: AiStrength = 'strong';

/** Weight profile — controls evaluation function. */
let weightProfile: WeightProfile = 'balanced';

function strengthBeamWidth(s: AiStrength): number {
  if (s === 'fast') return 8;
  if (s === 'balanced') return 25;
  return 50;
}

/** Speed preset — controls keyDelay and MIN_ACTION_INTERVAL together. */
type SpeedPreset = 'safe' | 'fast' | 'turbo';
let speedPreset: SpeedPreset = 'fast';

/** ms between key presses. */
let keyDelay = 16;
/** Minimum ms between AI actions (safety net against noisy vision) */
let lastActionTime = 0;
let minActionInterval = 80;

function applySpeedPreset(preset: SpeedPreset): void {
  speedPreset = preset;
  switch (preset) {
    case 'safe':
      keyDelay = 30;
      minActionInterval = 150;
      break;
    case 'fast':
      keyDelay = 16;
      minActionInterval = 80;
      break;
    case 'turbo':
      keyDelay = 4;
      minActionInterval = 40;
      break;
  }
}

/** Panic tracking: count consecutive decisions where stack is near top. */
let highStackCount = 0;

// Game hook is injected via manifest.json (world: "MAIN", run_at: "document_start")
// This guarantees it runs before TETR.IO's scripts, so the getContext patch takes effect.

// ===== Execute moves via main world =====

/**
 * Send move sequence to game-hook (main world) for execution.
 * Returns a promise that resolves when the game-hook confirms completion.
 */
function executeMovesInMainWorld(
  sequence: { hold: boolean; rotations: number; horizontalMoves: number; use180: boolean },
): Promise<void> {
  return new Promise(resolve => {
    // Timeout safety: if game-hook doesn't respond in 5s, resolve anyway
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      console.warn('[TETRIO-BOT] Move execution timed out');
      resolve();
    }, 5000);

    const handler = (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.data?.type === 'MOVES_COMPLETE') {
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        resolve();
      }
    };
    window.addEventListener('message', handler);
    window.postMessage({ type: 'EXECUTE_MOVES', sequence, keyDelay }, '*');
  });
}

// ===== Game State Handling =====

window.addEventListener('message', (event) => {
  if (event.source !== window) return;

  if (event.data?.type === 'TETRIO_GAME_STATE') {
    const state = event.data.state as GameState;
    const pieceCounter = event.data.pieceCounter as number;
    const rawBoard = event.data.rawBoard as boolean | undefined;
    handleGameState(state, pieceCounter, rawBoard ?? false);
  }
});

async function handleGameState(
  state: GameState,
  pieceCounter: number,
  rawBoard: boolean,
): Promise<void> {
  lastState = state;

  if (!isRunning || !state.isPlaying || isExecutingMove) return;

  // Cooldown: prevent rapid-fire actions even if vision is noisy
  const now = Date.now();
  if (now - lastActionTime < minActionInterval) return;

  // Dedup: use monotonic piece counter from game-hook
  if (typeof pieceCounter !== 'number' || pieceCounter <= lastActedPieceCounter) return;

  isExecutingMove = true;
  lastActedPieceCounter = pieceCounter;
  lastActionTime = Date.now();

  try {
    // Clean the raw board: subtract active piece cells at spawn position
    const board = rawBoard
      ? cleanRawBoard(
          state.board,
          state.currentPiece.type,
          state.currentPiece.x,
          state.currentPiece.y,
        )
      : state.board;

    // Determine stack height to decide whether to enter survival mode.
    let stackTop = BOARD_TOTAL_HEIGHT;
    for (let row = 0; row < BOARD_TOTAL_HEIGHT; row++) {
      if (board[row].some(c => c !== null)) { stackTop = row; break; }
    }
    const stackHeight = BOARD_TOTAL_HEIGHT - stackTop;
    const stackVisibleHeight = Math.max(0, stackHeight - BOARD_HEIGHT_BUFFER);
    const danger = stackVisibleHeight > 14;
    if (danger) highStackCount++; else highStackCount = 0;
    const survivalMode = danger || highStackCount >= 3;

    // Run AI
    const aiStart = performance.now();
    const decision: AIDecision = findBestPlacement(
      board,
      state.currentPiece.type,
      state.holdPiece,
      state.canHold,
      state.nextQueue,
      {
        weights: getWeightProfile(weightProfile),
        beamWidth: strengthBeamWidth(aiStrength),
        maxDepth: 6,
        survivalMode,
      },
    );
    const aiMs = performance.now() - aiStart;

    // Determine spawn position based on whether we're using hold
    const pieceToPlace = decision.useHold
      ? (state.holdPiece ?? state.nextQueue[0])
      : state.currentPiece.type;

    const spawnState = {
      type: pieceToPlace,
      rotation: 0,
      x: pieceToPlace === 'O' ? 4 : 3,
      y: 4,
    };

    // Calculate moves from spawn position to AI target
    const sequence = calculateMoveSequence(spawnState, decision.placement);
    sequence.hold = decision.useHold;

    console.log(`[TETRIO-BOT] AI(${aiMs.toFixed(0)}ms queue=${state.nextQueue.length}${survivalMode ? ' SURVIVAL' : ''}): ${decision.useHold ? 'HOLD→' : ''}${pieceToPlace} rot=${decision.placement.rotation} x=${decision.placement.x} y=${decision.placement.y} score=${decision.score.toFixed(1)} moves: h=${sequence.horizontalMoves} r=${sequence.rotations} 180=${sequence.use180}`);

    // Execute via main world (game-hook dispatches real keyboard events)
    await executeMovesInMainWorld(sequence);

    stats.piecesPlaced++;

    // Notify popup of stats
    chrome.runtime.sendMessage({
      type: 'BOT_STATUS',
      payload: {
        running: true,
        piecesPlaced: stats.piecesPlaced,
        pps: stats.startTime
          ? stats.piecesPlaced / ((Date.now() - stats.startTime) / 1000)
          : 0,
      },
    }).catch(() => {/* popup may be closed */});

  } catch (e) {
    console.error('[TETRIO-BOT] Move execution error:', e);
  } finally {
    isExecutingMove = false;
  }
}

// ===== Control Messages =====

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'BOT_START') {
    isRunning = true;
    isExecutingMove = false;
    lastActedPieceCounter = -1;
    stats = { piecesPlaced: 0, linesCleared: 0, startTime: Date.now() };
    highStackCount = 0;
    window.postMessage({ type: 'BOT_START' }, '*');
    console.log('[TETRIO-BOT] Bot started.');
    sendResponse({ ok: true });
  } else if (message.type === 'BOT_STOP') {
    isRunning = false;
    window.postMessage({ type: 'BOT_STOP' }, '*');
    console.log('[TETRIO-BOT] Bot stopped.');
    sendResponse({ ok: true });
  } else if (message.type === 'SET_SPEED') {
    const preset = message.payload?.preset;
    if (preset === 'safe' || preset === 'fast' || preset === 'turbo') {
      applySpeedPreset(preset);
    } else {
      // Legacy: accept raw keyDelay values
      keyDelay = message.payload?.keyDelay ?? 16;
    }
    sendResponse({ ok: true });
  } else if (message.type === 'SET_STRENGTH') {
    const s = message.payload?.strength;
    if (s === 'fast' || s === 'balanced' || s === 'strong') aiStrength = s;
    sendResponse({ ok: true });
  } else if (message.type === 'SET_WEIGHTS') {
    const w = message.payload?.profile;
    if (w === 'balanced' || w === 'eltetris' || w === 'aggressive') weightProfile = w;
    sendResponse({ ok: true });
  } else if (message.type === 'GET_STATUS') {
    sendResponse({
      running: isRunning,
      connected: lastState !== null,
      piecesPlaced: stats.piecesPlaced,
      pps: stats.startTime
        ? stats.piecesPlaced / ((Date.now() - stats.startTime) / 1000)
        : 0,
    });
  }
  return true; // async response
});

// ===== Init =====

console.log('[TETRIO-BOT] Content script loaded.');
