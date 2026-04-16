import {
  Board,
  EvaluationWeights,
  WeightProfile,
  PieceType,
  BOARD_WIDTH,
  BOARD_TOTAL_HEIGHT,
  SURVIVAL_LINE_BONUS,
} from '@/types';

/** Balanced profile: our tuned 14-feature evaluation. */
export const DEFAULT_WEIGHTS: EvaluationWeights = {
  landingHeight: -2.7,
  rowTransitions: -3.2,
  columnTransitions: -9.3,
  holes: -15.0,
  wellSum: -3.5,
  bumpiness: -1.2,
  aggregateHeight: -0.5,
  holeDepth: -5.0,
  wellGuard: -10.0,
  b2bBonus: 12.0,
  comboBonus: 2.0,
  lineClearBonus: [8, 20, 40, 80],
};

/**
 * ElTetris Classic: research-proven 6-feature weights by Islam El-Ashi.
 * Used by multiple successful TETR.IO bots. Simple but effective for survival.
 * Extra features zeroed out to use pure ElTetris scoring.
 */
export const ELTETRIS_WEIGHTS: EvaluationWeights = {
  landingHeight: -4.500158825082766,
  rowTransitions: -3.2178882868487753,
  columnTransitions: -9.348695305445199,
  holes: -7.899265427351652,
  wellSum: -3.3855972247263626,
  bumpiness: 0,
  aggregateHeight: 0,
  holeDepth: 0,
  wellGuard: 0,
  b2bBonus: 0,
  comboBonus: 0,
  lineClearBonus: [3.4181268101392694, 3.4181268101392694, 3.4181268101392694, 3.4181268101392694],
};

/**
 * Aggressive: heavily penalizes holes and blockades (inspired by Teapot's
 * genetic-algorithm-trained weights). Focuses on keeping the board ultra-clean.
 */
export const AGGRESSIVE_WEIGHTS: EvaluationWeights = {
  landingHeight: -4.5,
  rowTransitions: -3.2,
  columnTransitions: -9.3,
  holes: -20.0,
  wellSum: -5.0,
  bumpiness: -2.0,
  aggregateHeight: -0.8,
  holeDepth: -8.0,
  wellGuard: -12.0,
  b2bBonus: 15.0,
  comboBonus: 3.0,
  lineClearBonus: [5, 15, 35, 100],
};

/** Look up a named weight profile. */
export function getWeightProfile(name: WeightProfile): EvaluationWeights {
  switch (name) {
    case 'eltetris': return ELTETRIS_WEIGHTS;
    case 'aggressive': return AGGRESSIVE_WEIGHTS;
    default: return DEFAULT_WEIGHTS;
  }
}

export function getColumnHeights(board: Board): number[] {
  const heights = new Array(BOARD_WIDTH).fill(0);
  for (let col = 0; col < BOARD_WIDTH; col++) {
    for (let row = 0; row < BOARD_TOTAL_HEIGHT; row++) {
      if (board[row][col] !== null) {
        heights[col] = BOARD_TOTAL_HEIGHT - row;
        break;
      }
    }
  }
  return heights;
}

function countHolesAndDepth(
  board: Board,
  heights: number[],
): { holes: number; holeDepth: number } {
  let holes = 0;
  let holeDepth = 0;
  for (let col = 0; col < BOARD_WIDTH; col++) {
    const top = BOARD_TOTAL_HEIGHT - heights[col];
    let stackedAbove = 0;
    for (let row = top; row < BOARD_TOTAL_HEIGHT; row++) {
      if (board[row][col] === null) {
        holes++;
        holeDepth += stackedAbove;
      } else {
        stackedAbove++;
      }
    }
  }
  return { holes, holeDepth };
}

function getBumpiness(heights: number[]): number {
  let b = 0;
  for (let i = 0; i < heights.length - 1; i++) {
    b += Math.abs(heights[i] - heights[i + 1]);
  }
  return b;
}

function getRowTransitions(board: Board): number {
  let t = 0;
  for (let row = 0; row < BOARD_TOTAL_HEIGHT; row++) {
    let prev = true;
    for (let col = 0; col < BOARD_WIDTH; col++) {
      const cur = board[row][col] !== null;
      if (cur !== prev) t++;
      prev = cur;
    }
    if (!prev) t++;
  }
  return t;
}

function getColumnTransitions(board: Board): number {
  let t = 0;
  for (let col = 0; col < BOARD_WIDTH; col++) {
    let prev = false;
    for (let row = 0; row < BOARD_TOTAL_HEIGHT; row++) {
      const cur = board[row][col] !== null;
      if (cur !== prev) t++;
      prev = cur;
    }
    if (!prev) t++;
  }
  return t;
}

function getWellSum(heights: number[]): number {
  let sum = 0;
  let deepestEdgeDepth = 0;
  let deepestEdgeSum = 0;
  for (let col = 0; col < BOARD_WIDTH; col++) {
    const left = col === 0 ? BOARD_TOTAL_HEIGHT : heights[col - 1];
    const right = col === BOARD_WIDTH - 1 ? BOARD_TOTAL_HEIGHT : heights[col + 1];
    const d = Math.min(left, right) - heights[col];
    if (d <= 0) continue;
    const contribution = (d * (d + 1)) / 2;
    sum += contribution;
    const isEdge = col === 0 || col === BOARD_WIDTH - 1;
    if (isEdge && d > deepestEdgeDepth) {
      deepestEdgeDepth = d;
      deepestEdgeSum = contribution;
    }
  }
  if (deepestEdgeDepth >= 2) sum -= deepestEdgeSum;
  return sum;
}

/**
 * Identify the deepest edge well (col 0 or 9) from a set of column heights.
 * Returns the edge column index and its depth relative to the neighbour, or
 * null if neither edge is a meaningful well.
 */
function findEdgeWell(heights: number[]): { col: number; depth: number } | null {
  const leftDepth = heights[1] - heights[0];
  const rightDepth = heights[BOARD_WIDTH - 2] - heights[BOARD_WIDTH - 1];
  const best = leftDepth >= rightDepth
    ? { col: 0, depth: leftDepth }
    : { col: BOARD_WIDTH - 1, depth: rightDepth };
  return best.depth >= 3 ? best : null;
}

export interface EvaluateContext {
  /** Piece type just placed (for well-guard). */
  pieceType: PieceType;
  /** Column heights BEFORE the placement was applied. */
  preHeights: number[];
  /** True if the previous clear in this search path was a Tetris. */
  lastClearWasDifficult: boolean;
  /** Combo count coming into this step. */
  comboBefore: number;
  /** When true, swap lineClearBonus for aggressive survival values. */
  survivalMode: boolean;
}

export interface EvaluateResult {
  score: number;
  /** True iff this placement was a Tetris (= difficult clear, excl. T-spins for now). */
  isDifficultClear: boolean;
  /** Combo count after this placement (reset to 0 on no-clear). */
  comboAfter: number;
}

/**
 * Evaluate a resulting board state. Higher score = better.
 * `landingHeight` is Dellacherie's landing height (centre of the placed piece,
 * counted from the board bottom).
 */
export function evaluate(
  board: Board,
  linesCleared: number,
  landingHeight: number,
  weights: EvaluationWeights,
  ctx: EvaluateContext,
): EvaluateResult {
  const heights = getColumnHeights(board);
  const { holes, holeDepth } = countHolesAndDepth(board, heights);
  let aggregateHeight = 0;
  for (const h of heights) aggregateHeight += h;

  const bonusTable = ctx.survivalMode ? SURVIVAL_LINE_BONUS : weights.lineClearBonus;
  const clearBonus =
    linesCleared > 0 && linesCleared <= 4 ? bonusTable[linesCleared - 1] : 0;

  const isDifficultClear = linesCleared === 4;
  const b2bBonus =
    isDifficultClear && ctx.lastClearWasDifficult ? weights.b2bBonus : 0;
  const comboAfter = linesCleared > 0 ? ctx.comboBefore + 1 : 0;
  const comboScore = linesCleared > 0 ? weights.comboBonus * ctx.comboBefore : 0;

  // Well guard: punish filling an edge well with a non-I piece.
  let wellGuardPenalty = 0;
  const preWell = findEdgeWell(ctx.preHeights);
  if (preWell && ctx.pieceType !== 'I') {
    const postHeight = heights[preWell.col];
    const preHeight = ctx.preHeights[preWell.col];
    const filled = postHeight - preHeight;
    if (filled > 0) {
      wellGuardPenalty = weights.wellGuard * filled;
    }
  }

  const score =
    weights.landingHeight * landingHeight +
    clearBonus +
    b2bBonus +
    comboScore +
    wellGuardPenalty +
    weights.rowTransitions * getRowTransitions(board) +
    weights.columnTransitions * getColumnTransitions(board) +
    weights.holes * holes +
    weights.wellSum * getWellSum(heights) +
    weights.bumpiness * getBumpiness(heights) +
    weights.aggregateHeight * aggregateHeight +
    weights.holeDepth * holeDepth;

  return { score, isDifficultClear, comboAfter };
}
