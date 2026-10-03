/**
 * Account Hub — Webhook authentication (spec §7.1)
 *
 * The Apps Script push endpoint cannot carry the dashboard's Bearer session
 * token, so a shared-secret HMAC replaces it. Signature covers
 * `${timestamp}.${rawBody}` so a captured body cannot be replayed under a new
 * timestamp, and each accepted signature is remembered for the length of the
 * skew window so it cannot be replayed at all.
 *
 * The secret itself is never logged, echoed, or included in any response.
 */

import crypto from 'node:crypto';

export type WebhookVerdict =
  | 'ok'
  | 'no_secret'
  | 'missing_headers'
  | 'bad_timestamp'
  | 'stale'
  | 'replayed'
  | 'bad_signature';

export interface WebhookHeaders {
  timestamp?: string | string[];
  signature?: string | string[];
}

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

/** `sha256=<hex>` and bare `<hex>` are both accepted. */
function stripPrefix(sig: string): string {
  return sig.startsWith('sha256=') ? sig.slice(7) : sig;
}

export function signPayload(secret: string, timestamp: string, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export class WebhookVerifier {
  /** signature hex -> accepted-at ms, pruned past the skew window. */
  private seen = new Map<string, number>();

  constructor(
    private secret: string,
    private maxSkewSec: number,
  ) {}

  verify(rawBody: string, headers: WebhookHeaders, nowMs = Date.now()): WebhookVerdict {
    if (!this.secret) return 'no_secret';

    const ts = first(headers.timestamp).trim();
    const sig = stripPrefix(first(headers.signature).trim()).toLowerCase();
    if (!ts || !sig) return 'missing_headers';

    const tsMs = Number(ts);
    if (!Number.isFinite(tsMs) || tsMs <= 0) return 'bad_timestamp';

    // Accept seconds or milliseconds — Apps Script hands out both.
    const normalizedMs = tsMs < 1e12 ? tsMs * 1000 : tsMs;
    if (Math.abs(nowMs - normalizedMs) > this.maxSkewSec * 1000) return 'stale';

    const expected = signPayload(this.secret, ts, rawBody);
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'bad_signature';

    this.prune(nowMs);
    if (this.seen.has(sig)) return 'replayed';
    this.seen.set(sig, nowMs);

    return 'ok';
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.maxSkewSec * 1000;
    for (const [sig, at] of this.seen) {
      if (at < cutoff) this.seen.delete(sig);
    }
  }
}
