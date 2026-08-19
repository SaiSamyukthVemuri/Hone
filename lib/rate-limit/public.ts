import { createHash } from "crypto";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Rate limiter for unauthenticated public surfaces. Covers:
//   * public booking: fetchPublicSlotsAction + publicBookAppointmentAction
//     (heaviest read; appointment/client/audit writes + emails)
//   * public token routes: cancel / reschedule / intake server actions
//     (see limitTokenRoute below)
//
// Design contract:
//   * FAIL OPEN. If Upstash is not configured (env vars missing) or the
//     backend errors, requests are ALLOWED. A limiter outage must never
//     block a real booking, cancel, reschedule, or intake. The limiter is a
//     cost/abuse dampener, not an authorization control.
//   * Identifiers (IP, email, token) are SHA-256 hashed before they touch a
//     Redis key or a log line. Raw IPs/emails/tokens/secrets are never
//     stored or logged. The studio slug is public and used in the clear.
//   * No effect when env vars are absent: getRedis() returns null and every
//     limiter call returns { allowed: true }.
//
// Deferred (NOT handled here): intake page-load (RSC) view limiting (no
// server action to wrap; needs page/middleware), cron routes, and the
// Stripe webhook. See the audits.

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

// Generic, calm message. Identical wording for both surfaces so a 429 never
// becomes an information oracle. Never includes counts, windows, or keys.
export const RATE_LIMIT_MESSAGE =
  "Too many requests right now. Please wait a moment and try again.";

// SHA-256 hex (truncated) so identifiers are never stored/logged in the clear.
function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

// Resolve the client IP from the platform-set headers. On Vercel,
// `x-real-ip` is set by the proxy to the true client IP, so we prefer it
// and only fall back to the first hop of `x-forwarded-for`. We never trust
// an arbitrary client-supplied header beyond these, and degrade to a single
// shared "unknown_ip" bucket if neither is present.
export function clientIpFromHeaders(h: Headers): string {
  const real = h.get("x-real-ip");
  if (real && real.trim()) return real.trim();
  const fwd = h.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown_ip";
}

// Environment label for log payloads (no identifiers). VERCEL_ENV is
// "production" | "preview" | "development" on Vercel; falls back to NODE_ENV
// locally.
function currentEnvironment(): string {
  return process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown";
}
function isProduction(): boolean {
  return process.env.VERCEL_ENV === "production";
}

// Once-per-cold-start guard (module-level) for the "limiter disabled because
// Upstash env is missing" signal. A disabled limiter silently fails open, so
// we surface it exactly once per warm instance rather than once per request.
// Alarm-level (console.error) only in production, where a missing limiter is
// a real exposure; quieter (console.warn) in preview/local where it's
// expected but still inspectable.
let loggedEnvMissing = false;
function logEnvMissingOnce(): void {
  if (loggedEnvMissing) return;
  loggedEnvMissing = true;
  const payload = JSON.stringify({
    event: "ratelimit_disabled_env_missing",
    environment: currentEnvironment(),
    timestamp: new Date().toISOString(),
  });
  if (isProduction()) console.error(payload);
  else console.warn(payload);
}

// Lazily-built Redis client. `undefined` = not yet resolved; `null` =
// resolved-but-unconfigured (env missing). Cached so we don't rebuild per
// request. The first null resolution logs the env-missing signal once.
let cachedRedis: Redis | null | undefined;
function getRedis(): Redis | null {
  if (cachedRedis !== undefined) return cachedRedis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  cachedRedis = url && token ? new Redis({ url, token }) : null;
  if (cachedRedis === null) logEnvMissingOnce();
  return cachedRedis;
}

// One sliding-window limiter per (route class, window). Cached singletons.
let cachedSlots: Ratelimit | null | undefined;
let cachedBookIp: Ratelimit | null | undefined;
let cachedBookEmail: Ratelimit | null | undefined;

function slotsLimiter(): Ratelimit | null {
  if (cachedSlots !== undefined) return cachedSlots;
  const redis = getRedis();
  cachedSlots = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(60, "60 s"),
        prefix: "rl:public_slots",
        analytics: false,
      })
    : null;
  return cachedSlots;
}

function bookIpLimiter(): Ratelimit | null {
  if (cachedBookIp !== undefined) return cachedBookIp;
  const redis = getRedis();
  cachedBookIp = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(5, "10 m"),
        prefix: "rl:public_book_ip",
        analytics: false,
      })
    : null;
  return cachedBookIp;
}

function bookEmailLimiter(): Ratelimit | null {
  if (cachedBookEmail !== undefined) return cachedBookEmail;
  const redis = getRedis();
  cachedBookEmail = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(3, "1 h"),
        prefix: "rl:public_book_email",
        analytics: false,
      })
    : null;
  return cachedBookEmail;
}

function retryAfterSeconds(resetUnixMs: number): number {
  return Math.max(1, Math.ceil((resetUnixMs - Date.now()) / 1000));
}

// Module-level throttle state (per warm instance): last log time per route
// class for the backend-unavailable alarm. During an Upstash outage every
// request hits the catch path; without throttling that is one log line per
// request. We emit at most once per BACKEND_LOG_THROTTLE_MS per route class.
// Throttling is best-effort per warm instance, not globally across instances.
const BACKEND_LOG_THROTTLE_MS = 60_000;
const lastBackendLogAt = new Map<string, number>();

// Structured fail-open alarm. Records only the route class, environment, and
// the error class/message (network-level), never the IP, email, token, key,
// hash, or secret. Throttled per route class. Caller always proceeds
// (allowed) after this fires.
function logBackendUnavailable(routeClass: string, err: unknown): void {
  const now = Date.now();
  const last = lastBackendLogAt.get(routeClass) ?? 0;
  if (now - last < BACKEND_LOG_THROTTLE_MS) return; // throttled (warm instance)
  lastBackendLogAt.set(routeClass, now);
  try {
    console.error(
      JSON.stringify({
        event: "ratelimit_backend_unavailable",
        routeClass,
        environment: currentEnvironment(),
        error: err instanceof Error ? err.message : "unknown",
        timestamp: new Date().toISOString(),
      }),
    );
  } catch {
    console.error("ratelimit_backend_unavailable", routeClass);
  }
}

// Structured metric/search log (NOT an alarm): the limiter is working and
// blocked a request. Only non-identifying fields: route class, optional
// limit dimension, retry-after, environment. Never logs the IP/email/token,
// the hash, a hash prefix, or the Redis key.
function logRateLimitExceeded(
  routeClass: string,
  retry: number,
  limitType?: string,
): void {
  console.warn(
    JSON.stringify({
      event: "ratelimit_exceeded",
      routeClass,
      ...(limitType ? { limitType } : {}),
      retryAfterSeconds: retry,
      environment: currentEnvironment(),
      timestamp: new Date().toISOString(),
    }),
  );
}

// Public slot fetch: 60 req / 60 s per (IP, slug). Generous: normal
// date-switching is bursty and must not be throttled.
export async function limitPublicSlots(args: {
  headers: Headers;
  slug: string;
}): Promise<RateLimitResult> {
  const limiter = slotsLimiter();
  if (!limiter) return { allowed: true }; // disabled when env unset
  const ip = clientIpFromHeaders(args.headers);
  try {
    const { success, reset } = await limiter.limit(`${hashId(ip)}:${args.slug}`);
    if (success) return { allowed: true };
    const retry = retryAfterSeconds(reset);
    logRateLimitExceeded("public_slots", retry);
    return { allowed: false, retryAfterSeconds: retry };
  } catch (err) {
    logBackendUnavailable("public_slots", err);
    return { allowed: true }; // fail open
  }
}

// Public booking submit: stricter, two independent windows.
//   * 5 / 10 min per (IP, slug)
//   * 3 / hour  per (email, slug), only when an email is present
// IP is checked first; if it's already over the limit we return without
// consuming the email budget. Both keys are hashed.
export async function limitPublicBooking(args: {
  headers: Headers;
  slug: string;
  email: string | null;
}): Promise<RateLimitResult> {
  const ipLimiter = bookIpLimiter();
  const emailLimiter = bookEmailLimiter();
  if (!ipLimiter || !emailLimiter) return { allowed: true }; // disabled
  const ip = clientIpFromHeaders(args.headers);
  try {
    const ipRes = await ipLimiter.limit(`${hashId(ip)}:${args.slug}`);
    if (!ipRes.success) {
      const retry = retryAfterSeconds(ipRes.reset);
      logRateLimitExceeded("public_book", retry, "ip");
      return { allowed: false, retryAfterSeconds: retry };
    }
    if (args.email) {
      const emailRes = await emailLimiter.limit(
        `${hashId(args.email)}:${args.slug}`,
      );
      if (!emailRes.success) {
        const retry = retryAfterSeconds(emailRes.reset);
        logRateLimitExceeded("public_book", retry, "email");
        return { allowed: false, retryAfterSeconds: retry };
      }
    }
    return { allowed: true };
  } catch (err) {
    logBackendUnavailable("public_book", err);
    return { allowed: true }; // fail open
  }
}

// ---------------------------------------------------------------------------
// Public token routes (cancel / reschedule / intake).
//
// Each token-route action is keyed on hash(token):hash(IP) so abuse is
// bounded per link + source without ever storing the raw token or IP. The
// limiter runs BEFORE token verification, so a 429 is returned independent
// of whether the token is valid. It never reveals token/appointment state.
// View limits are looser than mutation limits. intake page-load (RSC) view
// limiting is deferred (no action to wrap).
// ---------------------------------------------------------------------------
const TOKEN_LIMITS = {
  cancel_view: { limit: 20, window: "5 m" },
  cancel_submit: { limit: 5, window: "5 m" },
  reschedule_view: { limit: 20, window: "5 m" },
  reschedule_slots: { limit: 60, window: "60 s" },
  reschedule_submit: { limit: 5, window: "5 m" },
  intake_save: { limit: 30, window: "5 m" },
  intake_submit: { limit: 5, window: "5 m" },
} as const;

export type TokenRouteClass = keyof typeof TOKEN_LIMITS;

// Lazily-built, cached limiter per route class. null = Upstash unconfigured.
const tokenLimiterCache = new Map<TokenRouteClass, Ratelimit | null>();
function tokenLimiter(routeClass: TokenRouteClass): Ratelimit | null {
  const cached = tokenLimiterCache.get(routeClass);
  if (cached !== undefined) return cached;
  const redis = getRedis();
  const cfg = TOKEN_LIMITS[routeClass];
  const limiter = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(cfg.limit, cfg.window),
        prefix: `rl:${routeClass}`,
        analytics: false,
      })
    : null;
  tokenLimiterCache.set(routeClass, limiter);
  return limiter;
}

// Rate-limit one public token-route action. Key = hash(token):hash(IP).
// Fails open when Upstash is unconfigured or errors. Token semantics are
// untouched. This only decides whether the action runs at all.
export async function limitTokenRoute(args: {
  routeClass: TokenRouteClass;
  token: string;
  headers: Headers;
}): Promise<RateLimitResult> {
  const limiter = tokenLimiter(args.routeClass);
  if (!limiter) return { allowed: true }; // disabled when env unset
  const ip = clientIpFromHeaders(args.headers);
  try {
    const { success, reset } = await limiter.limit(
      `${hashId(args.token)}:${hashId(ip)}`,
    );
    if (success) return { allowed: true };
    const retry = retryAfterSeconds(reset);
    logRateLimitExceeded(args.routeClass, retry);
    return { allowed: false, retryAfterSeconds: retry };
  } catch (err) {
    logBackendUnavailable(args.routeClass, err);
    return { allowed: true }; // fail open
  }
}

// ---------------------------------------------------------------------------
// Client portal magic-link request.
//
// Two independent windows, mirroring the public booking shape so abuse
// is bounded per network source AND per recipient address. IP is
// checked first; if it's already over the limit we return without
// consuming the email budget. Both keys are hashed before storage.
//
//   * 5 / 10 min per IP
//   * 3 / hour  per email (always present on this route)
//
// Fails open when Upstash is unconfigured or down, same posture as
// the rest of this file.
// ---------------------------------------------------------------------------

let cachedPortalIp: Ratelimit | null | undefined;
let cachedPortalEmail: Ratelimit | null | undefined;

function portalIpLimiter(): Ratelimit | null {
  if (cachedPortalIp !== undefined) return cachedPortalIp;
  const redis = getRedis();
  cachedPortalIp = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(5, "10 m"),
        prefix: "rl:portal_login_ip",
        analytics: false,
      })
    : null;
  return cachedPortalIp;
}

function portalEmailLimiter(): Ratelimit | null {
  if (cachedPortalEmail !== undefined) return cachedPortalEmail;
  const redis = getRedis();
  cachedPortalEmail = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(3, "1 h"),
        prefix: "rl:portal_login_email",
        analytics: false,
      })
    : null;
  return cachedPortalEmail;
}

// ---------------------------------------------------------------------------
// Public marketing forms (waitlist + demo request), PR #187.
//
// Both are anonymous landing-page entry points that insert directly into
// their own tables (waitlist / demo_requests); without a limiter they can
// be scripted to fill the database or generate ops noise. Same two-window
// shape as booking/portal-login, with windows tuned for one-shot marketing
// forms (a legitimate visitor submits each form roughly once ever, so the
// per-email budget is much tighter than booking's):
//
//   * 5 / 1 hour per IP
//   * 2 / 1 day  per email (callers pass the already-normalized email)
//
// IP is checked first; if it's over the limit the email budget is not
// consumed. Both keys are hashed. Prefixes are namespaced per form so
// waitlist/demo never collide with each other or with booking/portal
// buckets. Fails OPEN per this file's design contract: the limiter is a
// cost/abuse dampener, not an authorization control, and a limiter outage
// must not block a real lead.
// ---------------------------------------------------------------------------

const MARKETING_FORM_LIMITS = {
  ip: { limit: 5, window: "1 h" },
  email: { limit: 2, window: "1 d" },
} as const;

type MarketingForm = "waitlist" | "demo";

const marketingLimiterCache = new Map<string, Ratelimit | null>();
function marketingLimiter(
  form: MarketingForm,
  dimension: "ip" | "email",
): Ratelimit | null {
  const cacheKey = `${form}:${dimension}`;
  const cached = marketingLimiterCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const redis = getRedis();
  const cfg = MARKETING_FORM_LIMITS[dimension];
  const limiter = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(cfg.limit, cfg.window),
        prefix: `rl:${form}_${dimension}`,
        analytics: false,
      })
    : null;
  marketingLimiterCache.set(cacheKey, limiter);
  return limiter;
}

async function limitMarketingForm(
  form: MarketingForm,
  args: { headers: Headers; email: string },
): Promise<RateLimitResult> {
  const ipLimiter = marketingLimiter(form, "ip");
  const emailLimiter = marketingLimiter(form, "email");
  if (!ipLimiter || !emailLimiter) return { allowed: true }; // disabled
  const ip = clientIpFromHeaders(args.headers);
  try {
    const ipRes = await ipLimiter.limit(hashId(ip));
    if (!ipRes.success) {
      const retry = retryAfterSeconds(ipRes.reset);
      logRateLimitExceeded(form, retry, "ip");
      return { allowed: false, retryAfterSeconds: retry };
    }
    const emailRes = await emailLimiter.limit(hashId(args.email));
    if (!emailRes.success) {
      const retry = retryAfterSeconds(emailRes.reset);
      logRateLimitExceeded(form, retry, "email");
      return { allowed: false, retryAfterSeconds: retry };
    }
    return { allowed: true };
  } catch (err) {
    logBackendUnavailable(form, err);
    return { allowed: true }; // fail open
  }
}

export async function limitWaitlistSubmit(args: {
  headers: Headers;
  email: string;
}): Promise<RateLimitResult> {
  return limitMarketingForm("waitlist", args);
}

// ===========================================================================
// P0 NEW-CLIENT BOOKING WAITLIST — DEDICATED, STUDIO-SCOPED BUCKET
// ===========================================================================
//
// This is NOT limitWaitlistSubmit. That limiter serves the Hone MARKETING
// landing-page waitlist and keys on the hashed IP / hashed email ALONE, with no
// studio or surface component. Sharing it would mean:
//
//   * a visitor who used the landing-page early-access form twice is refused on
//     a studio's booking waitlist for a day, and
//   * two waitlisted studios silently consume each other's budgets.
//
// Both silently DROP a real new-client lead, which is precisely the demand this
// release exists to capture. So the booking waitlist gets its own Redis
// prefixes and its own key space, scoped by the SERVER-RESOLVED studio id.
//
// FAIL-OPEN, DELIBERATELY CLASSIFIED (not inherited by habit). A limiter outage
// here means either (a) fail closed and drop genuine leads during the exact
// window the studio is trying to capture them, or (b) fail open and risk extra
// operational emails in the studio inbox. (a) destroys the release's purpose
// and is unrecoverable — the lead is simply gone. (b) is noisy, visible and
// recoverable: the operator can clear the feature flag. Fail open, matching
// every other public limiter in this file.
//
// Raw IP and raw email never enter a Redis key or a log line: both are hashed
// first. The studio id is an internal UUID, not personal data.
const NEW_CLIENT_WAITLIST_LIMITS = {
  ip: { limit: 5, window: "1 h" },
  email: { limit: 3, window: "1 d" },
} as const;

const newClientWaitlistLimiterCache = new Map<string, Ratelimit | null>();
function newClientWaitlistLimiter(dimension: "ip" | "email"): Ratelimit | null {
  const cached = newClientWaitlistLimiterCache.get(dimension);
  if (cached !== undefined) return cached;
  const redis = getRedis();
  const cfg = NEW_CLIENT_WAITLIST_LIMITS[dimension];
  const limiter = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(cfg.limit, cfg.window),
        // Own namespace. Cannot collide with rl:waitlist_* (marketing).
        prefix: `rl:new_client_waitlist_${dimension}`,
        analytics: false,
      })
    : null;
  newClientWaitlistLimiterCache.set(dimension, limiter);
  return limiter;
}

/**
 * Rate limit a public new-client booking waitlist submission.
 *
 * `studioId` MUST be the server-resolved studios row id, never a
 * browser-supplied value, or the scoping is meaningless.
 */
export async function limitNewClientBookingWaitlist(args: {
  headers: Headers;
  studioId: string;
  email: string;
}): Promise<RateLimitResult> {
  const ipLimiter = newClientWaitlistLimiter("ip");
  const emailLimiter = newClientWaitlistLimiter("email");
  if (!ipLimiter || !emailLimiter) return { allowed: true }; // disabled
  const ip = clientIpFromHeaders(args.headers);
  try {
    // Identifier hashed FIRST, then scoped by studio, so one studio's traffic
    // can never consume another's budget.
    const ipRes = await ipLimiter.limit(`${hashId(ip)}:${args.studioId}`);
    if (!ipRes.success) {
      const retry = retryAfterSeconds(ipRes.reset);
      logRateLimitExceeded("new_client_waitlist", retry, "ip");
      return { allowed: false, retryAfterSeconds: retry };
    }
    const emailRes = await emailLimiter.limit(`${hashId(args.email)}:${args.studioId}`);
    if (!emailRes.success) {
      const retry = retryAfterSeconds(emailRes.reset);
      logRateLimitExceeded("new_client_waitlist", retry, "email");
      return { allowed: false, retryAfterSeconds: retry };
    }
    return { allowed: true };
  } catch (err) {
    logBackendUnavailable("new_client_waitlist", err);
    return { allowed: true }; // fail open — see the classification above
  }
}

export async function limitDemoRequestSubmit(args: {
  headers: Headers;
  email: string;
}): Promise<RateLimitResult> {
  return limitMarketingForm("demo", args);
}

export async function limitPortalMagicLink(args: {
  headers: Headers;
  email: string;
}): Promise<RateLimitResult> {
  const ipLimiter = portalIpLimiter();
  const emailLimiter = portalEmailLimiter();
  if (!ipLimiter || !emailLimiter) return { allowed: true }; // disabled
  const ip = clientIpFromHeaders(args.headers);
  try {
    const ipRes = await ipLimiter.limit(hashId(ip));
    if (!ipRes.success) {
      const retry = retryAfterSeconds(ipRes.reset);
      logRateLimitExceeded("portal_login", retry, "ip");
      return { allowed: false, retryAfterSeconds: retry };
    }
    const emailRes = await emailLimiter.limit(hashId(args.email));
    if (!emailRes.success) {
      const retry = retryAfterSeconds(emailRes.reset);
      logRateLimitExceeded("portal_login", retry, "email");
      return { allowed: false, retryAfterSeconds: retry };
    }
    return { allowed: true };
  } catch (err) {
    logBackendUnavailable("portal_login", err);
    return { allowed: true }; // fail open
  }
}

// Practitioner-triggered client emails (portal link, intake resend, portal
// message). Keyed per (action, practitioner, client) so one practitioner cannot
// spam one client on any one channel. 3 per hour per bucket. Fail-open like the
// other limiters (a limiter outage must never block a legitimate send).
let cachedPractitionerClient: Ratelimit | null | undefined;
function practitionerClientLimiter(): Ratelimit | null {
  if (cachedPractitionerClient !== undefined) return cachedPractitionerClient;
  const redis = getRedis();
  cachedPractitionerClient = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(3, "1 h"),
        prefix: "rl:practitioner_client_email",
        analytics: false,
      })
    : null;
  return cachedPractitionerClient;
}

export async function limitPractitionerClientEmail(args: {
  action: string;
  practitionerId: string;
  clientId: string;
}): Promise<RateLimitResult> {
  const limiter = practitionerClientLimiter();
  if (!limiter) return { allowed: true }; // disabled when env unset
  try {
    const { success, reset } = await limiter.limit(
      `${hashId(args.action)}:${hashId(args.practitionerId)}:${hashId(args.clientId)}`,
    );
    if (success) return { allowed: true };
    const retry = retryAfterSeconds(reset);
    logRateLimitExceeded("practitioner_client_email", retry);
    return { allowed: false, retryAfterSeconds: retry };
  } catch (err) {
    logBackendUnavailable("practitioner_client_email", err);
    return { allowed: true }; // fail open
  }
}
