import "server-only";

// Google Calendar — Phase B2.1: explicit, closed error taxonomy for the worker.
//
// Every Google HTTP outcome (or thrown transport error) is normalized into ONE
// GoogleErrorKind. The kinds map deterministically to JobResultCodes in the
// handler. NO token, event body, client name, or clinical detail ever enters a
// GoogleError — only the HTTP status, a short safe code, and (for rate limits)
// a parsed Retry-After. The 409/404 CONVERGENCE behavior (GET-and-un-tombstone,
// 404-on-update-create) is B2.4; this module only classifies and marks WHERE
// those sub-cases attach (see `GoogleErrorKind` "conflict"/"not_found").

export type GoogleErrorKind =
  | "success" // 2xx
  | "token_expired" // 401 — refresh under lock, then retry once
  | "invalid_grant" // refresh 400 invalid_grant — reconnect_required
  | "insufficient_scope" // 403 with insufficientPermissions / scope reason
  | "rate_limited" // 403 rateLimitExceeded / userRateLimitExceeded, or 429
  | "not_found" // 404 (calendar or event) — B2.4 decides create-or-noop
  | "conflict" // 409 — B2.4 does GET + un-tombstone / honeLink match
  | "precondition_failed" // 412 — etag mismatch; refetch + converge (B2.4)
  | "transient" // 5xx / network / timeout / malformed body
  | "config_error"; // calendar/connection not found, oauth client unavailable

export type GoogleError = {
  kind: GoogleErrorKind;
  status: number | null; // HTTP status when there was a response, else null
  code: string; // short, safe, log-able (e.g. "google_http_503", "rate_limited")
  retryAfterSeconds: number | null; // parsed from Retry-After for rate limits/503
};

// Reason strings Google puts in the error body for 403s. We only read these
// coarse buckets; we never surface the raw body.
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
]);
const SCOPE_REASONS = new Set([
  "insufficientPermissions",
  "insufficient_scope",
  "forbidden",
  "accessNotConfigured",
]);

// Best-effort, allocation-bounded extraction of the first `reason` from a Google
// error body. Never throws; never returns anything but a short token.
function firstErrorReason(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") return null;
  const errors = (err as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const r = (errors[0] as { reason?: unknown }).reason;
    if (typeof r === "string") return r;
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status === "string") return status;
  return null;
}

// Parse an HTTP Retry-After header: either delta-seconds ("120") or an
// HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT"). Returns bounded whole seconds in
// [0, 21600], or null if absent/unparseable. `now` is injectable for tests.
export function parseRetryAfter(
  headerValue: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  // delta-seconds form
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    if (!Number.isFinite(secs)) return null;
    return Math.min(21600, Math.max(0, Math.floor(secs)));
  }
  // HTTP-date form
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  const deltaMs = when - now;
  if (deltaMs <= 0) return 0;
  return Math.min(21600, Math.floor(deltaMs / 1000));
}

// Classify a Google API HTTP RESPONSE. `parsedBody` may be null when the body
// was empty or unparseable (malformed JSON => transient). Reads only the status,
// coarse reason, and Retry-After — never the body content.
export function classifyGoogleResponse(input: {
  status: number;
  parsedBody: unknown;
  bodyParseFailed?: boolean;
  retryAfterHeader?: string | null;
  now?: number;
}): GoogleError {
  const { status } = input;
  const retryAfterSeconds = parseRetryAfter(input.retryAfterHeader, input.now);

  if (status >= 200 && status < 300) {
    return { kind: "success", status, code: "ok", retryAfterSeconds: null };
  }
  if (input.bodyParseFailed) {
    // A non-2xx with an unreadable body is treated as transient (retry).
    return { kind: "transient", status, code: `google_http_${status}_malformed`, retryAfterSeconds };
  }
  const reason = firstErrorReason(input.parsedBody);

  if (status === 401) {
    return { kind: "token_expired", status, code: "google_http_401", retryAfterSeconds: null };
  }
  if (status === 403) {
    if (reason && RATE_LIMIT_REASONS.has(reason)) {
      return { kind: "rate_limited", status, code: "google_rate_limited", retryAfterSeconds };
    }
    if (reason && SCOPE_REASONS.has(reason)) {
      return { kind: "insufficient_scope", status, code: "google_insufficient_scope", retryAfterSeconds: null };
    }
    // Unclassified 403 defaults to insufficient_scope (fail toward reconnect,
    // never toward an infinite retry loop).
    return { kind: "insufficient_scope", status, code: "google_http_403", retryAfterSeconds: null };
  }
  if (status === 404) {
    return { kind: "not_found", status, code: "google_http_404", retryAfterSeconds: null };
  }
  if (status === 409) {
    return { kind: "conflict", status, code: "google_http_409", retryAfterSeconds: null };
  }
  if (status === 412) {
    return { kind: "precondition_failed", status, code: "google_http_412", retryAfterSeconds: null };
  }
  if (status === 429) {
    return { kind: "rate_limited", status, code: "google_http_429", retryAfterSeconds };
  }
  if (status >= 500) {
    return { kind: "transient", status, code: `google_http_${status}`, retryAfterSeconds };
  }
  // Any other 4xx (400/405/…) is a transient/unknown — retry with backoff rather
  // than silently drop; never surface the body.
  return { kind: "transient", status, code: `google_http_${status}`, retryAfterSeconds };
}

// Classify a REFRESH response specifically (the token endpoint returns 400 with
// { error: "invalid_grant" } when the grant is revoked/expired).
export function classifyRefreshResponse(input: {
  status: number;
  parsedBody: unknown;
  bodyParseFailed?: boolean;
  retryAfterHeader?: string | null;
  now?: number;
}): GoogleError {
  if (input.status >= 200 && input.status < 300) {
    return { kind: "success", status: input.status, code: "ok", retryAfterSeconds: null };
  }
  if (input.status === 400 && !input.bodyParseFailed) {
    const oauthErr =
      input.parsedBody && typeof input.parsedBody === "object"
        ? (input.parsedBody as { error?: unknown }).error
        : undefined;
    if (oauthErr === "invalid_grant") {
      return { kind: "invalid_grant", status: 400, code: "invalid_grant", retryAfterSeconds: null };
    }
  }
  // Everything else on refresh (429/5xx/network) is transient.
  return classifyGoogleResponse(input);
}

// Classify a THROWN transport error (AbortError = timeout; anything else =
// network). Never carries the raw error message.
export function classifyThrown(err: unknown): GoogleError {
  const name = err && typeof err === "object" ? (err as { name?: unknown }).name : undefined;
  const code = name === "AbortError" ? "network_timeout" : "network_error";
  return { kind: "transient", status: null, code, retryAfterSeconds: null };
}
