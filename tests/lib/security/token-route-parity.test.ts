import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TOKEN_ROUTE_PREFIXES,
  TOKEN_ROUTE_PATTERNS,
  TOKEN_PLACEHOLDER,
  canonicalizeTokenPaths,
} from "@/lib/security/token-routes";
import { scrubErrorEvent } from "@/lib/observability/sentry-scrub";
import type { ErrorEvent } from "@sentry/nextjs";

// F-PRIV-001 parity gate.
//
// A token-bearing route needs BOTH protections to be safe:
//   * privacy headers (no-referrer / no-index) so the credential is not handed
//     to a third party or indexed;
//   * Sentry canonicalization so it is not shipped to an observability vendor.
//
// A route with only one is still leaking. These tests fail if the two consumers
// ever diverge, which is the failure mode a shared comment cannot prevent.

const ROOT = process.cwd();

describe("the registry is the single source for both consumers", () => {
  it("next.config.ts imports the registry instead of redeclaring the list", () => {
    const src = readFileSync(join(ROOT, "next.config.ts"), "utf8");
    expect(src).toContain('from "./lib/security/token-routes"');
    // No inline re-declaration may reappear.
    expect(src).not.toMatch(/const\s+TOKEN_ROUTE_PATTERNS\s*=\s*\[/);
    // And it must actually still apply them.
    expect(src).toContain("TOKEN_ROUTE_PATTERNS.map");
  });

  it("the Sentry scrubber consumes the same registry", () => {
    const src = readFileSync(
      join(ROOT, "lib/observability/sentry-scrub.ts"),
      "utf8",
    );
    expect(src).toContain("@/lib/security/token-routes");
    expect(src).toContain("canonicalizeTokenPaths");
  });

  it("every header pattern maps to exactly one canonicalized prefix", () => {
    expect(TOKEN_ROUTE_PATTERNS).toHaveLength(TOKEN_ROUTE_PREFIXES.length);
    for (const prefix of TOKEN_ROUTE_PREFIXES) {
      expect(TOKEN_ROUTE_PATTERNS).toContain(`${prefix}/:token*`);
    }
  });

  it("the six expected families are present, a removal must be deliberate", () => {
    // Pinned explicitly so silently DELETING a family from the registry (which
    // would drop both protections at once) fails loudly.
    expect([...TOKEN_ROUTE_PREFIXES].sort()).toEqual([
      "/calendar-feed",
      "/cancel",
      "/intake",
      "/manage",
      "/portal/verify",
      "/reschedule",
    ]);
  });
});

describe("every registered family is actually canonicalized", () => {
  // This is the gate that catches a NEW route added to the registry (and so to
  // the privacy headers) without sanitizer coverage: the loop is derived from
  // the registry, so a new family is tested the moment it is added.
  for (const prefix of TOKEN_ROUTE_PREFIXES) {
    it(`${prefix} :: credential removed from path, transaction and URL`, () => {
      const secret = "PARITYCANARY7bXq2mVnR4tLwZ9kJdY6hGpF3sC";
      expect(canonicalizeTokenPaths(`${prefix}/${secret}`)).toBe(
        `${prefix}/${TOKEN_PLACEHOLDER}`,
      );
      const out = scrubErrorEvent({
        event_id: "p1",
        transaction: `GET ${prefix}/${secret}`,
        request: { url: `https://hone.care${prefix}/${secret}?a=1#f` },
      } as ErrorEvent);
      expect(JSON.stringify(out)).not.toContain(secret);
      // The family itself survives: safe diagnostics, not no diagnostics.
      expect(String(out.transaction)).toContain(prefix);
    });
  }
});

describe("the Sentry hooks stay wired in all three runtimes", () => {
  const RUNTIMES = [
    "instrumentation-client.ts",
    "sentry.server.config.ts",
    "sentry.edge.config.ts",
  ];

  for (const file of RUNTIMES) {
    it(`${file} keeps sendDefaultPii:false and all three scrub hooks`, () => {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src).toMatch(/sendDefaultPii:\s*false/);
      expect(src).toContain("beforeSend: scrubErrorEvent");
      expect(src).toContain("beforeSendTransaction: scrubTransactionEvent");
      expect(src).toContain("beforeBreadcrumb: scrubBreadcrumb");
      // The pure common module stays the single authority: no runtime may
      // reimplement scrubbing locally and drift from the others.
      expect(src).toContain("@/lib/observability/sentry-scrub");
      expect(src).not.toContain("canonicalizeTokenPaths");
    });

    it(`${file} does not enable replay, logs, or PII-bearing capture`, () => {
      const src = readFileSync(join(ROOT, file), "utf8");
      // Session Replay records the live DOM (client names, treatment notes).
      expect(src).not.toMatch(/replaysSessionSampleRate:\s*(?!0)[0-9.]+/);
      expect(src).not.toMatch(/replaysOnErrorSampleRate:\s*(?!0)[0-9.]+/);
      expect(src).not.toMatch(/replayIntegration\s*\(/);
      // Sentry Logs would forward console output around the breadcrumb drop.
      expect(src).not.toMatch(/enableLogs:\s*true/);
      expect(src).not.toMatch(/sendDefaultPii:\s*true/);
      // No integration may re-enable bodies/headers/cookies.
      expect(src).not.toMatch(/maxRequestBodySize|sendRequestBodies/);
    });
  }
});
