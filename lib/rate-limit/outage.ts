import { createHmac } from "node:crypto";
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
// Identifiers arrive here ALREADY HASHED by the caller (SHA-256, truncated) and are then keyed with HMAC-SHA-256 under a server-only
// secret (HONE_LIMITER_HMAC_SECRET, read from the environment, never in code or logs) before they reach the database, so the counter
// table holds nothing that can be reversed or guessed from an IP, email or slug (Privacy P1). With no secret configured the fallback
// classes REFUSE (a bound that cannot be keyed safely is not a bound) and the operator log says so. Nothing in this file logs or
// stores a raw IP, email, token or slug, and the alert event carries no identifier at all.

export type OutageKind = "refuse" | "book" | "slots" | "marketing" | "open";
export type OutageReason = "disabled" | "error";
export type OutageResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Name of the environment variable holding the HMAC secret (name only; the value is never in the repository). */
export const HMAC_SECRET_ENV = "HONE_LIMITER_HMAC_SECRET";
/** The secret must be at least this long to count as configured. */
// Privacy Q3: 32 bytes of entropy is 43 base64 characters (`openssl rand -base64 32`); anything shorter is refused, not accepted.
const HMAC_SECRET_MIN_LENGTH = 43;
const HMAC_SECRET_MIN_DISTINCT = 12; // rejects a long run of one repeated pattern that is long enough but is not random
/**
 * NQ-6 (Insurance D-2, open for Sam): one visitor can drain the studio bucket. When true, the visitor bucket is checked FIRST and
 * a visitor-refused attempt does not consume the studio bucket. DEFAULT stays false (every attempt is counted in every bucket)
 * until Sam answers; the recommendation is true.
 */
export const VISITOR_FIRST_SKIPS_STUDIO_BUCKET = false;
/** D-4: how long an in-process "this key is already over its limit" memory lasts at most. The shared counter stays authoritative. */
const OVER_LIMIT_CACHE_MAX_SECONDS = 15;
/** D-3: how long a resolved studio slug is remembered in-process. */
const STUDIO_ID_CACHE_SECONDS = 60;
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

export function fallbackParam(name: FallbackParam, env: Record<string, string | undefined> = process.env): number {
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
export function outageMode(env: Record<string, string | undefined> = process.env): OutageMode {
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
/** The error CLASS only (a closed name), never the error: no raw error object, message or code reaches a log call. */
const classOf = (e: unknown): string | undefined => (e === undefined ? undefined : thrownErrorClass(e));
function emitOutageEvent(routeClass: string, kind: OutageKind, mode: OutageMode, reason: OutageReason, outcome: string, errorClass?: string): void {
  const now = Date.now();
  const k = `${routeClass}:${outcome}`;
  if (now - (lastAlertAt.get(k) ?? 0) < ALERT_THROTTLE_MS) return;
  lastAlertAt.set(k, now);
  const environment = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown";
  // The operator alert (Sentry, closed values only) and the console line share one throttle.
  reportLimiterOutage({ routeClass, kind, mode, reason, outcome, errorClass, environment });
  try {
    console.error(
      JSON.stringify({
        event: "ratelimit_outage_fallback",
        routeClass,
        kind,
        mode,
        reason,
        outcome,
        ...(errorClass === undefined ? {} : { errorClass }),
        environment,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch {
    console.error("ratelimit_outage_fallback", routeClass);
  }
}

// ---------------------------------------------------------------------------
// Keying (P1), the over-limit memory (D-4) and studio resolution (D-3).
// ---------------------------------------------------------------------------
export function hmacSecret(env: Record<string, string | undefined> = process.env): string | null {
  const v = env[HMAC_SECRET_ENV];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= HMAC_SECRET_MIN_LENGTH && new Set(t).size >= HMAC_SECRET_MIN_DISTINCT ? v : null;
}
/** HMAC-SHA-256 of "scope\nkey" under the secret, hex. Scope-bound so one key never collides across routes. */
export function counterKey(secret: string, scope: string, key: string): string {
  return createHmac("sha256", secret).update(`${scope}\n${key}`).digest("hex");
}

let secretMissingLogged = false;
export function resetOutageStateForTests(): void {
  secretMissingLogged = false;
  overLimit.clear();
  studioIds.clear();
  lastAlertAt.clear();
}
function logSecretMissingOnce(): void {
  if (secretMissingLogged) return;
  secretMissingLogged = true;
  try {
    console.error(JSON.stringify({ event: "ratelimit_hmac_secret_missing", envVar: HMAC_SECRET_ENV, effect: "fallback classes refuse", timestamp: new Date().toISOString() }));
  } catch {
    /* never throws */
  }
}

const overLimit = new Map<string, number>();
const overKey = (h: Hit) => `${h.scope}\n${h.key}`;
function cachedOver(hits: Hit[], now: number): boolean {
  return hits.some((h) => (overLimit.get(overKey(h)) ?? 0) > now);
}
function rememberOver(h: Hit, retryAfterSeconds: number, now: number): void {
  if (overLimit.size > 5000) overLimit.clear(); // bounded memory
  overLimit.set(overKey(h), now + Math.min(retryAfterSeconds, OVER_LIMIT_CACHE_MAX_SECONDS) * 1000);
}

/** Hone's slug rule (lib/studios/new-studio.ts, booking settings): lowercase alphanumerics and hyphens, 1-64, no leading/trailing hyphen. */
const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const isSlugShape = (slug: unknown): slug is string => typeof slug === "string" && slug.length <= 64 && SLUG_SHAPE.test(slug);

const studioIds = new Map<string, { id: string | null; until: number }>();
/** The studio id for a public slug, or null when no such studio. Throws when the lookup itself fails (the caller then refuses). */
async function resolveStudioId(slug: string): Promise<string | null> {
  const now = Date.now();
  const hit = studioIds.get(slug);
  if (hit && hit.until > now) return hit.id;
  const { data, error } = await createAdminClient().from("studios").select("id").eq("slug", slug).maybeSingle();
  if (error) throw new Error("studio lookup error");
  const id = (data as { id?: string } | null)?.id ?? null;
  if (studioIds.size > 2000) studioIds.clear();
  studioIds.set(slug, { id, until: now + STUDIO_ID_CACHE_SECONDS * 1000 });
  return id;
}

// ---------------------------------------------------------------------------
// The shared counter.
// ---------------------------------------------------------------------------
export type Hit = { scope: string; key: string; windowSeconds: number; limit: number };
type HitResult = { allowed: boolean; retryAfterSeconds: number };

async function hitCounter(hit: Hit, secret: string): Promise<HitResult> {
  const call = createAdminClient().rpc("rate_limit_fallback_hit", {
    p_scope: hit.scope,
    p_key_hash: counterKey(secret, hit.scope, hit.key),
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

/**
 * Count every hit (all of them, even when an earlier one is over its limit) and refuse if any is over or any call fails.
 * A key this instance already saw over its limit moments ago is refused WITHOUT a database write (D-4); the shared counter stays
 * authoritative because the memory is short and per key. With VISITOR_FIRST_SKIPS_STUDIO_BUCKET (NQ-6) the first hit is the visitor
 * and a refusal there skips the rest.
 */
export async function decideHits(hits: Hit[], secret: string, visitorFirst: boolean = VISITOR_FIRST_SKIPS_STUDIO_BUCKET): Promise<OutageResult> {
  const now = Date.now();
  if (cachedOver(hits, now)) return { allowed: false, retryAfterSeconds: OVER_LIMIT_CACHE_MAX_SECONDS };
  let results: HitResult[];
  if (visitorFirst) {
    const first = await hitCounter(hits[0], secret);
    results = [first];
    if (first.allowed) for (const h of hits.slice(1)) results.push(await hitCounter(h, secret));
  } else {
    results = await Promise.all(hits.map((h) => hitCounter(h, secret)));
  }
  const refused = results.filter((r) => !r.allowed);
  hits.forEach((h, i) => {
    if (results[i] && !results[i].allowed) rememberOver(h, results[i].retryAfterSeconds, now);
  });
  if (refused.length === 0) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.max(...refused.map((r) => r.retryAfterSeconds)) };
}

export type OutageKeys = {
  /** hashed visitor identifier (IP), already scoped by the caller where the route is studio-scoped */
  visitor?: string;
  /** studio id (already resolved by the caller): a PUBLIC identifier, hashed anyway by the caller */
  studio?: string;
  /** public studio SLUG to resolve here to the studio id (D-3). The bucket key is the id, never the slug. */
  studioSlug?: string;
  /** hashed email */
  email?: string;
  /** namespace for the counter scopes, so unrelated routes never share a bucket */
  scope: string;
};

function hitsFor(kind: OutageKind, k: OutageKeys, unknownStudio = false): Hit[] | null {
  const min = 60;
  if (kind === "book") {
    if (!k.visitor) return null;
    if (unknownStudio) return [{ scope: `${k.scope}_visitor`, key: k.visitor, windowSeconds: fallbackParam("HONE_LIMITER_FALLBACK_BOOK_VISITOR_WINDOW_MIN") * min, limit: fallbackParam("HONE_LIMITER_FALLBACK_BOOK_VISITOR_MAX") }];
    if (!k.studio) return null;
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

/** F-1 (Insurance): the visitor-only bucket counted BEFORE the studio lookup (hashed IP, no slug, no studio), so a slug-sprayer is capped at
 *  the visitor bound before any studio database read. Same window and limit as the kind's visitor bucket; its own scope, so it never shares a key. */
function preLookupHit(kind: OutageKind, k: OutageKeys): Hit | null {
  if (!k.visitor) return null;
  const min = 60;
  if (kind === "book") return { scope: `${k.scope}_visitor_any`, key: k.visitor, windowSeconds: fallbackParam("HONE_LIMITER_FALLBACK_BOOK_VISITOR_WINDOW_MIN") * min, limit: fallbackParam("HONE_LIMITER_FALLBACK_BOOK_VISITOR_MAX") };
  if (kind === "slots") return { scope: `${k.scope}_visitor_any`, key: k.visitor, windowSeconds: fallbackParam("HONE_LIMITER_FALLBACK_SLOTS_VISITOR_WINDOW_MIN") * min, limit: fallbackParam("HONE_LIMITER_FALLBACK_SLOTS_VISITOR_MAX") };
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
    emitOutageEvent(args.routeClass, args.kind, mode, args.reason, "refused", classOf(args.err));
    return { allowed: false, retryAfterSeconds: REFUSE_RETRY_SECONDS };
  }

  // E-1 (Insurance): a malformed slug is a cheap refusal BEFORE anything else: no studio lookup, no counter write, no operator
  // alert, no studio bucket. It cannot be a real studio, so it is neither an outage signal nor worth a database call.
  if (args.keys?.studioSlug !== undefined && !isSlugShape(args.keys.studioSlug)) {
    return { allowed: false, retryAfterSeconds: REFUSE_RETRY_SECONDS };
  }

  const secret = hmacSecret();
  if (!secret) {
    logSecretMissingOnce();
    emitOutageEvent(args.routeClass, args.kind, mode, args.reason, "refused_no_secret", classOf(args.err));
    return { allowed: false, retryAfterSeconds: REFUSE_RETRY_SECONDS };
  }

  let keys = args.keys;
  let unknownStudio = false;
  if (keys?.studioSlug !== undefined) {
    // F-1: count the visitor-only bucket before the studio lookup; over its bound the request is refused with no studio read.
    const pre = preLookupHit(args.kind, keys);
    if (pre) {
      try {
        const early = await decideHits([pre], secret);
        if (!early.allowed) {
          emitOutageEvent(args.routeClass, args.kind, mode, args.reason, "fallback_limited", classOf(args.err));
          return early;
        }
      } catch (counterErr) {
        emitOutageEvent(args.routeClass, args.kind, mode, args.reason, "refused_counter_unreachable", classOf(counterErr));
        return { allowed: false, retryAfterSeconds: REFUSE_RETRY_SECONDS };
      }
    }
    // D-3: resolve the slug FIRST. An unknown slug is refused and never gets a studio bucket (only the visitor bucket, keyed with
    // 'unknown', is counted so slug-spraying is still bounded). The visitor key is hashed IP + resolved id (or 'unknown').
    try {
      const id = await resolveStudioId(keys.studioSlug);
      unknownStudio = id === null;
      keys = { ...keys, visitor: keys.visitor ? `${keys.visitor}:${id ?? "unknown"}` : keys.visitor, studio: id ?? undefined };
    } catch (lookupErr) {
      emitOutageEvent(args.routeClass, args.kind, mode, args.reason, "refused_counter_unreachable", classOf(lookupErr));
      return { allowed: false, retryAfterSeconds: REFUSE_RETRY_SECONDS };
    }
  }
  const hits = keys ? hitsFor(args.kind, keys, unknownStudio) : null;
  if (!hits) {
    // A fallback class without the keys it needs cannot be bounded: refuse.
    emitOutageEvent(args.routeClass, args.kind, mode, args.reason, "refused_no_keys", classOf(args.err));
    return { allowed: false, retryAfterSeconds: REFUSE_RETRY_SECONDS };
  }
  try {
    const decision = await decideHits(hits, secret);
    if (unknownStudio) {
      emitOutageEvent(args.routeClass, args.kind, mode, args.reason, "refused_unknown_studio", classOf(args.err));
      return { allowed: false, retryAfterSeconds: decision.allowed ? REFUSE_RETRY_SECONDS : decision.retryAfterSeconds };
    }
    emitOutageEvent(args.routeClass, args.kind, mode, args.reason, decision.allowed ? "fallback_active" : "fallback_limited", classOf(args.err));
    return decision;
  } catch (counterErr) {
    emitOutageEvent(args.routeClass, args.kind, mode, args.reason, "refused_counter_unreachable", classOf(counterErr));
    return { allowed: false, retryAfterSeconds: REFUSE_RETRY_SECONDS };
  }
}
