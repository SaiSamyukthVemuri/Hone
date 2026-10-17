// ===========================================================================
// #828 G-07/G-26: same-origin analytics and error-tracking proxies that
// forward ONLY what the upstream needs.
// ===========================================================================
//
// /ingest (PostHog) and /monitoring (Sentry's tunnel) are same-origin paths so
// the strict CSP (connect-src 'self') holds and ad-blockers do not drop them.
// They used to be bare Next rewrites, and a rewrite to an external origin
// proxies EVERY request header: the browser's Referer (the full page URL,
// /clients/<uuid> and its query, because same-origin requests get the full URL
// under strict-origin-when-cross-origin), Origin, the Supabase auth Cookie,
// Authorization and the client IP. PostHog's own proxy guide states it: "By
// default, the proxy forwards all headers including cookies to PostHog"
// (posthog.com/docs/advanced/proxy/nextjs-middleware).
//
// These helpers back two route handlers that rebuild each request from an
// ALLOWLIST instead:
//   * request headers: content-type, content-encoding, accept. Nothing else.
//     No Referer, Origin, Cookie, Authorization, X-Forwarded-For/X-Real-IP
//     (no client IP: PostHog GeoIP is lost and the upstream sees the server's
//     IP, a deliberate minimization), User-Agent (posthog-js already sends
//     $raw_user_agent in the event body) or sec-fetch-*.
//   * response headers: content-type and cache-control. Never Set-Cookie.
//   * methods, path prefixes and body size are allowlisted / capped, the
//     upstream fetch has a timeout, and every failure answers with a bare
//     status and no detail.
//
// Requirements are the vendors' documented minimum: Sentry's tunnel guide
// (docs.sentry.io/platforms/javascript/troubleshooting/, "Using the tunnel
// option") forwards only the envelope body to https://<host>/api/<project>/
// envelope/ after checking the envelope's DSN host and project; PostHog's
// proxy guide sets only `host` and deletes cookie and authorization.

export const FORWARDED_REQUEST_HEADERS: readonly string[] = ["content-type", "content-encoding", "accept"];
// content-encoding is deliberately NOT returned: fetch() has already decoded
// the upstream body, so echoing "gzip" would make the browser decode it twice.
export const RETURNED_RESPONSE_HEADERS: readonly string[] = ["content-type", "cache-control"];

/** Request body cap for both proxies. PostHog batches and Sentry envelopes
 *  (no replay, no attachments in Hone) stay far below this. */
export const MAX_PROXY_BODY_BYTES = 1_000_000;
export const UPSTREAM_TIMEOUT_MS = 10_000;

/** A fresh header set holding only the allowlisted request headers. */
export function forwardedRequestHeaders(incoming: Headers): Headers {
  const out = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

/** A fresh header set holding only the allowlisted response headers. */
export function returnedResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  for (const name of RETURNED_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

// --- PostHog ----------------------------------------------------------------

const POSTHOG_INGEST_ORIGIN = "https://us.i.posthog.com";
const POSTHOG_ASSETS_ORIGIN = "https://us-assets.i.posthog.com";

/** First path segments posthog-js uses with api_host "/ingest": events (/e,
 *  /i/v0/e), feature flags (/flags, legacy /decide) and the SDK's own assets
 *  (/static, /array). Anything else (/api/*, /s, ...) is refused, so the
 *  route is not a general proxy to PostHog. */
export const POSTHOG_ALLOWED_PREFIXES: readonly string[] = ["e", "flags", "decide", "static", "array", "i"];
export const POSTHOG_ALLOWED_METHODS: readonly string[] = ["GET", "POST", "HEAD"];

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** The upstream URL for /ingest/<segments>?<search>, or null to refuse. The
 *  path is rebuilt from validated segments; no client host is trusted. */
export function posthogUpstreamUrl(segments: readonly string[], search: string, trailingSlash = false): string | null {
  const first = segments[0];
  if (first === undefined || !POSTHOG_ALLOWED_PREFIXES.includes(first)) return null;
  if (!segments.every((s) => SAFE_SEGMENT.test(s) && s !== "." && s !== "..")) return null;
  const origin = first === "static" || first === "array" ? POSTHOG_ASSETS_ORIGIN : POSTHOG_INGEST_ORIGIN;
  // The trailing slash posthog-js sends ("/flags/?v=2", "/e/") is kept as sent.
  return `${origin}/${segments.join("/")}${trailingSlash ? "/" : ""}${search}`;
}

// --- Sentry -----------------------------------------------------------------

/** The DSN host and project every Hone runtime is configured with (see
 *  instrumentation-client.ts, sentry.server.config.ts, sentry.edge.config.ts;
 *  pinned by tests/lib/observability/egress-proxy.test.ts). */
export const SENTRY_DSN_HOST = "o4511758551941120.ingest.us.sentry.io";
export const SENTRY_PROJECT_ID = "4511758557839360";

/** The upstream envelope URL for a tunnelled envelope, or null to refuse.
 *  Only an envelope whose header DSN names Hone's own host and project is
 *  forwarded, so the tunnel cannot relay to anyone else. */
export function sentryEnvelopeUpstreamUrl(envelope: Uint8Array): string | null {
  const newline = envelope.indexOf(0x0a);
  const headerBytes = newline === -1 ? envelope : envelope.subarray(0, newline);
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes));
  } catch {
    return null;
  }
  if (typeof header !== "object" || header === null) return null;
  const dsnRaw = (header as { dsn?: unknown }).dsn;
  if (typeof dsnRaw !== "string") return null;
  let dsn: URL;
  try {
    dsn = new URL(dsnRaw);
  } catch {
    return null;
  }
  const project = dsn.pathname.replace(/^\/+|\/+$/g, "");
  if (dsn.protocol !== "https:" || dsn.hostname !== SENTRY_DSN_HOST || project !== SENTRY_PROJECT_ID) return null;
  return `https://${SENTRY_DSN_HOST}/api/${SENTRY_PROJECT_ID}/envelope/`;
}

// --- shared request plumbing ------------------------------------------------

/** The request body as bytes, or null when it exceeds the cap. */
export async function readCappedBody(req: Request): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_PROXY_BODY_BYTES) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PROXY_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Forward one request upstream with allowlisted headers and a timeout, and
 *  return the upstream answer with allowlisted headers. Any failure is a bare
 *  502 with no detail. */
export async function forwardUpstream(
  url: string,
  method: string,
  incoming: Headers,
  body: Uint8Array | null,
): Promise<Response> {
  try {
    const upstream = await fetch(url, {
      method,
      headers: forwardedRequestHeaders(incoming),
      body: body && body.byteLength > 0 ? (body.slice().buffer as ArrayBuffer) : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const payload = method === "HEAD" ? null : await upstream.arrayBuffer();
    return new Response(payload, { status: upstream.status, headers: returnedResponseHeaders(upstream.headers) });
  } catch {
    return new Response(null, { status: 502 });
  }
}
