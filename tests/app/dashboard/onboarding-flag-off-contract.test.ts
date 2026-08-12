import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Flag-off contract for the onboarding-v2 dashboard integration (migration
// 0140). PRIME DIRECTIVE: while studios.onboarding_v2_enabled is not exactly
// true, the dashboard must render exactly as today — the legacy getting-started
// link / footer, NO wizard, NO onboarding signal queries. This source-level
// contract (mirrors the capacity flag-off contract style) pins that gating so a
// later edit can't silently leak the v2 experience to every studio.

const SRC = readFileSync(
  join(process.cwd(), "app/(app)/dashboard/page.tsx"),
  "utf8",
);
// Comment-strip so doc-comments can't satisfy or trip a grep.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("dashboard onboarding-v2 — default-OFF gating", () => {
  it("derives the gate with `=== true` (undefined flag is OFF) AND owner-only", () => {
    expect(CODE).toMatch(
      /const onboardingV2On\s*=\s*isOwner\s*&&\s*studio\.onboarding_v2_enabled\s*===\s*true/,
    );
    // Never a loose truthiness / !== false check that would enable pre-migration rows.
    expect(CODE).not.toMatch(/onboarding_v2_enabled\s*!==\s*false/);
    expect(CODE).not.toMatch(/studio\.onboarding_v2_enabled\s*\)/);
  });

  it("runs onboarding signal/state queries ONLY inside the flag-on branch", () => {
    // The only getOnboardingSignals/getOnboardingRow call sites must be guarded
    // by the onboardingV2On ternary — i.e. they appear after `onboardingV2On ?`.
    const guardIdx = CODE.indexOf("onboardingV2On");
    const signalsIdx = CODE.indexOf("getOnboardingSignals(");
    const rowIdx = CODE.indexOf("getOnboardingRow(");
    expect(signalsIdx).toBeGreaterThan(-1);
    expect(rowIdx).toBeGreaterThan(-1);
    // Both calls occur after the gate is computed (inside the conditional block).
    expect(signalsIdx).toBeGreaterThan(guardIdx);
    expect(rowIdx).toBeGreaterThan(guardIdx);
    // The onboarding const is a conditional (ternary) on the gate, not eager.
    expect(CODE).toMatch(/const onboarding\s*=\s*onboardingV2On\s*\?/);
  });

  it("renders the wizard/card surface ONLY when onboarding is present", () => {
    expect(CODE).toMatch(/\{onboarding\s*&&\s*\(/);
    expect(CODE).toContain("<OnboardingSurface");
  });

  it("gates the legacy getting-started card behind !onboardingV2On", () => {
    expect(CODE).toMatch(/\{!onboardingV2On\s*&&\s*!setupComplete\s*&&/);
  });

  it("the completed-setup footer is GONE from both paths (Chloe D3)", () => {
    // The flag-off contract is "renders exactly as the legacy path", and the
    // legacy path deliberately changed in this PR: a studio whose setup is
    // complete now sees no setup surface at all. Asserting the footer's absence
    // keeps this contract honest rather than quietly dropping the assertion —
    // if someone restores the footer, the flag-off path must fail here.
    expect(CODE).not.toMatch(/\{!onboardingV2On\s*&&\s*setupComplete\s*&&/);
    expect(CODE).not.toMatch(/Setup complete\./);
    // Flag-ON is unaffected: OnboardingSurface already hides its pinned card
    // once the model is complete, so neither system congratulates daily.
    expect(CODE).toContain("<OnboardingSurface");
  });

  it("still computes the legacy getting-started signals (OFF path unchanged)", () => {
    expect(CODE).toContain("buildGettingStarted(");
    expect(CODE).toContain("getGettingStartedSignals(");
  });
});
