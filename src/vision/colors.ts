/**
 * Adaptive color palette for piece classification.
 *
 * Replaces hardcoded HSL hue ranges with a runtime-learned palette built from
 * the actual TETR.IO render. We sample known piece regions (hold, queue) and
 * the empty board background, then classify cells by nearest-color distance
 * in HSL space (weighted toward hue, with a hard saturation gate to keep
 * I/J disambiguated).
 *
 * Falls back to fixed hue ranges if learning fails.
 */

import { PieceType, ALL_PIECE_TYPES } from '@/types';

export type RGB = [number, number, number];
export type HSL = [number, number, number];

export function rgbToHsl(r: number, g: number, b: number): HSL {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return [h, s, l];
}

/** Smallest angular distance between two hues (degrees, 0-180). */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Weighted distance between two HSL samples — hue dominates, then saturation. */
function hslDistance(a: HSL, b: HSL): number {
  const dh = hueDistance(a[0], b[0]) / 180; // 0..1
  const ds = Math.abs(a[1] - b[1]);
  const dl = Math.abs(a[2] - b[2]);
  return dh * 3 + ds * 1 + dl * 0.4;
}

/** Hue ranges used by the fallback classifier when the palette is not ready. */
const FALLBACK_HUE_RANGES: Array<{ piece: PieceType; min: number; max: number }> = [
  { piece: 'Z', min: 345, max: 360 },
  { piece: 'Z', min: 0,   max: 15  },
  { piece: 'L', min: 15,  max: 45  },
  { piece: 'O', min: 45,  max: 70  },
  { piece: 'S', min: 70,  max: 170 },
  { piece: 'I', min: 170, max: 200 },
  { piece: 'J', min: 200, max: 260 },
  { piece: 'T', min: 260, max: 345 },
];

export function fallbackClassify(r: number, g: number, b: number, minSat = 0.45): PieceType | null {
  const [h, s, l] = rgbToHsl(r, g, b);
  if (s < minSat || l < 0.18 || l > 0.78) return null;
  for (const { piece, min, max } of FALLBACK_HUE_RANGES) {
    if (h >= min && h < max) {
      // I-piece needs extra saturation to win against blue-leaning rendering
      if (piece === 'I' && s < 0.55) continue;
      return piece;
    }
  }
  return null;
}

export function isFilledPixel(
  r: number, g: number, b: number, a: number, minSat = 0.40,
): boolean {
  if (a < 100) return false;
  const [, s, l] = rgbToHsl(r, g, b);
  if (l < 0.18) return false;
  if (l > 0.80) return false;
  return s >= minSat;
}

export function isEmptyPixel(
  r: number, g: number, b: number, a: number, minSat = 0.40,
): boolean {
  if (a < 50) return true;
  const [, s, l] = rgbToHsl(r, g, b);
  if (l < 0.18) return true;
  return s < minSat;
}

/** Single classification result with confidence info. */
export interface ClassifyResult {
  piece: PieceType | null;
  /** Distance to chosen anchor (lower is better). */
  distance: number;
  /** Distance ratio to runner-up (higher = more confident). */
  margin: number;
  /** True iff the result came from the learned palette rather than fallback. */
  learned: boolean;
}

/**
 * AdaptivePalette: learns one HSL anchor per piece type from observed samples,
 * then classifies new pixels by nearest anchor.
 *
 * Use:
 *   const palette = new AdaptivePalette();
 *   palette.addSample('T', r, g, b);     // collect from queue/hold/board
 *   palette.finalize();                  // call once enough samples collected
 *   palette.classify(r, g, b, a);        // classify new pixel
 */
export class AdaptivePalette {
  /** All samples collected for each piece type. */
  private samples: Record<PieceType, HSL[]> = {
    I: [], O: [], T: [], S: [], Z: [], J: [], L: [],
  };
  /** Anchor HSL per piece (median of samples). Empty until finalize() is called. */
  private anchors: Partial<Record<PieceType, HSL>> = {};
  private ready = false;

  /** Minimum samples per piece type to consider an anchor learned. */
  static readonly MIN_SAMPLES_PER_PIECE = 3;

  addSample(piece: PieceType, r: number, g: number, b: number): void {
    const [h, s, l] = rgbToHsl(r, g, b);
    // Reject obviously-background pixels
    if (s < 0.30 || l < 0.18 || l > 0.85) return;
    this.samples[piece].push([h, s, l]);
  }

  /** Compute anchors from accumulated samples. Returns # of pieces with anchors. */
  finalize(): number {
    this.anchors = {};
    let learnedCount = 0;
    for (const piece of ALL_PIECE_TYPES) {
      const list = this.samples[piece];
      if (list.length < AdaptivePalette.MIN_SAMPLES_PER_PIECE) continue;

      // Hue is circular — convert to xy then back so the median is sensible.
      let sx = 0, sy = 0;
      for (const [h] of list) {
        const rad = (h * Math.PI) / 180;
        sx += Math.cos(rad);
        sy += Math.sin(rad);
      }
      const meanHue = ((Math.atan2(sy / list.length, sx / list.length) * 180) / Math.PI + 360) % 360;
      const meanS = list.reduce((a, [, s]) => a + s, 0) / list.length;
      const meanL = list.reduce((a, [, , l]) => a + l, 0) / list.length;
      this.anchors[piece] = [meanHue, meanS, meanL];
      learnedCount++;
    }
    // Need at least 5 pieces learned to consider the palette ready; rest can fall back.
    this.ready = learnedCount >= 5;
    return learnedCount;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Dump anchors for logging. */
  describe(): string {
    if (!this.ready) return 'palette not ready';
    const parts: string[] = [];
    for (const piece of ALL_PIECE_TYPES) {
      const a = this.anchors[piece];
      if (a) parts.push(`${piece}=hsl(${a[0].toFixed(0)},${(a[1] * 100).toFixed(0)}%,${(a[2] * 100).toFixed(0)}%)`);
      else parts.push(`${piece}=?`);
    }
    return parts.join(' ');
  }

  /**
   * Classify a pixel. When the palette is ready, uses nearest-anchor distance
   * in HSL space; otherwise falls back to fixed hue ranges.
   */
  classify(
    r: number, g: number, b: number, a: number,
    minSat = 0.40,
  ): ClassifyResult {
    if (a < 50) return { piece: null, distance: Infinity, margin: 0, learned: false };
    const hsl = rgbToHsl(r, g, b);
    if (hsl[1] < minSat || hsl[2] < 0.18 || hsl[2] > 0.80) {
      return { piece: null, distance: Infinity, margin: 0, learned: false };
    }

    if (!this.ready) {
      const piece = fallbackClassify(r, g, b, minSat);
      return { piece, distance: piece ? 0 : Infinity, margin: 1, learned: false };
    }

    let bestPiece: PieceType | null = null;
    let bestDist = Infinity;
    let secondDist = Infinity;
    for (const piece of ALL_PIECE_TYPES) {
      const anchor = this.anchors[piece];
      if (!anchor) continue;
      const d = hslDistance(hsl, anchor);
      if (d < bestDist) {
        secondDist = bestDist;
        bestDist = d;
        bestPiece = piece;
      } else if (d < secondDist) {
        secondDist = d;
      }
    }

    // I-piece hard gate: require high saturation. Stops dark cyan-blue mid-frames
    // from being mistaken for I.
    if (bestPiece === 'I' && hsl[1] < 0.55) {
      // Disqualify I and pick the next-best non-I anchor
      let alt: PieceType | null = null;
      let altDist = Infinity;
      for (const piece of ALL_PIECE_TYPES) {
        if (piece === 'I') continue;
        const anchor = this.anchors[piece];
        if (!anchor) continue;
        const d = hslDistance(hsl, anchor);
        if (d < altDist) { altDist = d; alt = piece; }
      }
      bestPiece = alt;
      bestDist = altDist;
    }

    // Reject low-confidence matches (too far from anchor or too close to runner-up)
    if (bestDist > 1.2) return { piece: null, distance: bestDist, margin: 0, learned: true };
    const margin = secondDist === Infinity ? 10 : secondDist / Math.max(bestDist, 0.001);
    if (margin < 1.15) return { piece: null, distance: bestDist, margin, learned: true };

    return { piece: bestPiece, distance: bestDist, margin, learned: true };
  }

  /** Reset all samples and anchors (e.g. on bot restart). */
  reset(): void {
    for (const piece of ALL_PIECE_TYPES) this.samples[piece] = [];
    this.anchors = {};
    this.ready = false;
  }

  /** Count of samples for diagnostic logs. */
  sampleCount(): Partial<Record<PieceType, number>> {
    const out: Partial<Record<PieceType, number>> = {};
    for (const p of ALL_PIECE_TYPES) out[p] = this.samples[p].length;
    return out;
  }
}
