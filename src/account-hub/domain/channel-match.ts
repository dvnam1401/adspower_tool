/**
 * Account Hub — Channel name normalisation & matching (pure, spec §4)
 *
 * BC rows carry a channel name/link that must be matched against the Reup source
 * for the same country. Matching is diacritic- and case-insensitive on a
 * normalised key. This is intentionally separate from profile-name normalisation
 * (domain/utils.normalizeName), which preserves separators for a different purpose.
 */

/**
 * Normalise a channel name for comparison:
 *  - strip diacritics (Vietnamese etc.)
 *  - lowercase
 *  - drop everything except [a-z0-9], collapsing runs to a single space
 */
export function normalizeChannelName(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Extract a channel handle from a YouTube URL/link when present, else return the
 * raw string. Handles `@handle`, `/channel/<id>`, `/c/<name>`, `/user/<name>`.
 */
export function extractChannelKey(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = raw.trim();
  const at = /(?:youtube\.com\/)?@([A-Za-z0-9._-]+)/.exec(s);
  if (at) return normalizeChannelName(at[1]);
  const path = /youtube\.com\/(?:channel|c|user)\/([A-Za-z0-9._-]+)/.exec(s);
  if (path) return normalizeChannelName(path[1]);
  return normalizeChannelName(s);
}

export type ChannelMatchOutcome = 'PENDING' | 'AMBIGUOUS' | 'MATCHED';

export interface ChannelMatchResult {
  outcome: ChannelMatchOutcome;
  /** The Reup link chosen when outcome === 'MATCHED'. */
  link: string | null;
  /** Candidate links when AMBIGUOUS (>1) or MATCHED (1). */
  candidates: string[];
}

export interface ReupChannel {
  key: string;   // normalised match key
  link: string;  // channel URL to copy back
}

/**
 * Match one BC channel key against an index of Reup channels for the country.
 *  - 0 hits  → PENDING (put on "needs handling" list; does NOT block)
 *  - 1 hit   → MATCHED, link copied
 *  - >1 hits → AMBIGUOUS (does NOT block)
 */
export function matchChannel(bcKey: string, reup: ReupChannel[]): ChannelMatchResult {
  if (!bcKey) return { outcome: 'PENDING', link: null, candidates: [] };
  const hits = reup.filter((r) => r.key === bcKey);
  if (hits.length === 0) return { outcome: 'PENDING', link: null, candidates: [] };
  if (hits.length === 1) return { outcome: 'MATCHED', link: hits[0].link, candidates: [hits[0].link] };
  return { outcome: 'AMBIGUOUS', link: null, candidates: hits.map((h) => h.link) };
}
