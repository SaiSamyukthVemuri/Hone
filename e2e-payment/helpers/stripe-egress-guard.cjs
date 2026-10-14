"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload (`--import` in the lane, `--require` in unit tests) */
/**
 * PAY-CCY-09 (Codex P2 4264919601): the PAYMENT lane's web server never
 * reaches Stripe, and that is OBSERVED in the server process.
 *
 * Loaded into the local payment E2E web server as an `--import` preload, through
 * the NODE_OPTIONS that e2e-payment/helpers/payment-env.ts puts in
 * PAYMENT_WEB_SERVER_ENV (the payment and mobile lanes). Nothing a deployment
 * runs sets NODE_OPTIONS to this file.
 *
 * WHY THE SERVER PROCESS. The charge and refund Stripe SDK calls execute inside
 * Next.js, not in the browser, so a page.on("request") listener cannot see
 * them. If fake-client selection regressed, the server would talk to
 * api.stripe.com and a browser-side assertion would still be empty.
 *
 * WHAT IT DOES. Every connection to a *.stripe.com host — through node:http /
 * node:https request/get (the Stripe SDK's default client), net.connect,
 * tls.connect, or global fetch — is REFUSED (ECONNREFUSED, nothing is sent)
 * and RECORDED to HONE_E2E_STRIPE_EGRESS_LOG, so a spec can assert the log is
 * empty. Same shape and the same lesson as e2e/helpers/sentry-egress-guard.cjs:
 * the http(s) export, global fetch and raw sockets are separate stacks, and
 * covering one does not cover the others. It refuses rather than sinks: in this
 * lane there is no legitimate Stripe traffic to answer.
 *
 * A deployed-runtime signal ABORTS start-up (the same rule as the Sentry guard):
 * only the local lanes load this file, so such a signal is inherited, never a
 * deployment, and running unguarded would hide real egress.
 */
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const { Duplex } = require("node:stream");

const GUARD_KEY = Symbol.for("hone.e2e.stripeEgressGuard");
const STRIPE_HOST = /(^|\.)stripe\.com\.?$/i;
const LOG = process.env.HONE_E2E_STRIPE_EGRESS_LOG || "";

function deployedEnvironmentSignal(env) {
  if (env.VERCEL === "1") return "VERCEL";
  if (env.VERCEL_ENV) return `VERCEL_ENV=${env.VERCEL_ENV}`;
  if (env.AWS_REGION || env.AWS_EXECUTION_ENV) return "AWS";
  if (env.KUBERNETES_SERVICE_HOST) return "KUBERNETES";
  return null;
}

function normalizeHost(host) {
  return String(host || "")
    .replace(/^\[|\]$/g, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
}

function isStripeHost(host) {
  return !!host && STRIPE_HOST.test(normalizeHost(host));
}

function record(via, host) {
  if (!LOG) return;
  try {
    fs.appendFileSync(
      LOG,
      `${JSON.stringify({ kind: "refused", via, host: normalizeHost(host), at: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* the refusal itself never depends on the log */
  }
}

function refusedError(host) {
  return Object.assign(
    new Error(`connect ECONNREFUSED ${host} (refused by the E2E Stripe egress guard)`),
    { code: "ECONNREFUSED", syscall: "connect", address: String(host) },
  );
}

function refusedSocket(via, host) {
  record(via, host);
  const socket = new net.Socket();
  const err = refusedError(host);
  // Deferred so the caller has attached its listeners; an unhandled socket
  // 'error' would crash the server under test.
  setImmediate(() => {
    if (socket.listenerCount("error") > 0) socket.destroy(err);
    else socket.destroy();
  });
  return socket;
}

/** Host of an http(s).request/get call, resolved the way Node does. */
function requestHost(args) {
  let url = null;
  let options = {};
  if (typeof args[0] === "string" || args[0] instanceof URL) {
    try {
      url = new URL(String(args[0]));
    } catch {
      url = null;
    }
    if (args[1] && typeof args[1] === "object") options = args[1];
  } else {
    options = args[0] || {};
  }
  return options.hostname || options.host || (url ? url.hostname : null);
}

/**
 * A connection that goes nowhere: writes are discarded in-process, nothing is
 * read, nothing is dialled. It carries the socket methods Node's http client
 * (and so the Stripe SDK's req.setTimeout) calls on a real socket; without
 * them the request would throw inside the server under test.
 */
function nullSocket() {
  const s = new Duplex({
    read() {},
    write(_chunk, _encoding, done) {
      done();
    },
  });
  for (const m of ["setTimeout", "setNoDelay", "setKeepAlive", "ref", "unref"]) {
    s[m] = () => s;
  }
  s.connecting = false;
  return s;
}

/** Re-issue the request on a null connection, then refuse it. */
function refusedRequest(original, label, args) {
  const host = requestHost(args);
  if (!isStripeHost(host)) return null;
  const via = `${label}.request`;
  const callback = args.find((a) => typeof a === "function");
  record(via, host);
  // No `agent` option: Node honours createConnection only when no agent is
  // given, so this NULL stream is the only "connection" the request can use:
  // writes are discarded in-process, nothing is dialled (the loopback
  // host/port below are never used) and nothing is sent anywhere. The request
  // is then failed with ECONNREFUSED, after the caller has had the chance to
  // attach its 'error' listener.
  const req = original.call(
    null,
    {
      host: "127.0.0.1",
      port: 9,
      path: "/",
      method: "GET",
      createConnection: nullSocket,
    },
    callback,
  );
  setImmediate(() => {
    if (req.listenerCount("error") > 0) req.destroy(refusedError(host));
    else req.destroy();
  });
  return req;
}

function netHost(args) {
  const [a, b] = args;
  if (a && typeof a === "object") return a.path ? null : a.host || "localhost";
  if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) {
    return typeof b === "string" ? b : "localhost";
  }
  return null;
}

function tlsHost(args) {
  const [a, b, c] = args;
  if (a && typeof a === "object") return a.path ? null : a.servername || a.host || "localhost";
  if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) {
    if (typeof b === "string") return b;
    if (b && typeof b === "object") return b.servername || b.host || "localhost";
    if (c && typeof c === "object") return c.servername || c.host || "localhost";
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
      return refusedRequest(originalRequest, label, args) || originalRequest.apply(this, args);
    };
    mod.get = function guardedGet(...args) {
      const refused = refusedRequest(originalRequest, label, args);
      if (refused) {
        refused.end();
        return refused;
      }
      return originalGet.apply(this, args);
    };
  }

  const originalNetConnect = net.connect;
  const guardedNetConnect = function guardedNetConnect(...args) {
    const host = netHost(args);
    if (isStripeHost(host)) return refusedSocket("net.connect", host);
    return originalNetConnect.apply(this, args);
  };
  net.connect = guardedNetConnect;
  net.createConnection = guardedNetConnect;

  const originalTlsConnect = tls.connect;
  tls.connect = function guardedTlsConnect(...args) {
    const host = tlsHost(args);
    if (isStripeHost(host)) return refusedSocket("tls.connect", host);
    return originalTlsConnect.apply(this, args);
  };

  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function guardedFetch(input, init) {
      let host = null;
      try {
        const raw =
          typeof input === "string" || input instanceof URL
            ? String(input)
            : input && typeof input.url === "string"
              ? input.url
              : null;
        if (raw) host = new URL(raw).hostname;
      } catch {
        host = null;
      }
      if (!isStripeHost(host)) return originalFetch(input, init);
      record("fetch", host);
      return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: refusedError(host) }));
    };
  }
}

const signal = deployedEnvironmentSignal(process.env);
if (signal) {
  throw new Error(
    `[stripe-egress-guard] REFUSING TO START (pid ${process.pid}): this environment carries a ` +
      `deployed-runtime signal (${signal}). This guard is loaded only by the local payment lanes ` +
      "(PAYMENT_WEB_SERVER_ENV), so the signal was inherited, not deployed. Unset it for the E2E run.",
  );
}
if (!globalThis[GUARD_KEY] || !globalThis[GUARD_KEY].active) {
  install();
  globalThis[GUARD_KEY] = { active: true };
  // POSITIVE evidence the guard is in this process: an empty refusal list is
  // only meaningful next to an "armed" record from the server under test.
  if (LOG) {
    try {
      fs.appendFileSync(
        LOG,
        `${JSON.stringify({ kind: "armed", pid: process.pid, at: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
    } catch {
      /* best effort */
    }
  }
}
