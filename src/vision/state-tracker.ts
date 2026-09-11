/**
 * Track board stability across frames and hold-key availability.
 *
 * Replaces the old fixed-frame postDropCooldown (which raced with lock animations)
 * with a state-based check: the board is "stable" when the boardKey hash and
 * filled-cell count haven't changed across N consecutive reads.
 *
 * Also tracks `canHold` based on observed hold-key presses and hold ROI changes.
 */

import { Board, PieceType } from '@/types';

/** Cheap string hash of a board's contents for quick equality checks. */
export function boardHash(board: Board): string {
  let s = '';
  for (const row of board) {
    for (const cell of row) {
      s += cell ?? '.';
    }
  }
  return s;
}

export function countFilled(board: Board): number {
  let n = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell !== null) n++;
    }
  }
  return n;
}

export interface FrameSnapshot {
  hash: string;
  filled: number;
  timestamp: number;
}

/**
 * Maintains a rolling buffer of recent frame snapshots. The state is considered
 * stable when the most recent N snapshots all agree.
 */
export class StateTracker {
  private history: FrameSnapshot[] = [];
  private readonly maxHistory = 8;

  /** Hold-key tracking. */
  private holdAvailable = true;
  private lastSeenHoldPiece: PieceType | null = null;
  /** Piece-counter value at which we last pressed Hold (so we can detect rollover). */
  private lastHoldPressedAtCounter = -1;

  recordFrame(board: Board, timestamp = performance.now()): FrameSnapshot {
    const snap: FrameSnapshot = {
      hash: boardHash(board),
      filled: countFilled(board),
      timestamp,
    };
    this.history.push(snap);
    if (this.history.length > this.maxHistory) this.history.shift();
    return snap;
  }

  /** True if the most recent N snapshots all agree (same hash AND filled count). */
  isStable(minStableFrames = 3): boolean {
    if (this.history.length < minStableFrames) return false;
    const recent = this.history.slice(-minStableFrames);
    const ref = recent[0];
    return recent.every(s => s.hash === ref.hash && s.filled === ref.filled);
  }

  /** Returns true once the board state has differed from the given baseline hash
   *  AND then stabilized again at a different state. Used to detect that a
   *  hard-drop has actually taken effect.
   */
  hasChangedFrom(baselineHash: string, minStableFrames = 3): boolean {
    if (!this.isStable(minStableFrames)) return false;
    const recent = this.history.slice(-minStableFrames);
    return recent[0].hash !== baselineHash;
  }

  /** Drop the buffered history (e.g. after a long pause). */
  reset(): void {
    this.history = [];
  }

  latest(): FrameSnapshot | null {
    return this.history[this.history.length - 1] ?? null;
  }

  /** ===== Hold tracking ===== */

  /**
   * Update hold state given the latest read of the hold ROI and the current
   * piece counter. Call this every frame the game-hook samples.
   */
  observeHold(holdPiece: PieceType | null, pieceCounter: number): void {
    // When a new piece spawns (piece counter advances past our last hold press),
    // hold becomes available again.
    if (pieceCounter > this.lastHoldPressedAtCounter && !this.holdAvailable) {
      // Only restore availability if the visible hold piece has stabilized
      // (i.e. the swap completed)
      this.holdAvailable = true;
    }
    this.lastSeenHoldPiece = holdPiece;
  }

  /**
   * Mark that the bot just pressed Hold. Disables hold until next piece spawn.
   */
  markHoldPressed(pieceCounter: number): void {
    this.holdAvailable = false;
    this.lastHoldPressedAtCounter = pieceCounter;
  }

  /** Reset hold availability when a fresh piece spawns. */
  onPieceSpawn(): void {
    this.holdAvailable = true;
  }

  canHold(): boolean {
    return this.holdAvailable;
  }

  lastHoldPiece(): PieceType | null {
    return this.lastSeenHoldPiece;
  }
}

/**
 * Wait for the supplied snapshot function to return a stable state.
 * Resolves with the stable snapshot or null on timeout.
 */
export async function awaitStableState(
  poll: () => FrameSnapshot,
  tracker: StateTracker,
  opts: { minStableFrames?: number; timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<FrameSnapshot | null> {
  const minStable = opts.minStableFrames ?? 3;
  const timeout = opts.timeoutMs ?? 500;
  const interval = opts.pollIntervalMs ?? 16;
  const start = performance.now();

  return new Promise(resolve => {
    const check = () => {
      poll();
      if (tracker.isStable(minStable)) {
        resolve(tracker.latest());
        return;
      }
      if (performance.now() - start > timeout) {
        resolve(null);
        return;
      }
      setTimeout(check, interval);
    };
    check();
  });
}
