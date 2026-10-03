/**
 * Account Hub — DIE colour detection (pure)
 *
 * The warehouse reads the DIE state from a Sheet's cell BACKGROUND colour only
 * (spec §0.3, §4). Two source layouts are supported, chosen per-source via
 * `die_read_mode`:
 *   - 'full_row'   : the whole data row is coloured red (TK sheets).
 *   - 'cell_range' : only a specific column range is coloured red (BC sheets, F:G).
 *   - 'none'       : this source does not encode DIE via colour.
 *
 * Detection is threshold-based (strong red) rather than an exact hex compare so a
 * slightly-off user red still registers; the thresholds are configurable.
 * Other colours on the sheet are the user's private notation and MUST be ignored.
 */

import type { DieReadMode } from './types.js';

/** RGB in the Google Sheets convention: each channel a float 0..1. */
export interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

export interface DieColorThresholds {
  /** Minimum red channel for a cell to count as red. */
  redMin: number;
  /** Maximum green/blue channel for a cell to count as red. */
  otherMax: number;
  /** Red must dominate the other channels by at least this much. */
  dominance: number;
  /**
   * full_row mode: a row is DIE when at least this fraction of its coloured
   * (non-white) cells are red. Tolerates a stray non-red cell.
   */
  rowFraction: number;
}

export const DEFAULT_DIE_THRESHOLDS: DieColorThresholds = {
  redMin: 0.55,
  otherMax: 0.5,
  dominance: 0.2,
  rowFraction: 0.6,
};

const WHITE_MIN = 0.92;

/** Normalise a raw Sheets API colour object (channels may be omitted = 0). */
export function toRgb(raw: unknown): RgbColor | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const red = typeof c.red === 'number' ? c.red : 0;
  const green = typeof c.green === 'number' ? c.green : 0;
  const blue = typeof c.blue === 'number' ? c.blue : 0;
  return { red, green, blue };
}

/** A cell that is effectively white / unfilled carries no DIE signal. */
export function isWhite(color: RgbColor | null): boolean {
  if (!color) return true;
  return color.red >= WHITE_MIN && color.green >= WHITE_MIN && color.blue >= WHITE_MIN;
}

/** True when a single cell background is a strong red per the thresholds. */
export function isDieRed(
  color: RgbColor | null,
  t: DieColorThresholds = DEFAULT_DIE_THRESHOLDS,
): boolean {
  if (!color) return false;
  const { red, green, blue } = color;
  return (
    red >= t.redMin &&
    green <= t.otherMax &&
    blue <= t.otherMax &&
    red - Math.max(green, blue) >= t.dominance
  );
}

/**
 * Decide whether a row is DIE from the background colours of the cells that
 * matter for the given mode.
 *   - 'cell_range': DIE if ANY cell in `colors` (already narrowed to the
 *      configured columns, e.g. F:G) is red.
 *   - 'full_row'  : DIE if at least `rowFraction` of the coloured cells are red.
 */
export function rowIsDie(
  colors: Array<RgbColor | null>,
  mode: DieReadMode,
  t: DieColorThresholds = DEFAULT_DIE_THRESHOLDS,
): boolean {
  if (mode === 'none') return false;
  const relevant = colors.filter((c) => !isWhite(c));
  if (relevant.length === 0) return false;

  if (mode === 'cell_range') {
    return relevant.some((c) => isDieRed(c, t));
  }

  // full_row
  const redCount = relevant.filter((c) => isDieRed(c, t)).length;
  return redCount > 0 && redCount / relevant.length >= t.rowFraction;
}

/** Convert an A1 column letter (A, B, .., AA) to a 0-based index. */
export function columnLetterToIndex(letter: string): number {
  const s = letter.trim().toUpperCase();
  let idx = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 65 || code > 90) return -1;
    idx = idx * 26 + (code - 64);
  }
  return idx - 1;
}

/**
 * Parse a column spec into 0-based column indices.
 * Accepts "F", "F:G" (inclusive range), and comma lists "F,H,J".
 */
export function parseColumnSpec(spec: string | null | undefined): number[] {
  if (!spec) return [];
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const token = part.trim();
    if (!token) continue;
    if (token.includes(':')) {
      const [a, b] = token.split(':');
      const start = columnLetterToIndex(a);
      const end = columnLetterToIndex(b);
      if (start < 0 || end < 0) continue;
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      for (let i = lo; i <= hi; i++) out.add(i);
    } else {
      const i = columnLetterToIndex(token);
      if (i >= 0) out.add(i);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Canonical hex (#RRGGBB) → RgbColor, for configuring an exact DIE code. */
export function hexToRgb(hex: string): RgbColor | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return {
    red: ((n >> 16) & 0xff) / 255,
    green: ((n >> 8) & 0xff) / 255,
    blue: (n & 0xff) / 255,
  };
}

/** The canonical DIE red used when a source has no explicit die_write_color. */
export const CANONICAL_DIE_RED: RgbColor = { red: 1, green: 0, blue: 0 };

/**
 * The contiguous [colStart, colEnd) 0-based column region the DIE colour is
 * painted over for a source (spec §4 decision #3):
 *  - cell_range: the span covering die_color_columns, e.g. "F:G" -> [5, 7).
 *  - full_row:   [0, rowWidth) — the whole used row (TK).
 *  - none:       [0, 0) — nothing is written.
 */
export function computeDieWriteRegion(
  mode: DieReadMode,
  colorColumns: string | null | undefined,
  rowWidth: number,
): { colStart: number; colEnd: number } {
  if (mode === 'full_row') return { colStart: 0, colEnd: Math.max(0, rowWidth) };
  if (mode === 'cell_range') {
    const cols = parseColumnSpec(colorColumns);
    if (!cols.length) return { colStart: 0, colEnd: 0 };
    return { colStart: cols[0], colEnd: cols[cols.length - 1] + 1 };
  }
  return { colStart: 0, colEnd: 0 };
}

/** Resolve a source's configured DIE write colour, falling back to canonical red. */
export function resolveDieWriteColor(hex: string | null | undefined): RgbColor {
  return (hex ? hexToRgb(hex) : null) ?? CANONICAL_DIE_RED;
}
