import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// Guards the PostHog analytics privacy posture for a clinical app
// (P1-ANALYTICS-01/-02/-03). Behavioral coverage of the boundary itself lives
// in tests/lib/analytics/client-boundary.test.ts and server-capture.test.ts;
// this file pins the CONFIGURATION so a wizard re-run or refactor cannot
// silently regress it.

const CLIENT = readFileSync(
  join(process.cwd(), "instrumentation-client.ts"),
  "utf8",
);
// Scope assertions to the PostHog init (Sentry.init is earlier in the file).
const POSTHOG = CLIENT.slice(CLIENT.indexOf("posthog.init("));

describe("PostHog privacy config", () => {
  it("keeps session recording disabled (never record the live DOM)", () => {
    expect(POSTHOG).toMatch(/disable_session_recording:\s*true/);
  });

  it("keeps surveys disabled (no remotely-injected PostHog UI)", () => {
    expect(POSTHOG).toMatch(/disable_surveys:\s*true/);
  });

  it("does not double-capture exceptions (Sentry owns that, with scrubbing)", () => {
    expect(POSTHOG).toMatch(/capture_exceptions:\s*false/);
  });

  it("scopes autocapture to the explicit marketing surface allowlist", () => {
    expect(POSTHOG).toMatch(/url_allowlist:\s*AUTOCAPTURE_URL_ALLOWLIST/);
  });

  it("wires the before_send guarantee layer", () => {
    expect(POSTHOG).toMatch(/before_send:\s*guardOutgoingEvent/);
  });

  it("keeps text masking + PII attribute ignorelist for the allowed surface", () => {
    expect(POSTHOG).toMatch(/mask_all_text:\s*true/);
    expect(POSTHOG).toMatch(/element_attribute_ignorelist/);
    for (const attr of ["aria-label", "title", "alt", "placeholder"]) {
      expect(POSTHOG, `${attr} not in ignorelist`).toContain(`"${attr}"`);
    }
    // The broken nested form (mask_all_text is NOT an AutocaptureConfig key)
    // must not regress in.
    expect(POSTHOG).not.toMatch(/autocapture:\s*\{[^}]*mask_all_text/s);
  });

  it("NEVER enables autocapture without the allowlist boundary", () => {
    // Bare `autocapture: true` (global, boundary-less) is forbidden.
    expect(POSTHOG).not.toMatch(/autocapture:\s*true/);
    const enabled = /autocapture:\s*\{/.test(POSTHOG);
    if (enabled) {
      expect(POSTHOG).toMatch(/url_allowlist/);
      expect(POSTHOG).toMatch(/before_send/);
      expect(POSTHOG).toMatch(/mask_all_text:\s*true/);
    }
  });
});

describe("server-side analytics goes through the safe wrapper only", () => {
  it("no app code uses getPostHogClient directly (P1/P2-ANALYTICS-03)", () => {
    // The low-level client may be imported ONLY by the safe dispatch module.
    const out = execSync(
      "grep -rl 'posthog-server' app lib --include='*.ts' --include='*.tsx' || true",
      { cwd: process.cwd(), encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((f) => f !== "lib/posthog-server.ts")
      .filter((f) => f !== "lib/analytics/server.ts");
    expect(out, `direct posthog-server imports: ${out.join(", ")}`).toEqual([]);
  });

  it("no app code awaits posthog.flush() in a request path", () => {
    const out = execSync(
      "grep -rln 'posthog.flush' app --include='*.ts' --include='*.tsx' || true",
      { cwd: process.cwd(), encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(out, `inline flush callers: ${out.join(", ")}`).toEqual([]);
  });
});
