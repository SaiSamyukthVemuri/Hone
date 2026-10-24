"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload, loaded by `node --require` */
/**
 * Test-only backstop for tests/scripts/twilio-egress-fake.test.ts.
 *
 * Preloaded UNDERNEATH e2e/helpers/twilio-egress-fake.cjs in every probe, so a
 * broken fake (a reverted patch, a mangled host match) fails the suite with a
 * resolution error instead of reaching Twilio from it. A different mechanism
 * from the fake's: every stack must resolve the host and open a socket, and
 * this refuses both - dns.lookup and net.Socket.prototype.connect - for any
 * Twilio host, writing one TWILIO_BACKSTOP_HIT line to stderr per refusal so a
 * probe can count them. Never loaded outside those probes.
 */
const dns = require("node:dns");
const net = require("node:net");

const TWILIO_HOST = /(^|\.)twilio\.com\.?$/i;

function hit(how, hostname) {
  process.stderr.write(`TWILIO_BACKSTOP_HIT ${how} ${hostname}\n`);
  return Object.assign(
    new Error(`getaddrinfo ENOTFOUND ${hostname} (twilio backstop: the fake let this through)`),
    { code: "ENOTFOUND", hostname },
  );
}

const originalLookup = dns.lookup;
dns.lookup = function backstopLookup(hostname, ...rest) {
  if (typeof hostname === "string" && TWILIO_HOST.test(hostname)) {
    const err = hit("dns.lookup", hostname);
    const callback = rest[rest.length - 1];
    if (typeof callback === "function") process.nextTick(() => callback(err));
    return {};
  }
  return originalLookup.call(this, hostname, ...rest);
};

const originalPromiseLookup = dns.promises.lookup;
dns.promises.lookup = function backstopPromiseLookup(hostname, ...rest) {
  if (typeof hostname === "string" && TWILIO_HOST.test(hostname)) {
    return Promise.reject(hit("dns.promises.lookup", hostname));
  }
  return originalPromiseLookup.call(this, hostname, ...rest);
};

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function backstopConnect(...args) {
  const first = args[0];
  const host = Array.isArray(first)
    ? first[0] && first[0].host
    : first && typeof first === "object"
      ? first.host || first.servername
      : typeof args[1] === "string"
        ? args[1]
        : null;
  if (typeof host === "string" && TWILIO_HOST.test(host)) {
    const err = hit("socket.connect", host);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return originalConnect.apply(this, args);
};
