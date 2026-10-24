"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload, loaded by `node --require` */
/**
 * TWILIO-EGRESS-FAKE (MSG-006) - the local browser lanes never reach Twilio.
 *
 * Loaded into the LOCAL E2E web server with `node --require`, through the
 * NODE_OPTIONS that e2e/helpers/local-env.ts puts in E2E_WEB_SERVER_ENV - the
 * environment every browser lane (core, payment, mobile, Google) spreads. Same
 * posture as e2e/helpers/sentry-egress-guard.cjs, which it sits beside.
 *
 * WHY IT EXISTS. The lane's server carries dummy TWILIO_* credentials, and
 * outboundSmsFence (lib/sms/twilio.ts) fences only a non-production Vercel
 * deployment: local and CI are unfenced by design. So any spec that reached an
 * SMS send (a public booking with SMS consent, a waitlist join with "Yes" to
 * texts) POSTed to the real api.twilio.com. Nothing was sent - the credentials
 * are dummies - but it was a live provider contact, and Twilio's 401 answer is
 * a terminal refusal, so no spec could model a retryable provider failure.
 *
 * WHAT IT DOES, BY REQUEST STACK.
 *   * global fetch (the stack lib/sms/twilio.ts uses): a request to any Twilio
 *     host is answered IN-PROCESS and never opens a socket. A Messages.json POST
 *     is scripted by the LAST FOUR DIGITS of its `To` (e2e/helpers/
 *     twilio-egress-config.ts names them), so each spec picks its own outcome
 *     without shared state:
 *       - default, any other number: REFUSE BEFORE CONNECTING. The fetch rejects
 *         the way undici does for a refused connection (TypeError "fetch
 *         failed", cause.code ECONNREFUSED). lib/sms/twilio.ts classifies that
 *         as twilio_unreachable, retryable, attempt "refused": a definite
 *         non-send, which the reminder cron retries up to its give-up threshold.
 *       - ...0153: AMBIGUOUS 503. A 5xx is retryable but attempt "ambiguous"
 *         (the message may exist), which the ledger settles as `unknown` and
 *         the reminder path records as sent. A control case, never the default.
 *       - ...0150: ACCEPTED. 201 with a well-formed message SID.
 *     Any other Twilio URL over fetch is refused the same way as the default.
 *   * node:http / node:https request/get to a Twilio host: refused before
 *     connecting (an ECONNREFUSED socket error), whatever the body.
 *   * raw net.connect / tls.connect to a Twilio host (Next's edge-runtime undici
 *     opens its own TLS socket): refused, never connected.
 *
 * Nothing is thrown away: every interception is appended to the run log
 * (HONE_E2E_TWILIO_EGRESS_LOG) as one JSON line - the stack, host, a path with
 * the account SID elided, the mode and the destination's last four digits. No
 * message body and no full number is ever recorded.
 *
 * dns.lookup is deliberately NOT patched: this preload also runs inside
 * `next build`, where a dns patch once hung the client compile (see
 * scripts/block-google-fonts.cjs).
 *
 * A DEPLOYED-RUNTIME SIGNAL ABORTS THE LANE, for the same reason and with the
 * same signal list as the Sentry guard (a test holds the lists to one set):
 * only the local lanes load this file, so such a signal was inherited, never
 * deployed, and a fake answering for Twilio must never stand in for the real
 * provider anywhere that could matter.
 *
 * WHEN ARMED, IT SAYS SO ON globalThis[Symbol.for("hone.e2e.twilioEgressFake")].
 */

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const tls = require("node:tls");
const { Duplex } = require("node:stream");

const FAKE_KEY = Symbol.for("hone.e2e.twilioEgressFake");

/** Any Twilio host (api., messaging., lookups., ...) and a trailing-dot FQDN. */
const TWILIO_HOST = /(^|\.)twilio\.com\.?$/i;

/** Last four digits of `To` that select a non-default outcome. */
const AMBIGUOUS_503_SUFFIX = "0153";
const ACCEPT_SUFFIX = "0150";

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
  const colon = h.lastIndexOf(":");
  if (colon > -1 && /^\d+$/.test(h.slice(colon + 1))) h = h.slice(0, colon);
  return h;
}

function isTwilioHost(host) {
  const h = normalizeHost(host);
  return h !== null && TWILIO_HOST.test(h);
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

const LOG = process.env.HONE_E2E_TWILIO_EGRESS_LOG || "";
let logDirReady = false;

function record(entry) {
  if (!LOG) return;
  try {
    if (!logDirReady) {
      fs.mkdirSync(path.dirname(LOG), { recursive: true, mode: 0o700 });
      logDirReady = true;
    }
    fs.appendFileSync(
      LOG,
      JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...entry }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    // Recording is evidence, never a reason to break the server under test.
  }
}

/** The request path with the account SID elided; never a query string. */
function safePath(pathname) {
  if (typeof pathname !== "string") return null;
  return pathname.split(/[?#]/)[0].replace(/\/Accounts\/[^/]+/, "/Accounts/{sid}").slice(0, 200);
}

function last4(to) {
  const digits = typeof to === "string" ? to.replace(/\D/g, "") : "";
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function modeFor(toLast4) {
  if (toLast4 === AMBIGUOUS_503_SUFFIX) return "ambiguous_503";
  if (toLast4 === ACCEPT_SUFFIX) return "accept";
  return "refuse";
}

function connectionRefused(host) {
  return Object.assign(
    new Error(`connect ECONNREFUSED ${host} (refused by the E2E Twilio egress fake)`),
    { code: "ECONNREFUSED", syscall: "connect", address: String(host) },
  );
}

// ---------------------------------------------------------------------------
// Refused sockets (http/https, net, tls)
// ---------------------------------------------------------------------------

function refusedSocket(via, host) {
  record({ kind: "refused", via, host: normalizeHost(host), mode: "refuse" });
  const socket = new net.Socket();
  const err = connectionRefused(host);
  // Deferred so the caller has attached its listeners, and emitted only to a
  // listener: an unhandled socket 'error' would crash the server under test.
  setImmediate(() => {
    if (socket.listenerCount("error") > 0) socket.destroy(err);
    else socket.destroy();
  });
  return socket;
}

function requestTarget(args) {
  let url = null;
  let options = {};
  if (typeof args[0] === "string" || args[0] instanceof URL) {
    try {
      url = new URL(String(args[0]));
    } catch {
      url = null;
    }
    if (args[1] && typeof args[1] === "object" && typeof args[1] !== "function") options = args[1];
  } else {
    options = args[0] || {};
  }
  return { host: options.hostname || options.host || (url ? url.hostname : null) };
}

function netTarget(args) {
  const [a, b] = args;
  if (a && typeof a === "object") return a.path ? null : a.host || "localhost";
  if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) {
    return typeof b === "string" ? b : "localhost";
  }
  return null;
}

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

// ---------------------------------------------------------------------------
// The scripted answer for a fetch to Twilio
// ---------------------------------------------------------------------------

async function answerFetch(input, init, target) {
  const request = new Request(input, init);
  const isMessages = request.method === "POST" && /\/Messages\.json$/.test(target.pathname);
  let toLast4 = null;
  let bodyBytes = 0;
  if (isMessages) {
    const body = await request.text();
    bodyBytes = Buffer.byteLength(body);
    toLast4 = last4(new URLSearchParams(body).get("To"));
  }
  const mode = isMessages ? modeFor(toLast4) : "refuse";
  record({
    kind: isMessages ? "message" : "refused",
    via: "fetch",
    host: normalizeHost(target.hostname),
    path: safePath(target.pathname),
    mode,
    toLast4,
    bodyBytes,
  });
  if (mode === "ambiguous_503") {
    return new Response(JSON.stringify({ code: 20503, message: "Service unavailable", status: 503 }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  if (mode === "accept") {
    const sid = "SM" + require("node:crypto").randomBytes(16).toString("hex");
    return new Response(JSON.stringify({ sid, status: "queued" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }
  // undici's shape for a connection that was never established.
  throw new TypeError("fetch failed", { cause: connectionRefused(target.hostname) });
}

function install() {
  for (const [mod, label] of [
    [http, "http"],
    [https, "https"],
  ]) {
    const originalRequest = mod.request;
    const originalGet = mod.get;
    const refusedRequest = (via, args) => {
      const { host } = requestTarget(args);
      if (!isTwilioHost(host)) return null;
      record({ kind: "refused", via, host: normalizeHost(host), mode: "refuse" });
      // A real ClientRequest over a stream that goes nowhere (it accepts and
      // drops whatever is written), destroyed with the error an unreachable
      // host produces. No `agent` key: with one, Node ignores createConnection.
      const req = originalRequest.call(http, {
        host: "127.0.0.1",
        port: 9,
        path: "/",
        createConnection: () =>
          new Duplex({
            read() {},
            write(_chunk, _encoding, callback) {
              callback();
            },
          }),
      });
      setImmediate(() => req.destroy(connectionRefused(host)));
      return req;
    };
    mod.request = function fakedRequest(...args) {
      return refusedRequest(`${label}.request`, args) || originalRequest.apply(this, args);
    };
    mod.get = function fakedGet(...args) {
      const refused = refusedRequest(`${label}.get`, args);
      if (refused) {
        refused.end();
        return refused;
      }
      return originalGet.apply(this, args);
    };
  }

  // net.connect and net.createConnection are the same function, exported twice.
  const originalNetConnect = net.connect;
  const fakedNetConnect = function fakedNetConnect(...args) {
    const host = netTarget(args);
    if (isTwilioHost(host)) return refusedSocket("net.connect", host);
    return originalNetConnect.apply(this, args);
  };
  net.connect = fakedNetConnect;
  net.createConnection = fakedNetConnect;

  const originalTlsConnect = tls.connect;
  tls.connect = function fakedTlsConnect(...args) {
    const host = tlsTarget(args);
    if (isTwilioHost(host)) return refusedSocket("tls.connect", host);
    return originalTlsConnect.apply(this, args);
  };

  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function fakedFetch(input, init) {
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
      if (!target || !isTwilioHost(target.hostname)) {
        // Forward without rebinding `this`: undici rejects an unexpected receiver.
        return originalFetch(input, init);
      }
      // Inside the chain, so a malformed request rejects as fetch does.
      return Promise.resolve().then(() => answerFetch(input, init, target));
    };
  }
}

const signal = deployedEnvironmentSignal(process.env);
if (signal) {
  throw new Error(
    `[twilio-egress-fake] REFUSING TO START (pid ${process.pid}): this environment carries a ` +
      `deployed-runtime signal (${signal}). This fake is loaded only by the local browser lanes ` +
      "(E2E_WEB_SERVER_ENV), so the signal was inherited, not deployed. Unset it for the E2E run, " +
      "e.g. `env -u AWS_REGION -u AWS_EXECUTION_ENV -u KUBERNETES_SERVICE_HOST -u VERCEL " +
      "-u VERCEL_ENV npm run test:e2e`.",
  );
}
if (!globalThis[FAKE_KEY] || !globalThis[FAKE_KEY].active) {
  install();
  globalThis[FAKE_KEY] = { active: true };
}
