import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guards the PostHog analytics privacy posture for a clinical app. The critical
// invariant: autocapture must never be enabled without top-level text masking,
// and the masking must be the real (autocapture) config path, not the
// silently-ineffective nested form.

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

  it("does not double-capture exceptions (Sentry owns that, with scrubbing)", () => {
    expect(POSTHOG).toMatch(/capture_exceptions:\s*false/);
  });

  it("masks autocapture text via the TOP-LEVEL mask_all_text key", () => {
    expect(POSTHOG).toMatch(/mask_all_text:\s*true/);
    // The broken form `autocapture: { mask_all_text: ... }` is NOT a valid
    // AutocaptureConfig key and would leave element textContent UNMASKED.
    expect(POSTHOG).not.toMatch(/autocapture:\s*\{[^}]*mask_all_text/s);
  });

  it("drops human-readable PII element attributes from autocapture", () => {
    expect(POSTHOG).toMatch(/element_attribute_ignorelist/);
    for (const attr of ["aria-label", "title", "alt", "placeholder"]) {
      expect(POSTHOG, `${attr} not in ignorelist`).toContain(`"${attr}"`);
    }
  });

  it("NEVER enables autocapture without text masking (the core invariant)", () => {
    const autocaptureEnabled =
      /autocapture:\s*true/.test(POSTHOG) ||
      /autocapture:\s*\{/.test(POSTHOG); // an AutocaptureConfig object also = enabled
    if (autocaptureEnabled) {
      expect(
        POSTHOG,
        "autocapture is enabled but mask_all_text:true is missing — text would be captured",
      ).toMatch(/mask_all_text:\s*true/);
    }
  });
});
