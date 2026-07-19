import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// Pins the PostHog CONFIGURATION posture (P1-ANALYTICS-01/-02/-03 + scenario
// 14). Behavioral coverage of the boundary is in tests/lib/analytics/*. This
// file guards that a wizard re-run or refactor cannot silently regress the
// init switches or reintroduce browser identify / inline flush.

const CLIENT = readFileSync(
  join(process.cwd(), "instrumentation-client.ts"),
  "utf8",
);
const POSTHOG = CLIENT.slice(CLIENT.indexOf("posthog.init("));

describe("PostHog init posture (explicit, not default-reliant)", () => {
  it("session recording, surveys, exceptions, heatmaps, performance are OFF", () => {
    expect(POSTHOG).toMatch(/disable_session_recording:\s*true/);
    expect(POSTHOG).toMatch(/disable_surveys:\s*true/);
    expect(POSTHOG).toMatch(/capture_exceptions:\s*false/);
    expect(POSTHOG).toMatch(/capture_heatmaps:\s*false/);
    expect(POSTHOG).toMatch(/capture_performance:\s*false/);
  });

  it("pageview/pageleave are set explicitly (not left to SDK defaults)", () => {
    expect(POSTHOG).toMatch(/capture_pageview:\s*(true|false)/);
    expect(POSTHOG).toMatch(/capture_pageleave:\s*(true|false)/);
  });

  it("before_send is the authoritative browser-event guard", () => {
    expect(POSTHOG).toMatch(/before_send:\s*guardBrowserEvent/);
  });

  it("autocapture is scoped to the marketing allowlist with PII attrs ignored", () => {
    expect(POSTHOG).toMatch(/url_allowlist:\s*AUTOCAPTURE_URL_ALLOWLIST/);
    expect(POSTHOG).toMatch(/mask_all_text:\s*true/);
    expect(POSTHOG).toMatch(/element_attribute_ignorelist/);
  });

  it("has no bare global autocapture:true and no nested mask_all_text", () => {
    expect(POSTHOG).not.toMatch(/autocapture:\s*true/);
    expect(POSTHOG).not.toMatch(/autocapture:\s*\{[^}]*mask_all_text/s);
  });
});

describe("identification is server-side only", () => {
  it("the client PostHogIdentify component no longer exists", () => {
    expect(existsSync(join(process.cwd(), "app/_components/PostHogIdentify.tsx"))).toBe(false);
  });
  it("no app code calls posthog.identify in the browser", () => {
    const out = execSync(
      "grep -rln 'posthog.identify' app --include='*.ts' --include='*.tsx' || true",
      { cwd: process.cwd(), encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(out, `browser identify callers: ${out.join(", ")}`).toEqual([]);
  });
});

describe("server-side analytics goes through the safe wrapper only", () => {
  it("no app code imports posthog-server directly", () => {
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

  it("no capture site passes a raw distinctId (must use the discriminated actor)", () => {
    const out = execSync(
      "grep -rln 'distinctId:' app --include='*.ts' --include='*.tsx' || true",
      { cwd: process.cwd(), encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(out, `raw distinctId callers: ${out.join(", ")}`).toEqual([]);
  });
});
