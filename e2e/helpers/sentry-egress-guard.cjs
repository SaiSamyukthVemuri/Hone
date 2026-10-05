"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload, loaded by `node --require` */
/**
 * SENTRY-E2E-NOISE-02 - the local browser lanes never reach the operational
 * Sentry project.
 *
 * Loaded into the LOCAL E2E web server (`next build && next start`) with
 * `node --require`, through the NODE_OPTIONS that e2e/helpers/local-env.ts puts
 * in E2E_WEB_SERVER_ENV - the environment every browser lane (core, payment,
 * mobile, Google) spreads. Nothing a deployment runs sets NODE_OPTIONS to this
 * file: Vercel builds and serves the app without Playwright.
 *
 * WHAT STILL LEAKED AFTER SENTRY-NOISE-01 (#784), MEASURED ON THIS LANE.
 * #784 drops a deliberate fault in the SERVER runtime's beforeSend, and it
 * works there. It cannot do the same in the browser - deciding there needs a
 * NEXT_PUBLIC_* input, a deployable bypass - so it keeps the client-throw event
 * by design. That event leaves the browser for the same-origin /monitoring
 * tunnel, and the tunnel is a Next rewrite this very server proxies to
 * *.ingest.sentry.io. Everything else the lane emits went to the same project:
 * a real failure raised during a run, sessions, transactions and client
 * reports, sent by the server SDK directly or by the browser through the
 * tunnel - all tagged environment=production.
 *
 * WHY THE NETWORK BOUNDARY, AND NOT ANOTHER beforeSend RULE.
 *   * One choke point covers every runtime. Server-SDK envelopes and the
 *     browser envelopes the tunnel forwards both leave THIS process, so the
 *     browser is contained without the client ever deciding anything - no
 *     NEXT_PUBLIC_* input, and no change to what ships to a visitor.
 *   * It never reads event content, so no request-controlled text (the canary
 *     is not secret) can widen or narrow it.
 *   * The Sentry wiring is untouched: sentry.*.config.ts, instrumentation*.ts
 *     and next.config.ts are byte-identical, so deployed and preview reporting
 *     has nothing new that could fail.
 *   * It covers what a per-event rule cannot. Measured on this lane with
 *     SENTRY-NOISE-01 in place: the server's request-session aggregates still
 *     counted every dropped synthetic throw as a CRASHED session, browser
 *     sessions recorded the client-throw error, and transactions and client
 *     reports flowed from all three runtimes - all as environment=production.
 *   * Nothing is thrown away. A request bound for Sentry is answered by a
 *     loopback sink that records what would have been sent, which is what lets
 *     e2e/authenticated-route-error-containment.spec.ts assert on the REAL
 *     runtime path rather than on a predicate in isolation.
 *
 * Same posture as scripts/block-google-fonts.cjs, which CI loads the same way,
 * and the same lesson: node:http / node:https AND global fetch are separate
 * stacks, and covering one does not cover the other. A third applies here.
 * Next's edge sandbox (middleware) carries its own bundled undici
 * (next/dist/compiled/@edge-runtime/primitives/fetch.js) that reaches neither
 * the https export nor the global fetch, and opens its socket through
 * tls.connect. So a raw connect to a Sentry host is REFUSED (and recorded):
 * there is no plaintext request to answer on a TLS socket.
 *
 * dns.lookup is deliberately NOT patched. block-google-fonts.cjs records that a
 * dns patch hung `next build` partway through the client compile.
 *
 * FAILS OPEN FOR OBSERVABILITY. In a runtime carrying any deployed-environment
 * signal this installs nothing and says so on stderr, so a misconfiguration can
 * never silence a deployment's Sentry. The signal list mirrors
 * deployedEnvironmentSignal in lib/reliability/e2e-route-fault.ts (that module
 * is TypeScript and server-only, so it cannot be required here); a test holds
 * the two lists to the same set.
 */

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const zlib = require("node:zlib");

const GUARD_KEY = Symbol.for("hone.e2e.sentryEgressGuard");

/** Any Sentry SaaS host, including the regional ingest hosts and a trailing-dot FQDN. */
const SENTRY_HOST = /(^|\.)sentry\.io\.?$/i;

function deployedEnvironmentSignal(env) {
  if (env.VERCEL === "1") return "VERCEL";
  if (env.VERCEL_ENV) return `VERCEL_ENV=${env.VERCEL_ENV}`;
  if (env.AWS_REGION || env.AWS_EXECUTION_ENV) return "AWS";
  if (env.KUBERNETES_SERVICE_HOST) return "KUBERNETES";
  return null;
}

function normalizeHost(host) {
  if (typeof host !== "string") return null;
  let h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]"));
  // host may carry a port ("o1.ingest.sentry.io:443")
  const colon = h.lastIndexOf(":");
  if (colon > -1 && /^\d+$/.test(h.slice(colon + 1))) h = h.slice(0, colon);
  return h;
}

function isSentryHost(host) {
  const h = normalizeHost(host);
  return h !== null && SENTRY_HOST.test(h);
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

const LOG = process.env.HONE_E2E_SENTRY_EGRESS_LOG || "";
// Private to this user: records carry event text, and the sink socket lives
// here too, so another local account can neither read the one nor write into
// the other.
const PRIVATE_DIR = LOG ? path.dirname(LOG) : null;
let privateDirReady = false;

function ensurePrivateDir() {
  if (!PRIVATE_DIR || privateDirReady) return;
  fs.mkdirSync(PRIVATE_DIR, { recursive: true, mode: 0o700 });
  privateDirReady = true;
}

function record(entry) {
  if (!LOG) return;
  try {
    ensurePrivateDir();
    fs.appendFileSync(
      LOG,
      JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...entry }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    // Recording is evidence, never a reason to break the server under test.
  }
}

function clip(value, max = 500) {
  return typeof value === "string" ? value.slice(0, max) : value;
}

function parseEnvelope(buf) {
  const items = [];
  let pos = 0;
  const line = () => {
    const nl = buf.indexOf(0x0a, pos);
    const end = nl === -1 ? buf.length : nl;
    const text = buf.subarray(pos, end).toString("utf8");
    pos = end + 1;
    return text;
  };
  const header = JSON.parse(line() || "{}");
  while (pos < buf.length) {
    const itemHeaderText = line();
    if (!itemHeaderText.trim()) continue;
    const itemHeader = JSON.parse(itemHeaderText);
    let payload;
    if (typeof itemHeader.length === "number") {
      payload = buf.subarray(pos, pos + itemHeader.length);
      pos += itemHeader.length + 1;
    } else {
      const nl = buf.indexOf(0x0a, pos);
      const end = nl === -1 ? buf.length : nl;
      payload = buf.subarray(pos, end);
      pos = end + 1;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(payload.toString("utf8"));
    } catch {
      parsed = null;
    }
    items.push({ type: itemHeader.type, payload: parsed });
  }
  return { header, items };
}

/** What a spec needs to attribute an envelope, and nothing more. */
function summarizeItem({ type, payload }) {
  const p = payload || {};
  if (type === "event") {
    return {
      type,
      event_id: p.event_id,
      platform: p.platform,
      level: p.level,
      environment: p.environment,
      release: p.release,
      transaction: clip(p.transaction, 200),
      runtime: p.contexts && p.contexts.runtime ? p.contexts.runtime.name : undefined,
      browser: p.contexts && p.contexts.browser ? p.contexts.browser.name : undefined,
      message: clip(p.message),
      logentry: p.logentry ? clip(p.logentry.message) : undefined,
      exceptions: ((p.exception && p.exception.values) || []).map((e) => ({
        type: e.type,
        value: clip(e.value),
        mechanism: e.mechanism ? { type: e.mechanism.type, handled: e.mechanism.handled } : null,
      })),
    };
  }
  if (type === "transaction") {
    const trace = (p.contexts && p.contexts.trace) || {};
    return { type, platform: p.platform, transaction: clip(p.transaction, 200), op: trace.op, status: trace.status };
  }
  return { type };
}

function decompress(body, encoding) {
  if (encoding === "gzip") return zlib.gunzipSync(body);
  if (encoding === "deflate") return zlib.inflateSync(body);
  if (encoding === "br") return zlib.brotliDecompressSync(body);
  return body;
}

function recordEnvelope(meta, body) {
  let items = [];
  let parseError;
  try {
    items = parseEnvelope(body).items.map(summarizeItem);
  } catch (e) {
    parseError = clip(String(e), 200);
  }
  record({ kind: "envelope", ...meta, items, ...(parseError ? { parseError } : {}) });
  const event = items.find((i) => i.event_id);
  return JSON.stringify({ id: event ? event.event_id : null });
}

// ---------------------------------------------------------------------------
// The loopback sink: a Unix socket, so its address is known synchronously (a
// pipe binds inside listen(); an IP listen resolves first and has no address
// until a later tick), created on first use, never keeping a process alive.
// ---------------------------------------------------------------------------

const originalHttpRequest = http.request;
let sinkPath = null;

function ensureSink() {
  if (sinkPath) return sinkPath;
  let dir = os.tmpdir();
  try {
    ensurePrivateDir();
    if (PRIVATE_DIR) dir = PRIVATE_DIR;
  } catch {
    // fall back to the system temp dir rather than fail the request
  }
  const candidate = path.join(dir, `sink-${process.pid}.sock`);
  try {
    fs.unlinkSync(candidate);
  } catch {
    // nothing stale to remove
  }
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let reply = "{}";
      try {
        const body = decompress(Buffer.concat(chunks), req.headers["content-encoding"]);
        reply = recordEnvelope(
          {
            via: req.headers["x-hone-egress-via"] || "unknown",
            host: req.headers["x-hone-egress-host"] || null,
            path: clip(req.url, 300),
            userAgent: clip(req.headers["user-agent"] || null, 200),
            forwardedHost: req.headers["x-forwarded-host"] || null,
          },
          body,
        );
      } catch (e) {
        record({ kind: "sink-error", error: clip(String(e), 200) });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(reply);
    });
  });
  // A sink that cannot listen must not take the server under test down with
  // it: the redirected request then fails locally, which still sends nothing.
  server.on("error", (e) => record({ kind: "sink-error", error: clip(String(e), 200) }));
  server.listen(candidate);
  server.unref();
  process.once("exit", () => {
    try {
      fs.unlinkSync(candidate);
    } catch {
      // already gone
    }
  });
  sinkPath = candidate;
  return sinkPath;
}

// ---------------------------------------------------------------------------
// Request-issuing surfaces
// ---------------------------------------------------------------------------

/** Resolve the target of an http(s).request/get call the way Node does. */
function requestTarget(args) {
  let url = null;
  let options = {};
  let callback;
  if (typeof args[0] === "string" || args[0] instanceof URL) {
    try {
      url = new URL(String(args[0]));
    } catch {
      url = null;
    }
    if (args[1] && typeof args[1] === "object") {
      options = args[1];
      callback = args[2];
    } else {
      callback = args[1];
    }
  } else {
    options = args[0] || {};
    callback = args[1];
  }
  const host = options.hostname || options.host || (url ? url.hostname : null);
  const reqPath = options.path || (url ? url.pathname + url.search : "/");
  return { options, callback, host, reqPath };
}

function headerObject(headers) {
  const out = {};
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) out[headers[i]] = headers[i + 1];
  } else if (headers && typeof headers === "object") {
    Object.assign(out, headers);
  }
  return out;
}

function redirectToSink(via, args) {
  const { options, callback, host, reqPath } = requestTarget(args);
  if (!isSentryHost(host)) return null;
  const headers = headerObject(options.headers);
  headers["x-hone-egress-via"] = via;
  headers["x-hone-egress-host"] = normalizeHost(host);
  return originalHttpRequest(
    {
      socketPath: ensureSink(),
      method: options.method || "GET",
      path: reqPath,
      headers,
      agent: false,
    },
    callback,
  );
}

function refusedSocket(via, host) {
  record({ kind: "refused", via, host: normalizeHost(host) });
  const socket = new net.Socket();
  const err = Object.assign(
    new Error(`connect ECONNREFUSED ${host} (refused by the E2E Sentry egress guard)`),
    { code: "ECONNREFUSED", syscall: "connect", address: String(host) },
  );
  // Deferred so the caller has attached its listeners, and an error is only
  // emitted to someone listening: an unhandled socket 'error' would crash the
  // server under test, which is worse than the event this refusal exists for.
  setImmediate(() => {
    if (socket.listenerCount("error") > 0) socket.destroy(err);
    else socket.destroy();
  });
  return socket;
}

/** Host of a net.connect / net.createConnection call, or null for IPC. */
function netTarget(args) {
  const [a, b] = args;
  if (a && typeof a === "object") return a.path ? null : a.host || "localhost";
  if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) {
    return typeof b === "string" ? b : "localhost";
  }
  return null;
}

/** Host (or SNI name) of a tls.connect call, or null for IPC. */
function tlsTarget(args) {
  const [a, b, c] = args;
  if (a && typeof a === "object") return a.path ? null : a.host || a.servername || "localhost";
  if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) {
    if (typeof b === "string") return b;
    if (b && typeof b === "object") return b.host || b.servername || "localhost";
    if (c && typeof c === "object") return c.host || c.servername || "localhost";
    return "localhost";
  }
  return null;
}

function install() {
  for (const [mod, label] of [
    [http, "http"],
    [https, "https"],
  ]) {
    const originalRequest = mod.request;
    const originalGet = mod.get;
    mod.request = function guardedRequest(...args) {
      return redirectToSink(`${label}.request`, args) || originalRequest.apply(this, args);
    };
    mod.get = function guardedGet(...args) {
      const redirected = redirectToSink(`${label}.get`, args);
      if (redirected) {
        redirected.end();
        return redirected;
      }
      return originalGet.apply(this, args);
    };
  }

  // net.connect and net.createConnection are the same function, exported twice.
  const originalNetConnect = net.connect;
  const guardedNetConnect = function guardedNetConnect(...args) {
    const host = netTarget(args);
    if (isSentryHost(host)) return refusedSocket("net.connect", host);
    return originalNetConnect.apply(this, args);
  };
  net.connect = guardedNetConnect;
  net.createConnection = guardedNetConnect;

  const originalTlsConnect = tls.connect;
  tls.connect = function guardedTlsConnect(...args) {
    const host = tlsTarget(args);
    if (isSentryHost(host)) return refusedSocket("tls.connect", host);
    return originalTlsConnect.apply(this, args);
  };

  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function guardedFetch(input, init) {
      let target = null;
      try {
        const raw =
          typeof input === "string" || input instanceof URL
            ? String(input)
            : input && typeof input.url === "string"
              ? input.url
              : null;
        if (raw) target = new URL(raw);
      } catch {
        target = null;
      }
      if (!target || !isSentryHost(target.hostname)) {
        // Forward without rebinding `this`: undici rejects an unexpected receiver.
        return originalFetch(input, init);
      }
      // Answered in-process: the sink records the body exactly as it would a
      // proxied one, and no socket is opened. Built inside the chain so that a
      // malformed request rejects, as fetch does, rather than throwing here.
      return Promise.resolve()
        .then(() => new Request(input, init).arrayBuffer())
        .then((buffer) => {
          const reply = recordEnvelope(
            {
              via: "fetch",
              host: normalizeHost(target.hostname),
              path: clip(target.pathname + target.search, 300),
              userAgent: null,
              forwardedHost: null,
            },
            Buffer.from(buffer),
          );
          return new Response(reply, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        });
    };
  }
}

const signal = deployedEnvironmentSignal(process.env);
if (signal) {
  console.error(
    `[sentry-egress-guard] NOT ACTIVE in pid ${process.pid}: deployed runtime (${signal}). ` +
      "Sentry egress is left untouched.",
  );
  globalThis[GUARD_KEY] = { active: false, reason: signal };
} else if (!globalThis[GUARD_KEY] || !globalThis[GUARD_KEY].active) {
  install();
  globalThis[GUARD_KEY] = { active: true };
}
