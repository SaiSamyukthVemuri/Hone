/**
 * Refuse every network request to the Google Fonts hosts.
 *
 * Loaded with `node --require`, so `NODE_OPTIONS` carries it into the child
 * processes and worker threads `next build` spawns - which is where the fetch
 * actually happens.
 *
 * WHY THIS EXISTS AS WELL AS THE SOURCE GUARD.
 * tests/source-guards/self-hosted-fonts-guards.test.ts scans source for the
 * hostname and for `next/font/google`, and it cannot win in general: a URL
 * assembled from a variable, a template substitution, String.fromCharCode or
 * base64 is invisible to any static scan. This does not care how the string was
 * spelled. It fails at the moment of the request.
 *
 * The two layers answer different questions. The guard says "nobody wrote it
 * down"; this says "nothing asked for it". Neither implies the other.
 *
 * Covers node:http / node:https `request` and `get` AND the global `fetch`.
 *
 * BOTH are required, and assuming otherwise was a real hole. `next/font` itself
 * reaches the network through node:https.request (see
 * next/dist/compiled/@next/font/dist/google/fetch-resource.js), so that path
 * catches the regression this repo actually hit. But global `fetch` goes
 * through undici and touches NEITHER http nor https export - measured, with an
 * earlier version of this file loaded, a base64-constructed
 * `fetch("https://" + host)` completed successfully. A preload that misses
 * fetch cannot honestly be described as covering constructed hostnames, which
 * is precisely the job it exists to do.
 *
 * dns.lookup is deliberately NOT patched: an earlier version did, and that
 * broader patch hung `next build` partway through the client compile. http,
 * https and fetch are the request-issuing surfaces; dns was blast radius.
 *
 * Hostnames are matched CASE-INSENSITIVELY: DNS is case-insensitive and Node
 * normalises, so FONTS.GOOGLEAPIS.COM is the same host.
 */
const BLOCKED = /(^|\.)fonts\.(googleapis|gstatic)\.com$/i;

function hostFrom(arg) {
  if (!arg) return null;
  if (typeof arg === "string") {
    try {
      return new URL(arg).hostname;
    } catch {
      return null;
    }
  }
  if (arg instanceof URL) return arg.hostname;
  if (typeof arg === "object") return arg.hostname || arg.host || null;
  return null;
}

for (const mod of ["node:http", "node:https"]) {
  const m = require(mod);
  for (const method of ["request", "get"]) {
    const original = m[method];
    if (typeof original !== "function") continue;
    m[method] = function (...args) {
      const host = hostFrom(args[0]) || hostFrom(args[1]);
      if (typeof host === "string" && BLOCKED.test(host.split(":")[0])) {
        console.error(
          `\n[block-google-fonts] BLOCKED ${mod}.${method} -> ${host}\n` +
            "This build tried to reach Google Fonts. The fonts are self-hosted in\n" +
            "app/_fonts; see FONTS.md. Do not re-add next/font/google.\n",
        );
        throw new Error(
          `BLOCKED_GOOGLE_FONTS: refused ${mod}.${method} to ${host}`,
        );
      }
      return original.apply(this, args);
    };
  }
}

// Global fetch (undici) - a separate stack that neither patch above touches.
if (typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    let host = null;
    try {
      const url =
        typeof input === "string" || input instanceof URL
          ? input
          : input && typeof input.url === "string"
            ? input.url
            : null;
      if (url) host = new URL(url).hostname;
    } catch {
      host = null;
    }
    if (typeof host === "string" && BLOCKED.test(host.split(":")[0])) {
      console.error(
        `\n[block-google-fonts] BLOCKED fetch -> ${host}\n` +
          "This build tried to reach Google Fonts. The fonts are self-hosted in\n" +
          "app/_fonts; see FONTS.md. Do not re-add next/font/google.\n",
      );
      return Promise.reject(
        new Error(`BLOCKED_GOOGLE_FONTS: refused fetch to ${host}`),
      );
    }
    // Forward without rebinding `this`: undici rejects an unexpected receiver.
    return originalFetch(input, init);
  };
}
