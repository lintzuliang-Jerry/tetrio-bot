// ===== Piece Types =====

export type PieceType = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';

export const ALL_PIECE_TYPES: PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

// ===== Board =====

/** 10 wide x 20 visible rows. Cell value: null = empty, PieceType = occupied */
export type Board = (PieceType | null)[][];

export const BOARD_WIDTH = 10;
export const BOARD_HEIGHT = 20;
/** Extra hidden rows above visible area for spawning */
export const BOARD_HEIGHT_BUFFER = 4;
export const BOARD_TOTAL_HEIGHT = BOARD_HEIGHT + BOARD_HEIGHT_BUFFER;

// ===== Piece State =====

export interface PieceState {
  type: PieceType;
  rotation: number; // 0-3
  x: number;
  y: number;
}

// ===== Game State =====

export interface GameState {
  board: Board;
  currentPiece: PieceState;
  nextQueue: PieceType[];
  holdPiece: PieceType | null;
  canHold: boolean;
  isPlaying: boolean;
}

// ===== AI =====

export interface Placement {
  type: PieceType;
  rotation: number;
  x: number;
  y: number; // final y after hard drop
}

export interface AIDecision {
  placement: Placement;
  useHold: boolean;
  score: number;
}

export interface EvaluationWeights {
  landingHeight: number;
  rowTransitions: number;
  columnTransitions: number;
  holes: number;
  wellSum: number;
  bumpiness: number;
  aggregateHeight: number;
  holeDepth: number;
  /** Penalty applied when a non-I piece fills a deep edge well (depth ≥ 3). */
  wellGuard: number;
  /** Bonus when consecutive difficult clears (Tetris-to-Tetris) occur. */
  b2bBonus: number;
  /** Per-step bonus scaling with combo count. */
  comboBonus: number;
  /** Bonus for clearing 1..4 lines, indexed by (linesCleared - 1). */
  lineClearBonus: [number, number, number, number];
}

/**
 * Survival-mode override for lineClearBonus used when the stack is dangerously
 * tall. Swaps the "hoard for Tetris" incentive for aggressive 1/2-line clears.
 */
export const SURVIVAL_LINE_BONUS: [number, number, number, number] = [15, 25, 35, 60];

/** Named weight profiles selectable from the popup. */
export type WeightProfile = 'balanced' | 'eltetris' | 'aggressive';

// ===== Input =====

export interface MoveSequence {
  hold: boolean;
  rotations: number;       // positive = CW, negative = CCW
  horizontalMoves: number; // positive = right, negative = left
  use180: boolean;
}

// ===== Messages (between extension components) =====

export type MessageType =
  | 'TETRIO_GAME_STATE'
  | 'BOT_START'
  | 'BOT_STOP'
  | 'BOT_STATUS';

export interface ExtensionMessage {
  type: MessageType;
  payload?: unknown;
}
