import { Board, PieceType, AIDecision, EvaluationWeights, Placement } from '@/types';
import { generatePlacements, simulatePlacement } from './board';
import { evaluate, DEFAULT_WEIGHTS, getColumnHeights } from './evaluator';

interface SearchNode {
  board: Board;
  active: PieceType | null;
  hold: PieceType | null;
  queueIdx: number;
  cumScore: number;
  firstPlacement: Placement | null;
  firstUseHold: boolean;
  lastClearWasDifficult: boolean;
  combo: number;
}

export interface EngineOptions {
  weights?: EvaluationWeights;
  beamWidth?: number;
  maxDepth?: number;
  /** When true, survival lineClearBonus overrides the default weights. */
  survivalMode?: boolean;
  /** Initial back-to-back state (from the game's recent history). */
  initialB2B?: boolean;
  /** Initial combo count. */
  initialCombo?: number;
}

/**
 * Dynamic penalty for pressing hold. Discourages hoarding the I piece and
 * discourages trivial flips, but stays cheap when hold is still empty.
 */
function holdPenalty(
  currentHold: PieceType | null,
  pieceBeingHeld: PieceType,
): number {
  // Scaled up to match the evaluator's score magnitude (often 50-200).
  // The old 2/3/15 values were dominated by even tiny placement differences,
  // so the AI thrashed between hold and no-hold.
  if (currentHold === null) return 8;
  if (pieceBeingHeld === 'I') return 60;
  return 12;
}

function expand(
  node: SearchNode,
  queue: PieceType[],
  weights: EvaluationWeights,
  allowHold: boolean,
  survivalMode: boolean,
): SearchNode[] {
  if (node.active === null) return [];
  const children: SearchNode[] = [];
  const isRoot = node.firstPlacement === null;
  const preHeights = getColumnHeights(node.board);

  // Option 1: place the active piece directly.
  for (const { rotation, x } of generatePlacements(node.board, node.active)) {
    const res = simulatePlacement(node.board, node.active, rotation, x);
    const evalRes = evaluate(res.board, res.linesCleared, res.landingHeight, weights, {
      pieceType: node.active,
      preHeights,
      lastClearWasDifficult: node.lastClearWasDifficult,
      comboBefore: node.combo,
      survivalMode,
    });
    children.push({
      board: res.board,
      active: queue[node.queueIdx] ?? null,
      hold: node.hold,
      queueIdx: node.queueIdx + 1,
      cumScore: node.cumScore + evalRes.score,
      firstPlacement: isRoot ? res.placement : node.firstPlacement,
      firstUseHold: isRoot ? false : node.firstUseHold,
      lastClearWasDifficult: res.linesCleared > 0
        ? evalRes.isDifficultClear
        : node.lastClearWasDifficult,
      combo: evalRes.comboAfter,
    });
  }

  // Option 2: press hold first.
  if (allowHold) {
    let holdActive: PieceType | null;
    let newHold: PieceType | null;
    let queueAfterHold: number;
    if (node.hold === null) {
      holdActive = queue[node.queueIdx] ?? null;
      newHold = node.active;
      queueAfterHold = node.queueIdx + 1;
    } else {
      holdActive = node.hold;
      newHold = node.active;
      queueAfterHold = node.queueIdx;
    }

    if (holdActive !== null && holdActive !== node.active) {
      const penalty = holdPenalty(node.hold, node.active);
      for (const { rotation, x } of generatePlacements(node.board, holdActive)) {
        const res = simulatePlacement(node.board, holdActive, rotation, x);
        const evalRes = evaluate(res.board, res.linesCleared, res.landingHeight, weights, {
          pieceType: holdActive,
          preHeights,
          lastClearWasDifficult: node.lastClearWasDifficult,
          comboBefore: node.combo,
          survivalMode,
        });
        children.push({
          board: res.board,
          active: queue[queueAfterHold] ?? null,
          hold: newHold,
          queueIdx: queueAfterHold + 1,
          cumScore: node.cumScore + evalRes.score - penalty,
          firstPlacement: isRoot ? res.placement : node.firstPlacement,
          firstUseHold: isRoot ? true : node.firstUseHold,
          lastClearWasDifficult: res.linesCleared > 0
            ? evalRes.isDifficultClear
            : node.lastClearWasDifficult,
          combo: evalRes.comboAfter,
        });
      }
    }
  }

  return children;
}

/**
 * Beam-search AI over the current piece, hold, and next queue.
 */
export function findBestPlacement(
  board: Board,
  currentPiece: PieceType,
  holdPiece: PieceType | null,
  canHold: boolean,
  nextQueue: PieceType[],
  options: EngineOptions = {},
): AIDecision {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const beamWidth = options.beamWidth ?? 25;
  const maxDepth = options.maxDepth ?? 6;
  const survivalMode = options.survivalMode ?? false;
  const depth = Math.min(maxDepth, 1 + nextQueue.length);

  let beam: SearchNode[] = [
    {
      board,
      active: currentPiece,
      hold: holdPiece,
      queueIdx: 0,
      cumScore: 0,
      firstPlacement: null,
      firstUseHold: false,
      lastClearWasDifficult: options.initialB2B ?? false,
      combo: options.initialCombo ?? 0,
    },
  ];

  for (let d = 0; d < depth; d++) {
    const allowHold = d === 0 ? canHold : true;
    const next: SearchNode[] = [];
    for (const node of beam) {
      const children = expand(node, nextQueue, weights, allowHold, survivalMode);
      for (const c of children) next.push(c);
    }
    if (next.length === 0) break;
    next.sort((a, b) => b.cumScore - a.cumScore);
    beam = next.length > beamWidth ? next.slice(0, beamWidth) : next;
  }

  const best = beam[0];
  if (!best || !best.firstPlacement) {
    return {
      placement: { type: currentPiece, rotation: 0, x: 3, y: 0 },
      useHold: false,
      score: -Infinity,
    };
  }

  return {
    placement: best.firstPlacement,
    useHold: best.firstUseHold,
    score: best.cumScore,
  };
}
