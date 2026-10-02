/**
 * Account Hub — Google Sheets Gateway primitives (Phase 3 hardening)
 *
 * Two AdsPower-independent, transport-agnostic primitives that protect every
 * Google Sheets API call:
 *
 *   - {@link RateLimiter}: a per-key (per-spreadsheet_id) token bucket that
 *     paces outbound calls so a burst of jobs never blows the Sheets quota.
 *   - {@link withBackoff}: exponential backoff + jitter retry that only fires
 *     on transient failures (HTTP 429 / 5xx / transient network codes).
 *
 * Both take an injectable {@link Clock} so they are deterministic under test
 * with no real timers and no network. Nothing here reaches AdsPower.
 */

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  // NOTE: executor form (not Promise.withResolvers) — this repo's tsconfig `lib`
  // is pre-ES2024, so withResolvers has no type. Do not widen lib for one call.
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

// ---------------------------------------------------------------------------
// Token-bucket rate limiter (per key)
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  /** Sustained token refill rate, tokens per second. */
  ratePerSec: number;
  /** Maximum tokens that can accumulate (burst ceiling). */
  burst: number;
  clock?: Clock;
}

interface BucketState {
  tokens: number;
  lastRefill: number;
}

/**
 * A token bucket keyed by an arbitrary string (we key on spreadsheetId).
 * `acquire(key)` resolves once a whole token is available for that key,
 * sleeping via the injected clock otherwise. Calls for the same key are
 * serialized so tokens are never double-spent under concurrency.
 */
export class RateLimiter {
  private readonly ratePerSec: number;
  private readonly burst: number;
  private readonly clock: Clock;
  private readonly buckets = new Map<string, BucketState>();
  /** Per-key tail promise: enforces sequential token consumption. */
  private readonly tails = new Map<string, Promise<void>>();

  constructor(opts: RateLimiterOptions) {
    if (opts.ratePerSec <= 0) throw new Error('RateLimiter: ratePerSec must be > 0');
    if (opts.burst <= 0) throw new Error('RateLimiter: burst must be > 0');
    this.ratePerSec = opts.ratePerSec;
    this.burst = opts.burst;
    this.clock = opts.clock ?? systemClock;
  }

  async acquire(key: string): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const cur = prev.then(() => this.consume(key), () => this.consume(key));
    // Keep the tail alive but never let a rejection poison the chain.
    this.tails.set(key, cur.then(() => undefined, () => undefined));
    return cur;
  }

  private async consume(key: string): Promise<void> {
    for (;;) {
      const bucket = this.refill(key);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      const deficit = 1 - bucket.tokens;
      const waitMs = Math.ceil((deficit / this.ratePerSec) * 1000);
      await this.clock.sleep(waitMs);
    }
  }

  private refill(key: string): BucketState {
    const now = this.clock.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.burst, lastRefill: now };
      this.buckets.set(key, bucket);
      return bucket;
    }
    const elapsedSec = Math.max(0, now - bucket.lastRefill) / 1000;
    if (elapsedSec > 0) {
      bucket.tokens = Math.min(this.burst, bucket.tokens + elapsedSec * this.ratePerSec);
      bucket.lastRefill = now;
    }
    return bucket;
  }
}

// ---------------------------------------------------------------------------
// Retryable-error classification
// ---------------------------------------------------------------------------

const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
  'ECONNABORTED',
]);

/** Best-effort HTTP status extraction across googleapis / gaxios error shapes. */
function httpStatusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.status === 'number') return e.status;
  if (typeof e.code === 'number') return e.code;
  if (typeof e.code === 'string' && /^\d{3}$/.test(e.code)) return Number(e.code);
  const response = e.response as Record<string, unknown> | undefined;
  if (response && typeof response.status === 'number') return response.status;
  return undefined;
}

/**
 * True for transient Sheets failures worth retrying: HTTP 429 (rate limit),
 * any 5xx, or a transient network error code. Everything else (4xx auth /
 * validation, parse errors) is surfaced immediately — retrying would only
 * waste quota.
 */
export function isRetryableSheetsError(err: unknown): boolean {
  const status = httpStatusOf(err);
  if (status === 429) return true;
  if (status !== undefined && status >= 500 && status <= 599) return true;
  if (err && typeof err === 'object') {
    const code = (err as Record<string, unknown>).code;
    if (typeof code === 'string' && TRANSIENT_NET_CODES.has(code)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Exponential backoff with jitter
// ---------------------------------------------------------------------------

export interface BackoffOptions {
  /** Max retry attempts after the initial try (default 5). */
  retries?: number;
  /** Base delay in ms for the first backoff (default 500). */
  baseMs?: number;
  /** Cap for a single backoff delay in ms (default 30000). */
  maxMs?: number;
  clock?: Clock;
  isRetryable?: (err: unknown) => boolean;
  /** Injectable RNG for deterministic jitter under test (default Math.random). */
  random?: () => number;
}

/**
 * Run `fn`, retrying transient failures with exponential backoff + additive
 * jitter. Non-retryable errors and exhausted retries re-throw the original
 * error unchanged.
 */
export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions = {}): Promise<T> {
  const retries = opts.retries ?? 5;
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 30_000;
  const clock = opts.clock ?? systemClock;
  const isRetryable = opts.isRetryable ?? isRetryableSheetsError;
  const random = opts.random ?? Math.random;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries || !isRetryable(err)) throw err;
      const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const jitter = random() * exp * 0.25; // up to +25% to de-correlate retries
      await clock.sleep(exp + jitter);
    }
  }
}
