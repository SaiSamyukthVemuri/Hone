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
    "(client|patient|customer|first|last|full|preferred|display|given|family|middle|maiden|legal)[_-]?name",
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
// #828 G-25 / G-26: a record identifier. Hone's clients, sessions,
// appointments, intake forms and studios are all addressed by UUID, and a
// UUID beside appointment or clinical context is a linkable record id, so it
// never leaves for Sentry. Matches the dashed 8-4-4-4-12 form only: Sentry's
// own trace_id, span_id and event_id are dashless hex and stay intact for
// correlation. "[id]" mirrors Next's route-template syntax, so
// "/clients/<uuid>" becomes "/clients/[id]" and events still group by route.
// NO boundary at all. \b (Codex P2 4301012678) let a UUID inside a compound
// identifier ("hone_booking_<uuid>") slip through, and a "not a hex digit"
// boundary (Codex P1 4301586679, on #903) still let one glued to hex letters
// ("abc<uuid>") through. The dashes make it a UUID, so dashless hex (Sentry's
// own ids, hashes) is never matched.
// Encodings (%2D, Codex P2 4301149388; %3x hex digits, P2 4301707490) are
// handled by decoding, below, not by the regex.
const RECORD_ID_PLACEHOLDER = "[id]";
// THE GUARANTEE for encodings: no string or key, after ASCII percent-decoding
// to a fixed point, contains a UUID.
//
// The regex is the plain dashed 8-4-4-4-12 form with no boundary (an id glued
// to letters, "_" or digits is still a full id). Its dashes are what make it a
// UUID, so dashless hex (Sentry trace and span ids, hashes) is never matched.
// Encodings are NOT enumerated in it (%2D, %36, %252D, ... were found one at a
// time in review). Instead, each whitespace-delimited token that contains "%"
// is decoded (ASCII %XX only, so a malformed escape never throws and
// multibyte text is untouched), repeatedly until stable, at most
// MAX_DECODE_ROUNDS times. If the decoded token contains a UUID, the DECODED
// token is written with the ids replaced ("/clients/%36f1…" becomes
// "/clients/[id]", keeping the route shape). A token still changing after the
// bound is replaced with "[Redacted]": fail closed, never sent undecoded.
// Out of scope: non-URL encodings (HTML entities, \u escapes, base64), which
// URL serialization does not produce.
const RECORD_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HAS_RECORD_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MAX_DECODE_ROUNDS = 4;

function decodeAsciiEscapes(text: string): string {
  return text.replace(/%([0-7][0-9a-f])/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function replaceRecordIds(text: string): string {
  if (!text.includes("%")) return text.replace(RECORD_ID_RE, RECORD_ID_PLACEHOLDER);
  return text
    .split(/(\s+)/)
    .map((token) => {
      if (!token.includes("%")) return token.replace(RECORD_ID_RE, RECORD_ID_PLACEHOLDER);
      let decoded = token;
      for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
        const next = decodeAsciiEscapes(decoded);
        if (next === decoded) break;
        decoded = next;
      }
      if (decodeAsciiEscapes(decoded) !== decoded) return REDACTED;
      if (decoded !== token && HAS_RECORD_ID.test(decoded)) {
        return decoded.replace(RECORD_ID_RE, RECORD_ID_PLACEHOLDER);
      }
      return token.replace(RECORD_ID_RE, RECORD_ID_PLACEHOLDER);
    })
    .join("");
}
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
 *  Record ids (#828 G-25) are replaced next, AFTER canonicalization, so a token
 *  route still reads "[Redacted]", while "/clients/<uuid>" in a URL, a
 *  transaction name, an exception message or a span description becomes
 *  "/clients/[id]".
 *
 *  Because every recursive string surface (extra, contexts, tags, span data,
 *  breadcrumb messages, exception values) funnels through here, they all
 *  inherit the protection rather than each needing its own call. */
export function redactString(input: string): string {
  return replaceRecordIds(canonicalizeTokenPaths(input))
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

/** An object KEY can be a record id too, e.g. `{ [clientId]: "failed" }`
 *  (Codex P2 4301012675): replace UUIDs in property names as well as values.
 *  Any key whose name is already taken in the output -- whether it was
 *  scrubbed or arrived literally -- gets a numeric suffix, so no value is
 *  silently dropped, whatever the key order. */
function scrubKey(key: string, taken: Record<string, unknown>): string {
  const base = replaceRecordIds(key);
  // Check EVERY key, changed or not (Codex P2 4301073939): an unchanged
  // literal "[id]" arriving after a scrubbed UUID key must not overwrite it.
  // OWN keys only (Codex P2 4301342389): `in` also sees Object.prototype, so
  // an ordinary "constructor" or "toString" key would be renamed for nothing.
  if (!Object.hasOwn(taken, base)) return base;
  let n = 2;
  while (Object.hasOwn(taken, `${base}#${n}`)) n += 1;
  return `${base}#${n}`;
}

/** Replace record ids ONLY, in every string and key of a structure. Used on
 *  exception and thread payloads, where the full redactString would damage
 *  stack frames (its phone pattern matches digit runs in chunk file names and
 *  would break source-map symbolication). Beyond MAX_DEPTH the remainder is
 *  dropped, never sent unscrubbed. */
function withoutRecordIds(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  maxDepth: number = MAX_DEPTH,
): unknown {
  if (typeof value === "string") return replaceRecordIds(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > maxDepth) return REDACTED;
  if (seen.has(value)) return REDACTED;
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => withoutRecordIds(v, seen, depth + 1, maxDepth));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[scrubKey(k, out)] = withoutRecordIds(v, seen, depth + 1, maxDepth);
  }
  return out;
}

// The whole event is far deeper than any one field (spans -> data, exception
// -> frames -> vars), and Sentry has already normalized it before beforeSend,
// so the final sweep allows more depth than the per-field passes.
const SWEEP_MAX_DEPTH = 24;

/** FINAL backstop over the WHOLE event or breadcrumb, after every field pass.
 *  The field-by-field passes above stay (they also redact emails, phones and
 *  tokens), but #828 G-25 must not depend on listing every field Sentry
 *  serializes: Codex review rounds kept finding one more (logentry.formatted,
 *  exception frames, threads). This sweep replaces a record id wherever it
 *  survives, in any string or key, and touches nothing else. */
function sweepRecordIds<T>(value: T): T {
  // `sdkProcessingMetadata` is the SDK's internal processing state (captured
  // Scope objects, request metadata). It is NOT walked (Codex P2 4301513265):
  // that would copy whole Scope/client graphs on every event and replace live
  // class instances with plain objects. The one part of it that IS
  // transmitted, the dynamic sampling context, is swept below.
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return withoutRecordIds(value, new WeakSet(), 0, SWEEP_MAX_DEPTH) as T;
  }
  const { sdkProcessingMetadata, ...wire } = value as Record<string, unknown>;
  const swept = withoutRecordIds(wire, new WeakSet(), 0, SWEEP_MAX_DEPTH) as Record<string, unknown>;
  if (isRecord(sdkProcessingMetadata)) {
    // EXCEPT the dynamic sampling context (Codex P1 4301561882): the SDK
    // copies it into the transmitted envelope's `trace` header, and its
    // `transaction` is the resolved route ("/clients/<uuid>"). It is plain
    // data, so it is swept; every other entry (captured Scope instances,
    // request metadata) is kept by reference.
    const dsc = sdkProcessingMetadata.dynamicSamplingContext;
    swept.sdkProcessingMetadata =
      dsc === undefined
        ? sdkProcessingMetadata
        : { ...sdkProcessingMetadata, dynamicSamplingContext: withoutRecordIds(dsc, new WeakSet(), 0, SWEEP_MAX_DEPTH) };
  } else if (sdkProcessingMetadata !== undefined) {
    swept.sdkProcessingMetadata = sdkProcessingMetadata;
  }
  restoreDebugIds(wire.debug_meta, swept.debug_meta);
  return swept as T;
}

/** `debug_meta.images[].debug_id` is a dashed UUID that the SDK attaches to
 *  link stack frames to the uploaded source maps (Codex P1 4301635965). It
 *  identifies a BUILD ARTIFACT, never a record, so the sweep restores it.
 *  Every other value in debug_meta (code_file paths and so on) stays swept. */
function restoreDebugIds(original: unknown, swept: unknown): void {
  if (!isRecord(original) || !isRecord(swept)) return;
  const from = original.images;
  const to = swept.images;
  if (!Array.isArray(from) || !Array.isArray(to)) return;
  from.forEach((image, i) => {
    const target = to[i];
    if (isRecord(image) && isRecord(target) && typeof image.debug_id === "string") {
      target.debug_id = image.debug_id;
    }
  });
}

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
    const key = scrubKey(k, out);
    if (opts.redactKeys && SENSITIVE_KEY_RE.test(k)) {
      out[key] = REDACTED;
    } else {
      out[key] = deepScrub(v, opts, seen, depth + 1);
    }
  }
  return out;
}

function scrubContexts(
  contexts: Record<string, unknown>,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rawKey, ctx] of Object.entries(contexts)) {
    const key = scrubKey(rawKey, out);
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

  return sweepRecordIds(breadcrumb);
}

// Shared across error + transaction events (both extend Event).
function scrubEventCommon<T extends Event>(event: T): T {
  const seen = new WeakSet<object>();

  if (typeof event.message === "string") {
    event.message = redactString(event.message);
  }

  // Some capture paths (captureMessage with a template) send the text in the
  // logentry interface instead of `message` (Codex P1 4301281977), and its
  // params are the interpolated values. Both go through the same redaction,
  // as does a custom fingerprint, which is grouping text built from the
  // same strings.
  // The WHOLE interface is scrubbed, not a field list (Codex P1 4301447093:
  // `formatted`, which Sentry prefers over `message`, was missed), so a field
  // Sentry adds later is covered too.
  const logentry = (event as { logentry?: unknown }).logentry;
  if (logentry !== undefined) {
    (event as { logentry?: unknown }).logentry = deepScrub(logentry, { redactKeys: true }, seen, 0);
  }
  if (Array.isArray(event.fingerprint)) {
    event.fingerprint = event.fingerprint.map((f) => (typeof f === "string" ? redactString(f) : f));
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
    event.exception.values = event.exception.values.map((ex) => {
      if (typeof ex.value === "string") ex.value = redactString(ex.value);
      // The rest of the exception is structured too (Codex P1, review 5556246142):
      // `type` (from Error.name), `mechanism.data` and stack frames
      // (filename, abs_path, context lines, vars) can each carry a record id.
      return withoutRecordIds(ex, seen, 0) as typeof ex;
    });
  }
  const threads = (event as { threads?: unknown }).threads;
  if (threads !== undefined) {
    (event as { threads?: unknown }).threads = withoutRecordIds(threads, seen, 0);
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
  return sweepRecordIds(scrubEventCommon(event));
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

  return sweepRecordIds(event);
}

/** Production traces at 0.1 (10%); development at 1.0 for full local
 *  visibility. Note: error events are NOT sampled by this rate, only
 *  performance transactions, so error capture is unaffected in production. */
export function tracesSampleRate(): number {
  return process.env.NODE_ENV === "production" ? 0.1 : 1;
}
