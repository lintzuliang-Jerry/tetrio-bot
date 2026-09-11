/**
 * Content Script — runs in tetr.io page (isolated world).
 *
 * v5 changes vs prior:
 *   - The board from game-hook is already locked-only (active piece stripped),
 *     so we drop the old cleanRawBoard / ghost-stripping logic.
 *   - currentPiece carries the REAL detected (x, rotation, y), not an assumed
 *     spawn. Move sequence is computed from there.
 *   - canHold comes from the game-hook tracker (real availability), not a
 *     hardcoded `true`.
 *   - We wait for MOVES_COMPLETE.verified before advancing the acted counter.
 *     Unverified moves cause us to skip a tick and re-read the board.
 */

import {
  GameState,
  AIDecision,
  WeightProfile,
  BOARD_HEIGHT_BUFFER,
  BOARD_TOTAL_HEIGHT,
} from '@/types';
import { findBestPlacement } from '@/ai/engine';
import { calculateMoveSequence } from '@/controller/input';
import { getWeightProfile } from '@/ai/evaluator';

// ===== Bot State =====

let isRunning = false;
let lastState: GameState | null = null;
let isExecutingMove = false;
let lastActedPieceCounter = -1;
let consecutiveUnverified = 0;

let stats = {
  piecesPlaced: 0,
  startTime: 0,
};

type AiStrength = 'fast' | 'balanced' | 'strong';
let aiStrength: AiStrength = 'strong';

let weightProfile: WeightProfile = 'balanced';

function strengthBeamWidth(s: AiStrength): number {
  if (s === 'fast') return 8;
  if (s === 'balanced') return 25;
  return 50;
}

type SpeedPreset = 'safe' | 'fast';
let speedPreset: SpeedPreset = 'fast';
let keyDelay = 16;
let minActionInterval = 80;
let lastActionTime = 0;

function applySpeedPreset(preset: SpeedPreset): void {
  speedPreset = preset;
  if (preset === 'safe') {
    keyDelay = 30; minActionInterval = 150;
  } else {
    keyDelay = 16; minActionInterval = 80;
  }
}

let highStackCount = 0;

// ===== Move dispatch =====

function executeMovesInMainWorld(
  sequence: { hold: boolean; rotations: number; horizontalMoves: number; use180: boolean },
): Promise<{ verified: boolean; finalFilled: number; postDropMs: number }> {
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      console.warn('[TETRIO-BOT] MOVES_COMPLETE wait timed out');
      resolve({ verified: false, finalFilled: 0, postDropMs: 0 });
    }, 3000);

    const handler = (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.data?.type === 'MOVES_COMPLETE') {
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        resolve({
          verified: !!event.data.verified,
          finalFilled: event.data.finalFilled ?? 0,
          postDropMs: event.data.postDropMs ?? 0,
        });
      }
    };
    window.addEventListener('message', handler);
    window.postMessage({ type: 'EXECUTE_MOVES', sequence, keyDelay }, '*');
  });
}

// ===== GameState handler =====

window.addEventListener('message', event => {
  if (event.source !== window) return;
  if (event.data?.type !== 'TETRIO_GAME_STATE') return;
  const state = event.data.state as GameState;
  const pieceCounter = event.data.pieceCounter as number;
  handleGameState(state, pieceCounter);
});

async function handleGameState(state: GameState, pieceCounter: number): Promise<void> {
  lastState = state;
  if (!isRunning || !state.isPlaying || isExecutingMove) return;

  const now = Date.now();
  if (now - lastActionTime < minActionInterval) return;
  if (typeof pieceCounter !== 'number' || pieceCounter <= lastActedPieceCounter) return;

  isExecutingMove = true;
  lastActionTime = Date.now();

  try {
    const board = state.board;
    const filled = countFilled(board);

    // Survival heuristic: high stack + many cells => switch to aggressive clearing
    let stackTop = BOARD_TOTAL_HEIGHT;
    for (let row = 0; row < BOARD_TOTAL_HEIGHT; row++) {
      if (board[row].some(c => c !== null)) { stackTop = row; break; }
    }
    const stackVisible = Math.max(0, BOARD_TOTAL_HEIGHT - stackTop - BOARD_HEIGHT_BUFFER);
    const danger = stackVisible > 10 && filled > 40;
    if (danger) highStackCount++; else highStackCount = 0;
    const survivalMode = danger || highStackCount >= 2;

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
        maxDepth: 5,
        survivalMode,
      },
    );
    const aiMs = performance.now() - aiStart;

    // Compute the "current" state at the moment the executor begins moving.
    // - No hold: piece is wherever vision detected it.
    // - Hold:    after the swap, the active piece spawns at standard position
    //   (x=4 for O, x=3 for everything else).
    let currentX: number;
    let currentRot: number;
    if (decision.useHold) {
      const pieceToPlace = state.holdPiece ?? state.nextQueue[0];
      currentX = pieceToPlace === 'O' ? 4 : 3;
      currentRot = 0;
    } else {
      currentX = state.currentPiece.x;
      currentRot = state.currentPiece.rotation;
    }

    const sequence = calculateMoveSequence(
      {
        type: decision.placement.type,
        rotation: currentRot,
        x: currentX,
        y: state.currentPiece.y,
      },
      decision.placement,
    );
    sequence.hold = decision.useHold;

    console.log(
      `[TETRIO-BOT] AI(${aiMs.toFixed(0)}ms${survivalMode ? ' SURVIVAL' : ''}) ` +
      `piece=${decision.placement.type} ` +
      `${decision.useHold ? 'HOLD→' : ''}rot=${decision.placement.rotation} x=${decision.placement.x} ` +
      `score=${decision.score.toFixed(1)} moves: h=${sequence.horizontalMoves} r=${sequence.rotations} 180=${sequence.use180}`,
    );

    const result = await executeMovesInMainWorld(sequence);

    if (result.verified) {
      lastActedPieceCounter = pieceCounter;
      consecutiveUnverified = 0;
      stats.piecesPlaced++;
    } else {
      consecutiveUnverified++;
      console.warn(
        `[TETRIO-BOT] Move unverified (${consecutiveUnverified} in a row, ${result.postDropMs.toFixed(0)}ms)`,
      );
      if (consecutiveUnverified >= 3) {
        console.error('[TETRIO-BOT] 3 consecutive unverified moves — pausing bot. Re-start when board is clean.');
        isRunning = false;
        chrome.runtime.sendMessage({ type: 'BOT_STATUS', payload: { running: false, error: 'unverified' } })
          .catch(() => {/* popup closed */});
      }
      // Don't advance counter — next vision update will retry
    }

    chrome.runtime.sendMessage({
      type: 'BOT_STATUS',
      payload: {
        running: isRunning,
        piecesPlaced: stats.piecesPlaced,
        pps: stats.startTime
          ? stats.piecesPlaced / ((Date.now() - stats.startTime) / 1000)
          : 0,
      },
    }).catch(() => {/* popup closed */});
  } catch (e) {
    console.error('[TETRIO-BOT] handleGameState error:', e);
  } finally {
    isExecutingMove = false;
  }
}

function countFilled(board: GameState['board']): number {
  let n = 0;
  for (const row of board) for (const c of row) if (c !== null) n++;
  return n;
}

// ===== Control messages =====

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'BOT_START') {
    isRunning = true;
    isExecutingMove = false;
    lastActedPieceCounter = -1;
    consecutiveUnverified = 0;
    highStackCount = 0;
    stats = { piecesPlaced: 0, startTime: Date.now() };
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
    if (preset === 'safe' || preset === 'fast') {
      applySpeedPreset(preset);
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
  return true;
});

console.log('[TETRIO-BOT] Content script loaded (v5).');
