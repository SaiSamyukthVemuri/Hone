"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload, loaded by `node --require` */
/**
 * Test-only backstop for tests/scripts/sentry-egress-guard.test.ts.
 *
 * Preloaded UNDERNEATH e2e/helpers/sentry-egress-guard.cjs in every probe, so
 * that a broken guard (a reverted patch, a mangled host match) fails the suite
 * with a resolution error instead of reaching the operational Sentry project
 * from it. It is deliberately a different mechanism from the guard's: every
 * request stack - node:http/https, undici fetch, Next's edge-runtime undici,
 * raw net/tls - has to resolve the hostname, and this refuses that.
 *
 * Never loaded outside those probes. (dns is patched here and NOT in the guard,
 * because the guard also runs inside `next build`, where a dns patch once hung
 * the client compile - see scripts/block-google-fonts.cjs.)
 */
const dns = require("node:dns");

const SENTRY_HOST = /(^|\.)sentry\.io\.?$/i;

function refusal(hostname) {
  return Object.assign(
    new Error(`getaddrinfo ENOTFOUND ${hostname} (sentry dns backstop: the guard let this through)`),
    { code: "ENOTFOUND", hostname },
  );
}

const originalLookup = dns.lookup;
dns.lookup = function backstopLookup(hostname, ...rest) {
  if (typeof hostname === "string" && SENTRY_HOST.test(hostname)) {
    const callback = rest[rest.length - 1];
    if (typeof callback === "function") process.nextTick(() => callback(refusal(hostname)));
    return {};
  }
  return originalLookup.call(this, hostname, ...rest);
};

const originalPromiseLookup = dns.promises.lookup;
dns.promises.lookup = function backstopPromiseLookup(hostname, ...rest) {
  if (typeof hostname === "string" && SENTRY_HOST.test(hostname)) {
    return Promise.reject(refusal(hostname));
  }
  return originalPromiseLookup.call(this, hostname, ...rest);
};
