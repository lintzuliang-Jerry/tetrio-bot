import { PieceState, Placement, MoveSequence } from '@/types';

/**
 * Calculate the move sequence needed to go from current piece state to target placement.
 * Note: Actual keyboard execution happens in game-hook.ts (main world).
 */
export function calculateMoveSequence(
  current: PieceState,
  target: Placement,
): MoveSequence {
  // Calculate rotation difference
  let rotationDiff = (target.rotation - current.rotation + 4) % 4;
  let use180 = false;

  if (rotationDiff === 2) {
    use180 = true;
    rotationDiff = 0;
  } else if (rotationDiff === 3) {
    rotationDiff = -1; // CCW is more efficient
  }

  return {
    hold: false, // set externally
    rotations: rotationDiff,
    horizontalMoves: target.x - current.x,
    use180,
  };
}
