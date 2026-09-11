/**
 * Execute a move sequence and verify the hard-drop actually took effect.
 *
 * Old executor was fire-and-forget: send keys, signal "MOVES_COMPLETE" immediately.
 * New executor sends keys, then waits for the board to stabilize at a state
 * different from the pre-drop hash. If the board doesn't change within the
 * timeout, the move is reported as misexecuted.
 */

import { Board } from '@/types';
import { pressKey, inputDelay, INPUT_KEY_MAP } from './keyboard';
import { boardHash, countFilled, StateTracker } from '@/vision/state-tracker';

export interface MoveSequence {
  hold: boolean;
  rotations: number;       // positive = CW, negative = CCW
  horizontalMoves: number; // positive = right, negative = left
  use180: boolean;
}

export interface ExecutionResult {
  /** True iff the hard-drop produced a board change we observed. */
  verified: boolean;
  /** Final filled count after the drop settled (or last seen if unverified). */
  finalFilled: number;
  /** Final board hash after settling. */
  finalHash: string;
  /** ms spent waiting for board stabilization after the drop. */
  postDropMs: number;
}

export interface ExecutionOptions {
  keyDelay: number;
  /** Called repeatedly to read the latest board after the drop. */
  readBoard: () => Board;
  tracker: StateTracker;
  /** Frames of agreement required before declaring stable. */
  minStableFrames?: number;
  /** Hard cap on post-drop wait. */
  postDropTimeoutMs?: number;
  /** Called when this execution involved a hold press, so we can update tracker. */
  onHoldPressed?: () => void;
}

export async function executeMoveSequence(
  seq: MoveSequence,
  opts: ExecutionOptions,
): Promise<ExecutionResult> {
  const { keyDelay, readBoard, tracker } = opts;
  const minStable = opts.minStableFrames ?? 3;
  const timeout = opts.postDropTimeoutMs ?? 600;

  const preBoard = readBoard();
  const preHash = boardHash(preBoard);
  const preFilled = countFilled(preBoard);

  // 1. Hold first if requested
  if (seq.hold) {
    await pressKey(INPUT_KEY_MAP.hold);
    if (opts.onHoldPressed) opts.onHoldPressed();
    // TETR.IO needs ~1 frame to finish the swap before further inputs apply
    await inputDelay(keyDelay + 20);
  }

  // 2. Rotations
  if (seq.use180) {
    await pressKey(INPUT_KEY_MAP.rotate180);
    await inputDelay(keyDelay);
  } else if (seq.rotations > 0) {
    for (let i = 0; i < seq.rotations; i++) {
      await pressKey(INPUT_KEY_MAP.rotateCW);
      await inputDelay(keyDelay);
    }
  } else if (seq.rotations < 0) {
    for (let i = 0; i < Math.abs(seq.rotations); i++) {
      await pressKey(INPUT_KEY_MAP.rotateCCW);
      await inputDelay(keyDelay);
    }
  }

  // 3. Horizontal moves
  if (seq.horizontalMoves > 0) {
    for (let i = 0; i < seq.horizontalMoves; i++) {
      await pressKey(INPUT_KEY_MAP.moveRight);
      await inputDelay(keyDelay);
    }
  } else if (seq.horizontalMoves < 0) {
    for (let i = 0; i < Math.abs(seq.horizontalMoves); i++) {
      await pressKey(INPUT_KEY_MAP.moveLeft);
      await inputDelay(keyDelay);
    }
  }

  // 4. Hard drop
  await pressKey(INPUT_KEY_MAP.hardDrop);

  // 5. Wait for the board to stabilize at a state different from preHash
  const start = performance.now();
  tracker.reset();
  let lastHash = preHash;
  let lastFilled = preFilled;

  while (performance.now() - start < timeout) {
    await inputDelay(16);
    const board = readBoard();
    const snap = tracker.recordFrame(board);
    lastHash = snap.hash;
    lastFilled = snap.filled;

    // Stable AND different from pre-drop = verified
    if (tracker.isStable(minStable) && snap.hash !== preHash) {
      return {
        verified: true,
        finalFilled: snap.filled,
        finalHash: snap.hash,
        postDropMs: performance.now() - start,
      };
    }
  }

  // Timed out without observing a stable post-drop state different from pre-drop
  return {
    verified: false,
    finalFilled: lastFilled,
    finalHash: lastHash,
    postDropMs: performance.now() - start,
  };
}
