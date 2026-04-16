# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome Extension (Manifest V3) that plays TETR.IO Zen mode automatically. It reads game state from the WebGL canvas via pixel analysis, runs an AI engine to find optimal piece placements, and simulates keyboard input to execute moves. For research/learning purposes only.

## Build Commands

- `npm run build` — Production build (webpack, outputs to `dist/`)
- `npm run dev` — Development build with watch mode
- `npm run clean` — Remove `dist/` directory

No test framework is configured. No linter is configured.

### Building from Claude Code's shell

`npm` / `node` are NOT on PATH in Claude Code's bash. Don't waste time searching — use the bundled node binary directly:

```bash
cd "c:/Users/lintz/Documents/claude code/Tetris_bot" && \
  "/c/Users/lintz/Documents/claude code/MusicScribe AI/.node/node.exe" \
  node_modules/webpack/bin/webpack.js --mode production
```

For watch mode, append `--watch` and run with `run_in_background: true`. `node_modules/` is already installed — no need to `npm install`.

To test: load `dist/` as an unpacked Chrome extension, navigate to https://tetr.io, enter Zen mode, and use the popup UI to start the bot.

## Architecture

Four webpack entry points, each running in a different Chrome Extension context:

1. **`src/background/service-worker.ts`** — Message relay between popup and content script. Finds the active tetr.io tab and forwards messages.

2. **`src/content/content-script.ts`** — Runs in tetr.io page (isolated world). Injects game-hook, receives game state via `postMessage`, runs the AI engine, and sends move commands back to game-hook for execution. Owns bot lifecycle (start/stop) and stats tracking.

3. **`src/injected/game-hook.ts`** — Injected into page's main world. This is the largest and most complex file. Responsibilities:
   - Patches `HTMLCanvasElement.getContext` at load time to force `preserveDrawingBuffer: true` (required to read WebGL pixels)
   - Overrides visibility/focus APIs so the game doesn't pause when DevTools is open
   - Reads the WebGL canvas by drawing it to a 2D canvas and using `getImageData`
   - Auto-calibrates the board grid position using border detection or dark-region scanning
   - Classifies cell colors to piece types using HSL hue ranges
   - Detects current piece, next queue, and hold piece from canvas pixels
   - Executes keyboard moves via `KeyboardEvent` dispatch
   - Polls at ~200ms intervals, sending `GameState` to content-script via `postMessage`

4. **`src/popup/popup.ts`** + **`popup.html`** — Extension popup UI with start/stop controls, speed slider, and stats display.

### AI Modules (`src/ai/`)

- **`piece.ts`** — SRS piece shapes (4 rotation states each) and wall kick offset tables for all 7 piece types
- **`board.ts`** — Board simulation: collision detection, hard drop, piece placement, line clearing, and exhaustive placement generation (all rotations x all x-positions)
- **`evaluator.ts`** — Weighted scoring function (holes, bumpiness, aggregate height, row/column transitions, well depth, lines cleared, board height). Default weights based on ElTetris research.
- **`engine.ts`** — Depth-1 search: evaluates all placements for current piece and hold piece, returns the best `AIDecision`

### Types (`src/types/index.ts`)

Shared type definitions used across AI and controller modules. Board is `(PieceType | null)[][]` with 24 rows (20 visible + 4 buffer). Messages between extension components use `ExtensionMessage` with `MessageType` discriminator.

### Data Flow

```
game-hook (main world, reads canvas pixels)
  → postMessage → content-script (isolated world, runs AI)
    → postMessage → game-hook (executes keyboard events)
```

The content-script also communicates with popup/background via `chrome.runtime.sendMessage`.

## Key Technical Details

- Board coordinate system: row 0 is top, row increases downward. Board is 10 wide x 24 tall (20 visible + 4 hidden buffer rows).
- Piece shapes use `[row, col]` offsets. Wall kick offsets use `[col, row]` format (note the difference).
- The game-hook must be injected at `document_start` (before TETR.IO creates its WebGL context) to patch `getContext`.
- Color detection uses HSL hue ranges with saturation/lightness thresholds. The hue ranges for each piece type are defined in `game-hook.ts`.
- The content-script assumes pieces always spawn at rotation=0, x=3 when calculating move sequences.
- Path alias `@/` maps to `src/` (configured in both tsconfig.json and webpack.config.js).
