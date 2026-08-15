/**
 * Client-side quota enforcement.
 *
 * Free tiers cap requests per minute, requests per day and tokens per minute. Being
 * throttled is not merely slow here: a wasted request is quota we cannot get back
 * until tomorrow, so the app self-limits rather than discovering limits via 429s.
 * State is persisted (see `storage/db.ts`) so a reload does not reset the counters.
 */
import type { Limits } from "./presets";

export interface LimiterState {
  /** Epoch-ms of each request in the trailing minute. */
  requests: number[];
  /** Token spends in the trailing minute. */
  tokens: { at: number; n: number }[];
  /** Day key (`YYYY-MM-DD`) the daily counters belong to. */
  day: string;
  dayRequests: number;
  dayTokens: number;
  /** Epoch-ms before which no request may be sent, set by a 429's Retry-After. */
  blockedUntil: number;
}

export function emptyState(): LimiterState {
  return { requests: [], tokens: [], day: "", dayRequests: 0, dayTokens: 0, blockedUntil: 0 };
}

const MINUTE = 60_000;

export function dayKey(at: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

export interface Availability {
  /** Milliseconds to wait before sending. 0 = send now. */
  waitMs: number;
  /** Set when the daily quota is exhausted — waiting will not help today. */
  reason?: "rpd" | "rpm" | "tpm" | "backoff";
}

/** What the runner needs from a limiter; keeps it substitutable in tests. */
export interface Quota {
  check(estTokens: number): Availability;
  reserve(estTokens: number): void;
  settle(estTokens: number, actualTokens: number): void;
  penalize(retryAfterSec: number): void;
}

export class RateLimiter implements Quota {
  constructor(
    private limits: Limits,
    private tz: string,
    public state: LimiterState = emptyState(),
    private onChange: (s: LimiterState) => void = () => {},
    private now: () => number = Date.now,
  ) {}

  private prune(at: number) {
    const key = dayKey(at, this.tz);
    if (this.state.day !== key) {
      this.state.day = key;
      this.state.dayRequests = 0;
      this.state.dayTokens = 0;
    }
    this.state.requests = this.state.requests.filter((t) => at - t < MINUTE);
    this.state.tokens = this.state.tokens.filter((t) => at - t.at < MINUTE);
  }

  /** How long until a request costing `estTokens` may be sent. */
  check(estTokens: number): Availability {
    const at = this.now();
    this.prune(at);
    const { rpm, rpd, tpm } = this.limits;

    if (this.state.blockedUntil > at) {
      return { waitMs: this.state.blockedUntil - at, reason: "backoff" };
    }
    if (rpd > 0 && this.state.dayRequests >= rpd) {
      return { waitMs: msUntilNextDay(at, this.tz), reason: "rpd" };
    }
    if (rpm > 0 && this.state.requests.length >= rpm) {
      return { waitMs: MINUTE - (at - this.state.requests[0]) + 50, reason: "rpm" };
    }
    if (tpm > 0) {
      const spent = this.state.tokens.reduce((a, b) => a + b.n, 0);
      if (spent + estTokens > tpm && this.state.tokens.length) {
        return { waitMs: MINUTE - (at - this.state.tokens[0].at) + 50, reason: "tpm" };
      }
    }
    return { waitMs: 0 };
  }

  /** Book a request against the quota. Call immediately before sending. */
  reserve(estTokens: number) {
    const at = this.now();
    this.prune(at);
    this.state.requests.push(at);
    this.state.tokens.push({ at, n: estTokens });
    this.state.dayRequests++;
    this.state.dayTokens += estTokens;
    this.onChange(this.state);
  }

  /** Correct the reservation once the real usage is known. */
  settle(estTokens: number, actualTokens: number) {
    const delta = actualTokens - estTokens;
    if (!delta) return;
    const last = this.state.tokens[this.state.tokens.length - 1];
    if (last) last.n = Math.max(0, last.n + delta);
    this.state.dayTokens = Math.max(0, this.state.dayTokens + delta);
    this.onChange(this.state);
  }

  /** Honour a 429: nothing may be sent until the server says so. */
  penalize(retryAfterSec: number) {
    this.state.blockedUntil = this.now() + Math.max(1, retryAfterSec) * 1000;
    this.onChange(this.state);
  }

  get usage() {
    const at = this.now();
    this.prune(at);
    return {
      rpmUsed: this.state.requests.length,
      rpdUsed: this.state.dayRequests,
      tpmUsed: this.state.tokens.reduce((a, b) => a + b.n, 0),
      dayTokens: this.state.dayTokens,
      limits: this.limits,
    };
  }
}

function msUntilNextDay(at: number, tz: string): number {
  const today = dayKey(at, tz);
  // Walk forward in hours until the day key rolls over; cheap and DST-proof.
  for (let h = 1; h <= 26; h++) {
    const t = at + h * 3600_000;
    if (dayKey(t, tz) !== today) return t - at;
  }
  return 24 * 3600_000;
}
