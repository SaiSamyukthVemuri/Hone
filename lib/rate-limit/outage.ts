import { createAdminClient } from "@/lib/supabase/admin-server";
import { thrownErrorClass } from "@/lib/logging/error-class";
import { reportLimiterOutage } from "@/lib/observability/limiter-outage-alert";

// DN-29 (Sam, 3 Nov 2026): what a public limiter does when Upstash is missing or errors.
//
//   refuse     sensitive token/link operations (token routes, portal sign-in, waitlist proof): refuse with the calm retry message.
//   book       public booking (and the studio booking waitlist): a BOUNDED FALLBACK, 5 per visitor per 10 min and 30 per studio per hour.
//   slots      public slot search: its own, larger fallback (60 per visitor per 10 min).
//   marketing  anonymous landing waitlist and demo requests: 5 per visitor per hour, 3 per email per day.
//   open       authenticated staff limiters (class D): unchanged, fail open.
//
// The fallback counter is a Postgres fixed-window counter (0294, held), so it is SHARED by every app instance. Every attempt
// is counted BEFORE the work runs, failures included. If the counter cannot be reached, the request is REFUSED: a bound that
// cannot be enforced is not a bound. Fixed windows can admit up to twice the limit across a window boundary (a burst at the
// end of one window and the start of the next); the fallback is a bound, not a precise limiter.
//
// Identifiers arrive here ALREADY HASHED by the caller (SHA-256, truncated). Nothing in this file logs or stores a raw IP,
// email, token or slug, and the alert event carries no identifier at all.

export type OutageKind = "refuse" | "book" | "slots" | "marketing" | "open";
export type OutageReason = "disabled" | "error";
export type OutageResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Seconds a refused caller is told to wait when the limiter is down and no counter decided it. */
const REFUSE_RETRY_SECONDS = 60;
/** The counter must answer quickly: a slow counter is an unreachable counter. */
const COUNTER_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// Operator configuration (environment). One validated parser: a value that is not a plain integer inside its bounds, or
// is absent, falls back to the DN value. It can never become "unlimited" (no zero, no negative, no upper bound above the cap).
// ---------------------------------------------------------------------------
type Bounds = { def: number; min: number; max: number };
const PARAMS = {
  HONE_LIMITER_FALLBACK_BOOK_VISITOR_MAX: { def: 5, min: 1, max: 1000 },
  HONE_LIMITER_FALLBACK_BOOK_VISITOR_WINDOW_MIN: { def: 10, min: 1, max: 1440 },
  HONE_LIMITER_FALLBACK_BOOK_STUDIO_MAX: { def: 30, min: 1, max: 100_000 },
  HONE_LIMITER_FALLBACK_BOOK_STUDIO_WINDOW_MIN: { def: 60, min: 1, max: 1440 },
  HONE_LIMITER_FALLBACK_SLOTS_VISITOR_MAX: { def: 60, min: 1, max: 10_000 },
  HONE_LIMITER_FALLBACK_SLOTS_VISITOR_WINDOW_MIN: { def: 10, min: 1, max: 1440 },
  HONE_LIMITER_FALLBACK_MARKETING_VISITOR_MAX: { def: 5, min: 1, max: 1000 },
  HONE_LIMITER_FALLBACK_MARKETING_VISITOR_WINDOW_MIN: { def: 60, min: 1, max: 1440 },
  HONE_LIMITER_FALLBACK_MARKETING_EMAIL_MAX: { def: 3, min: 1, max: 1000 },
  HONE_LIMITER_FALLBACK_MARKETING_EMAIL_WINDOW_MIN: { def: 1440, min: 1, max: 10_080 },
} as const satisfies Record<string, Bounds>;
export type FallbackParam = keyof typeof PARAMS;

export function fallbackParam(name: FallbackParam, env: NodeJS.ProcessEnv = process.env): number {
  const b: Bounds = PARAMS[name];
  const raw = env[name];
  if (typeof raw !== "string" || !/^\d{1,9}$/.test(raw.trim())) return b.def;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n >= b.min && n <= b.max ? n : b.def;
}

// ---------------------------------------------------------------------------
// Mode. Hosted deployments (anything Vercel runs: production, preview or `vercel dev`) ALWAYS enforce; the environment
// variable cannot switch it off there. Only a process that is NOT on Vercel (a developer machine, or the CI browser lanes
// that start the app themselves and have no Upstash) may keep today's open behaviour, and it does so by default; setting
// HONE_LIMITER_OUTAGE_MODE=enforce turns the real fallback on for the proof runs.
// ---------------------------------------------------------------------------
export type OutageMode = "enforce" | "open";
export function outageMode(env: NodeJS.ProcessEnv = process.env): OutageMode {
  const hosted = Boolean(env.VERCEL) || env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "development";
  if (hosted) return "enforce";
  return env.HONE_LIMITER_OUTAGE_MODE === "enforce" ? "enforce" : "open";
}

// ---------------------------------------------------------------------------
// Operator alert: ONE structured event per instance per route class per interval. No identifier of any kind.
// (The alert channel and rule owner are an open item for Sam; nothing hosted is built here.)
// ---------------------------------------------------------------------------
const ALERT_THROTTLE_MS = 60_000;
const lastAlertAt = new Map<string, number>();
export function resetOutageAlertThrottleForTests(): void {
  lastAlertAt.clear();
}
function emitOutageEvent(routeClass: string, kind: OutageKind, mode: OutageMode, reason: OutageReason, outcome: string, err?: unknown): void {
  const now = Date.now();
  const k = `${routeClass}:${outcome}`;
  if (now - (lastAlertAt.get(k) ?? 0) < ALERT_THROTTLE_MS) return;
  lastAlertAt.set(k, now);
  const environment = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown";
  // The operator alert (Sentry, closed values only) and the console line share one throttle.
  reportLimiterOutage({ routeClass, kind, mode, reason, outcome, errorClass: err === undefined ? undefined : thrownErrorClass(err), environment });
  try {
    console.error(
      JSON.stringify({
        event: "ratelimit_outage_fallback",
        routeClass,
        kind,
        mode,
        reason,
        outcome,
        ...(err === undefined ? {} : { errorClass: thrownErrorClass(err) }),
        environment,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch {
    console.error("ratelimit_outage_fallback", routeClass);
  }
}

// ---------------------------------------------------------------------------
// The shared counter.
// ---------------------------------------------------------------------------
type Hit = { scope: string; key: string; windowSeconds: number; limit: number };
type HitResult = { allowed: boolean; retryAfterSeconds: number };

async function hitCounter(hit: Hit): Promise<HitResult> {
  const call = createAdminClient().rpc("rate_limit_fallback_hit", {
    p_scope: hit.scope,
    p_key_hash: hit.key,
    p_window_seconds: hit.windowSeconds,
    p_limit: hit.limit,
  });
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("counter timeout")), COUNTER_TIMEOUT_MS));
  const { data, error } = (await Promise.race([call, timeout])) as { data: unknown; error: unknown };
  if (error) throw new Error("counter error");
  const row = data as { allowed?: unknown; retry_after_seconds?: unknown } | null;
  if (!row || typeof row.allowed !== "boolean") throw new Error("counter malformed");
  return { allowed: row.allowed, retryAfterSeconds: Math.max(1, Number(row.retry_after_seconds) || REFUSE_RETRY_SECONDS) };
}

/** Count every hit (all of them, even when an earlier one is over its limit) and refuse if any is over or any call fails. */
async function decide(hits: Hit[]): Promise<OutageResult> {
  const results = await Promise.all(hits.map(hitCounter));
  const refused = results.filter((r) => !r.allowed);
  if (refused.length === 0) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.max(...refused.map((r) => r.retryAfterSeconds)) };
}

export type OutageKeys = {
  /** hashed visitor identifier (IP), already scoped by the caller where the route is studio-scoped */
  visitor?: string;
  /** studio scope key (slug or id): a PUBLIC identifier, hashed anyway by the caller */
  studio?: string;
  /** hashed email */
  email?: string;
  /** namespace for the counter scopes, so unrelated routes never share a bucket */
  scope: string;
};

function hitsFor(kind: OutageKind, k: OutageKeys): Hit[] | null {
  const min = 60;
  if (kind === "book") {
    if (!k.visitor || !k.studio) return null;
    return [
      { scope: `${k.scope}_visitor`, key: k.visitor, windowSeconds: fallbackParam("HONE_LIMITER_FALLBACK_BOOK_VISITOR_WINDOW_MIN") * min, limit: fallbackParam("HONE_LIMITER_FALLBACK_BOOK_VISITOR_MAX") },
      { scope: `${k.scope}_studio`, key: k.studio, windowSeconds: fallbackParam("HONE_LIMITER_FALLBACK_BOOK_STUDIO_WINDOW_MIN") * min, limit: fallbackParam("HONE_LIMITER_FALLBACK_BOOK_STUDIO_MAX") },
    ];
  }
  if (kind === "slots") {
    if (!k.visitor) return null;
    return [{ scope: `${k.scope}_visitor`, key: k.visitor, windowSeconds: fallbackParam("HONE_LIMITER_FALLBACK_SLOTS_VISITOR_WINDOW_MIN") * min, limit: fallbackParam("HONE_LIMITER_FALLBACK_SLOTS_VISITOR_MAX") }];
  }
  if (kind === "marketing") {
    if (!k.visitor || !k.email) return null;
    return [
      { scope: `${k.scope}_visitor`, key: k.visitor, windowSeconds: fallbackParam("HONE_LIMITER_FALLBACK_MARKETING_VISITOR_WINDOW_MIN") * min, limit: fallbackParam("HONE_LIMITER_FALLBACK_MARKETING_VISITOR_MAX") },
      { scope: `${k.scope}_email`, key: k.email, windowSeconds: fallbackParam("HONE_LIMITER_FALLBACK_MARKETING_EMAIL_WINDOW_MIN") * min, limit: fallbackParam("HONE_LIMITER_FALLBACK_MARKETING_EMAIL_MAX") },
    ];
  }
  return null;
}

/**
 * Called by a public limiter when Upstash is unconfigured (reason "disabled") or threw (reason "error").
 * Returns the decision the limiter must return to its caller.
 */
export async function onLimiterUnavailable(args: {
  kind: OutageKind;
  routeClass: string;
  reason: OutageReason;
  keys?: OutageKeys;
  err?: unknown;
}): Promise<OutageResult> {
  const mode = outageMode();
  if (args.kind === "open" || mode === "open") return { allowed: true };

  if (args.kind === "refuse") {
    emitOutageEvent(args.routeClass, args.kind, mode, args.reason, "refused", args.err);
    return { allowed: false, retryAfterSeconds: REFUSE_RETRY_SECONDS };
  }

  const hits = args.keys ? hitsFor(args.kind, args.keys) : null;
  if (!hits) {
    // A fallback class without the keys it needs cannot be bounded: refuse.
    emitOutageEvent(args.routeClass, args.kind, mode, args.reason, "refused_no_keys", args.err);
    return { allowed: false, retryAfterSeconds: REFUSE_RETRY_SECONDS };
  }
  try {
    const decision = await decide(hits);
    emitOutageEvent(args.routeClass, args.kind, mode, args.reason, decision.allowed ? "fallback_active" : "fallback_limited", args.err);
    return decision;
  } catch (counterErr) {
    emitOutageEvent(args.routeClass, args.kind, mode, args.reason, "refused_counter_unreachable", counterErr);
    return { allowed: false, retryAfterSeconds: REFUSE_RETRY_SECONDS };
  }
}
