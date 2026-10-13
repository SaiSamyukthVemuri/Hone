// Fett twin app server: refuse EVERY outbound connection that is not loopback.
// Loaded via NODE_OPTIONS --require. Covers net/tls sockets (http, https, undici fetch all end here)
// and global fetch. Each refusal is appended to FETT_TWIN_EGRESS_LOG so a walkthrough can prove that
// no provider (Twilio, Resend, Stripe, PostHog, Sentry, anything) was reached.
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload, loaded by `node --require` */
const net = require("node:net");
const tls = require("node:tls");
const fs = require("node:fs");

const LOG = process.env.FETT_TWIN_EGRESS_LOG || "/tmp/fett-twin-egress-refused.jsonl";
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\]|0\.0\.0\.0)$/i;

function record(kind, host, port) {
  try {
    fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), kind, host, port }) + "\n");
  } catch {}
}

function targetOf(args) {
  const a = args[0];
  if (a && typeof a === "object") return { host: a.host || a.hostname || (a.path ? "unix" : "localhost"), port: a.port };
  if (typeof a === "number") return { host: typeof args[1] === "string" ? args[1] : "localhost", port: a };
  if (typeof a === "string") return { host: "unix", port: a };
  return { host: "localhost", port: undefined };
}

function guard(original, kind) {
  return function guarded(...args) {
    const { host, port } = targetOf(args);
    if (host !== "unix" && !LOOPBACK.test(String(host))) {
      record(kind, host, port);
      const err = new Error(`fett-twin egress refused: ${host}:${port}`);
      err.code = "ECONNREFUSED";
      const sock = new net.Socket();
      process.nextTick(() => sock.destroy(err));
      return sock;
    }
    return original.apply(this, args);
  };
}

net.connect = net.createConnection = guard(net.createConnection, "net");
tls.connect = guard(tls.connect, "tls");

if (typeof globalThis.fetch === "function") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async function guardedFetch(input, init) {
    let url;
    try {
      url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    } catch {
      return realFetch(input, init);
    }
    if (!LOOPBACK.test(url.hostname)) {
      record("fetch", url.hostname, url.port || (url.protocol === "https:" ? 443 : 80));
      throw new TypeError(`fett-twin egress refused: ${url.hostname}`);
    }
    return realFetch(input, init);
  };
}
