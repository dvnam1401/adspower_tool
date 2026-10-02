/**
 * Account Hub — Field-mapping self-heal (Phase 1)
 *
 * Pure logic (no DB, no I/O) that detects when a mapped Google Sheet column has
 * drifted — typically because a column was inserted/removed and every index to
 * its right shifted — and re-points the mapping to the column that still carries
 * the header it was created against. When no confident match remains the mapping
 * is flagged `needsAttention` instead of silently pointing at the wrong column.
 */

import type { FieldMapping } from '../db/repositories/sheet-source-repository.js';

/** 0-based column index → spreadsheet letter (0→A, 25→Z, 26→AA). */
export function columnIndexToLetter(index: number): string {
  let n = index;
  let letter = '';
  do {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letter;
}

/** Normalize a header for comparison: lowercase, strip punctuation, collapse whitespace. */
export function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Levenshtein-based similarity ratio in [0,1]. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  const distance = dp[n];
  return 1 - distance / Math.max(m, n);
}

/** Minimum fuzzy similarity to accept a re-point without human review. */
export const FUZZY_THRESHOLD = 0.72;

export type MappingHealAction = 'aligned' | 'healed_exact' | 'healed_fuzzy' | 'orphaned';

export interface MappingHealChange {
  mappingId:     string;
  systemField:   string | null;
  mappedHeader:  string;
  action:        MappingHealAction;
  fromIndex:     number;
  toIndex:       number | null;
  toLetter:      string | null;
  matchedHeader: string | null;
  score:         number | null;
  needsAttention: boolean;
}

export interface MappingHealReport {
  changes:  MappingHealChange[];
  healed:   MappingHealChange[];
  orphaned: MappingHealChange[];
}

/**
 * Compare each mapping's stored `mappedHeader` against the sheet's current
 * headers (0-based array) and produce the set of changes required. Mappings
 * without a `mappedHeader` reference are skipped (nothing to compare against).
 */
export function healMappings(mappings: FieldMapping[], headers: string[]): MappingHealReport {
  const normHeaders = headers.map(normalizeHeader);
  const changes: MappingHealChange[] = [];

  for (const m of mappings) {
    if (!m.mappedHeader) continue;
    const target = normalizeHeader(m.mappedHeader);
    const atIndex = normHeaders[m.columnIndex];

    // Still correctly aligned — clear any stale attention flag.
    if (atIndex === target) {
      if (m.needsAttention) {
        changes.push(mkChange(m, 'aligned', m.columnIndex, m.columnIndex, false));
      }
      continue;
    }

    // Exact header match elsewhere → re-point.
    const exactIdx = normHeaders.findIndex((h) => h === target);
    if (exactIdx !== -1) {
      changes.push(mkChange(m, 'healed_exact', m.columnIndex, exactIdx, false, normHeaders[exactIdx], 1));
      continue;
    }

    // Fuzzy: pick the best-scoring current header above the threshold.
    let bestIdx = -1;
    let bestScore = 0;
    normHeaders.forEach((h, i) => {
      if (!h) return;
      const s = similarity(target, h);
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    });

    if (bestIdx !== -1 && bestScore >= FUZZY_THRESHOLD) {
      changes.push(mkChange(m, 'healed_fuzzy', m.columnIndex, bestIdx, false, normHeaders[bestIdx], bestScore));
    } else {
      changes.push(mkChange(m, 'orphaned', m.columnIndex, null, true, null, bestIdx === -1 ? null : bestScore));
    }
  }

  return {
    changes,
    healed:   changes.filter((c) => c.action === 'healed_exact' || c.action === 'healed_fuzzy'),
    orphaned: changes.filter((c) => c.action === 'orphaned'),
  };
}

function mkChange(
  m: FieldMapping,
  action: MappingHealAction,
  fromIndex: number,
  toIndex: number | null,
  needsAttention: boolean,
  matchedHeader: string | null = null,
  score: number | null = null,
): MappingHealChange {
  return {
    mappingId:      m.id,
    systemField:    m.systemField,
    mappedHeader:   m.mappedHeader!,
    action,
    fromIndex,
    toIndex,
    toLetter:       toIndex === null ? null : columnIndexToLetter(toIndex),
    matchedHeader,
    score,
    needsAttention,
  };
}
