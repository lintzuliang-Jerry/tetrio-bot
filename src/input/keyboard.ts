/**
 * Low-level keyboard dispatch for TETR.IO.
 *
 * Must run in the main world (not the content-script isolated world) so that
 * TETR.IO's own keydown listeners receive the events. This file is imported
 * by `src/injected/game-hook.ts`.
 */

export const INPUT_KEY_MAP = {
  moveLeft: 'ArrowLeft',
  moveRight: 'ArrowRight',
  softDrop: 'ArrowDown',
  hardDrop: 'Space',
  rotateCW: 'ArrowUp',
  rotateCCW: 'KeyZ',
  rotate180: 'KeyA',
  hold: 'KeyC',
} as const;

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

function dispatchKey(code: string, eventType: 'keydown' | 'keyup'): void {
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

/** Press a key (keydown + keyup) with a small gap so TETR.IO registers it. */
export function pressKey(code: string, gapMs = 2): Promise<void> {
  return new Promise(resolve => {
    dispatchKey(code, 'keydown');
    setTimeout(() => {
      dispatchKey(code, 'keyup');
      resolve();
    }, gapMs);
  });
}

export function inputDelay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
