// Deny-by-default event/breadcrumb scrubbing for Sentry.
//
// This app handles clinical treatment records (client identities, treatment
// notes, probe settings, session/reaction history) plus auth material
// (Supabase JWTs / session cookies, Stripe keys). `sendDefaultPii: false`
// already stops Sentry attaching IPs, cookies, headers and request bodies by
// default. This module is the belt-and-suspenders layer on top: every event
// and every breadcrumb is walked before it leaves the process and anything
// matching a sensitive key OR a sensitive value pattern is redacted: from
// `extra`, `contexts`, `tags`, `breadcrumbs`, request data, span data and the
// user object, not just top-level fields.
//
// It is intentionally aggressive. Over-redacting a diagnostic string is the
// safe direction; leaking a client name or a token is not. Pure + isomorphic
// (no server-only imports) so the identical logic runs in the browser, Node
// and edge runtimes.

import type { Breadcrumb, ErrorEvent, Event } from "@sentry/nextjs";
import { canonicalizeTokenPaths } from "@/lib/security/token-routes";

const REDACTED = "[Redacted]";
const MAX_DEPTH = 8;

// Keys whose ENTIRE value is dropped wherever they appear (case-insensitive,
// substring match). Grouped by concern. Deliberately broad on the clinical +
// auth surface.
const SENSITIVE_KEY_RE = new RegExp(
  [
    // Auth / secrets / session identifiers
    "pass(word|wd)?",
    "secret",
    "api[_-]?key",
    "apikey",
    "authoriz",
    "auth[_-]?token",
    "access[_-]?token",
    "refresh[_-]?token",
    "provider[_-]?token",
    "id[_-]?token",
    "\\btoken\\b",
    "session",
    "cookie",
    "csrf",
    "\\bjwt\\b",
    "bearer",
    "^sb[-_]", // Supabase auth cookie prefix: sb-<ref>-auth-token
    "supabase",
    // Direct identifiers
    "e[-_]?mail",
    "phone",
    "mobile",
    "^tel$",
    "telephone",
    "\\bfax\\b",
    "(client|patient|customer|first|last|full|preferred|display|given|family|middle|maiden)[_-]?name",
    "^name$",
    "dob",
    "birth",
    "\\bssn\\b",
    "\\bsin\\b",
    "insurance",
    "address",
    "street",
    "postal",
    "\\bzip\\b",
    // Clinical record fields
    "note", // treatment_note, clinical_note, notes
    "observation",
    "consult",
    "assessment",
    "clinical",
    "diagnos",
    "treatment",
    "probe",
    "intensity",
    "modalit", // modality
    "insertion",
    "galvanic",
    "thermolysis",
    "blend",
    "reaction",
    "\\bhistory\\b",
    "skin",
    "\\bhair\\b",
    "lesion",
  ].join("|"),
  "i",
);

// Value patterns redacted wherever a string appears (even in free-text error
// messages and span descriptions, where there is no key to match on).
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const JWT_RE = /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g;
const BEARER_RE = /\bBearer\s+[a-zA-Z0-9._~+/=-]+/gi;
const SUPABASE_TOKEN_RE =
  /\bsb[-_][a-z0-9-]+-auth-token\b|\bsbp_[a-z0-9]+\b|\bservice_role\b/gi;
// Loose phone matcher: a run of 9+ digits with optional +, spaces, (), ., -.
// Bounded so it doesn't swallow adjacent digits of an unrelated token.
const PHONE_RE = /(?<!\d)\+?\d[\d\s().-]{7,}\d(?!\d)/g;

/** Redact sensitive substrings from a free-text string.
 *
 *  F-PRIV-001. Token-route canonicalization runs FIRST, before any value
 *  pattern. Those patterns key off credential SYNTAX (JWT segments, a `Bearer `
 *  prefix, Supabase shapes) and are structurally blind to an opaque credential
 *  sitting in a URL path, /intake/9f3a... looks like an ordinary path segment
 *  to every one of them. Canonicalization keys off the ROUTE instead, so the
 *  credential is removed no matter what it looks like.
 *
 *  Because every recursive string surface (extra, contexts, tags, span data,
 *  breadcrumb messages, exception values) funnels through here, they all
 *  inherit the protection rather than each needing its own call. */
export function redactString(input: string): string {
  return canonicalizeTokenPaths(input)
    .replace(EMAIL_RE, REDACTED)
    .replace(JWT_RE, REDACTED)
    .replace(BEARER_RE, REDACTED)
    .replace(SUPABASE_TOKEN_RE, REDACTED)
    .replace(PHONE_RE, REDACTED);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Standard Sentry context blocks carry non-sensitive structural fields (e.g.
// os.name, browser.name, runtime.name). We value-scrub these (to catch a token
// that slipped into a value) but do NOT key-redact them, so we keep useful
// diagnostics. Custom/app-authored contexts get the full strict scrub. The one
// exception is device.name, which on some platforms is the owner's name.
const STANDARD_CONTEXT_KEYS = new Set([
  "trace",
  "runtime",
  "os",
  "device",
  "browser",
  "app",
  "culture",
  "cloud_resource",
  "gpu",
  "state",
  "profile",
  "response",
  "monitor",
]);

type ScrubOpts = { redactKeys: boolean };

function deepScrub(
  value: unknown,
  opts: ScrubOpts,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return REDACTED;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => deepScrub(v, opts, seen, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (opts.redactKeys && SENSITIVE_KEY_RE.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = deepScrub(v, opts, seen, depth + 1);
    }
  }
  return out;
}

function scrubContexts(
  contexts: Record<string, unknown>,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, ctx] of Object.entries(contexts)) {
    if (STANDARD_CONTEXT_KEYS.has(key)) {
      const scrubbed = deepScrub(ctx, { redactKeys: false }, seen, 0);
      if (key === "device" && isRecord(scrubbed) && "name" in scrubbed) {
        delete scrubbed.name; // device.name can be the owner's name
      }
      out[key] = scrubbed;
    } else {
      out[key] = deepScrub(ctx, { redactKeys: true }, seen, 0);
    }
  }
  return out;
}

/** Sanitize a field KNOWN to be a URL. Order matters and is deliberate:
 *
 *   1. canonicalize token-route credentials: this also consumes the query and
 *      fragment of a token URL, so a credential cannot escape by hiding behind
 *      an encoded `?` or a malformed separator that step 2 fails to split on;
 *   2. drop the query string and fragment (identifiers leak through both);
 *   3. run the ordinary value redactions.
 *
 *  Doing (2) before (1) would be unsafe: a URL whose separator we mis-parse
 *  would keep its raw path credential. Doing (1) first means the credential is
 *  already gone regardless of how the rest of the string is shaped. */
function sanitizeUrlString(url: string): string {
  const canonical = canonicalizeTokenPaths(url);
  return redactString(canonical.split("?")[0].split("#")[0]);
}

function scrubRequest(request: Record<string, unknown>): void {
  // With sendDefaultPii:false these are usually absent; drop them anyway.
  delete request.cookies;
  delete request.headers; // may carry Authorization / Cookie / forwarded IPs
  delete request.query_string; // may carry filter values, emails, tokens
  if (typeof request.url === "string") {
    request.url = sanitizeUrlString(request.url);
  }
  if (request.data !== undefined) {
    request.data = deepScrub(
      request.data,
      { redactKeys: true },
      new WeakSet(),
      0,
    );
  }
}

/** Scrub (or drop) a single breadcrumb. Shared by beforeBreadcrumb and the
 *  in-event breadcrumb pass so both paths behave identically. */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  // Console breadcrumbs are the single largest PII-leak surface (a stray
  // console.log of a client record). Drop them entirely; Sentry Logs are also
  // off, so console output never leaves the app.
  if (breadcrumb.category === "console") return null;

  if (typeof breadcrumb.message === "string") {
    breadcrumb.message = redactString(breadcrumb.message);
  }

  const data = breadcrumb.data;
  if (isRecord(data)) {
    // Network breadcrumbs (fetch/xhr) record the URL; strip its query string
    // (Supabase/Stripe filters can embed identifiers) before scrubbing.
    if (
      (breadcrumb.category === "fetch" || breadcrumb.category === "xhr") &&
      typeof data.url === "string"
    ) {
      data.url = sanitizeUrlString(data.url);
    }
    breadcrumb.data = deepScrub(
      data,
      { redactKeys: true },
      new WeakSet(),
      0,
    ) as Breadcrumb["data"];
  }

  return breadcrumb;
}

// Shared across error + transaction events (both extend Event).
function scrubEventCommon<T extends Event>(event: T): T {
  const seen = new WeakSet<object>();

  if (typeof event.message === "string") {
    event.message = redactString(event.message);
  }

  // F-PRIV-001. The transaction NAME was previously never scrubbed at all: it
  // is the event's grouping key and reads as structural metadata, but on a
  // dynamic route it is built from the resolved path, so it carried the raw
  // credential ("GET /intake/<token>"). It is a plain string, not a URL field,
  // so it goes through redactString: token routes are canonicalized to
  // "GET /intake/[Redacted]", keeping the route family for grouping while the
  // credential is gone. Applied in the COMMON path so error and transaction
  // events are covered by one contract.
  if (typeof event.transaction === "string") {
    event.transaction = redactString(event.transaction);
  }

  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === "string") ex.value = redactString(ex.value);
    }
  }

  if (isRecord(event.request)) scrubRequest(event.request);

  if (isRecord(event.user)) {
    delete event.user.email;
    delete event.user.username;
    delete event.user.ip_address;
    event.user = deepScrub(
      event.user,
      { redactKeys: true },
      seen,
      0,
    ) as T["user"];
  }

  if (event.extra) {
    event.extra = deepScrub(
      event.extra,
      { redactKeys: true },
      seen,
      0,
    ) as T["extra"];
  }

  if (event.tags) {
    event.tags = deepScrub(
      event.tags,
      { redactKeys: true },
      seen,
      0,
    ) as T["tags"];
  }

  if (isRecord(event.contexts)) {
    event.contexts = scrubContexts(event.contexts, seen) as T["contexts"];
  }

  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs
      .map((b) => scrubBreadcrumb(b))
      .filter((b): b is Breadcrumb => b !== null);
  }

  return event;
}

/** beforeSend: scrub an error event in place. */
export function scrubErrorEvent(event: ErrorEvent): ErrorEvent {
  return scrubEventCommon(event);
}

/** beforeSendTransaction: scrub a performance/tracing event, including the
 *  descriptions and data of every span (DB/HTTP spans can carry query args).
 *  Generic over Event because @sentry/nextjs does not re-export the
 *  TransactionEvent type; the beforeSendTransaction slot instantiates T. */
export function scrubTransactionEvent<T extends Event>(event: T): T {
  scrubEventCommon(event);

  if (Array.isArray(event.spans)) {
    for (const span of event.spans) {
      const s = span as unknown as Record<string, unknown>;
      if (typeof s.description === "string") {
        s.description = redactString(s.description);
      }
      if (isRecord(s.data)) {
        s.data = deepScrub(s.data, { redactKeys: true }, new WeakSet(), 0);
      }
    }
  }

  return event;
}

/** Production traces at 0.1 (10%); development at 1.0 for full local
 *  visibility. Note: error events are NOT sampled by this rate, only
 *  performance transactions, so error capture is unaffected in production. */
export function tracesSampleRate(): number {
  return process.env.NODE_ENV === "production" ? 0.1 : 1;
}
