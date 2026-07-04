import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PULSE_DELAY_DEFAULT,
  PULSE_DELAY_MIN,
  PULSE_DELAY_MAX,
  PULSE_DELAY_RANGE_ERROR,
} from "@/lib/constants";

// Feature B (Chloe charting feedback): when multiple high-frequency pulses are
// recorded (pulse_count > 1), a "Pulse delay" field appears (seconds, default
// 0.5, range 0.03–1.90) and saves onto electrolysis_entries.pulse_delay_seconds
// (migration 0102). Single-pulse entries are unaffected (null). Source-grep the
// wiring across both live forms, both write paths, and the display surface.

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const BLOCK_FORM = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
);
const SIMPLE_FORM = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/simplified-entry-form.tsx",
);
const BLOCK_ACTIONS = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
);
const ACTIONS = read("app/(app)/clients/[id]/sessions/[sessionId]/actions.ts");
const ENTRY_ROW = read("components/entry-row.tsx");

describe("pulse delay: constants", () => {
  it("default 0.5, range 0.03–1.90, and the exact range error message", () => {
    expect(PULSE_DELAY_DEFAULT).toBe(0.5);
    expect(PULSE_DELAY_MIN).toBe(0.03);
    expect(PULSE_DELAY_MAX).toBe(1.9);
    expect(PULSE_DELAY_RANGE_ERROR).toBe(
      "Pulse delay must be between 0.03 and 1.90 seconds.",
    );
  });
});

describe("pulse delay: field appears ONLY when multiple pulses selected", () => {
  it("block-setup-form gates the field on pulseCount > 1", () => {
    expect(BLOCK_FORM).toMatch(/Number\(draft\.pulseCount\) > 1 &&/);
    expect(BLOCK_FORM).toMatch(/Pulse delay/);
    expect(BLOCK_FORM).toMatch(/value=\{draft\.pulseDelay\}/);
  });
  it("simplified-entry-form gates the field on pulse_count > 1", () => {
    expect(SIMPLE_FORM).toMatch(/Number\(draft\.pulse_count\) > 1 &&/);
    expect(SIMPLE_FORM).toMatch(/Pulse delay/);
    expect(SIMPLE_FORM).toMatch(/value=\{draft\.pulse_delay\}/);
  });
});

describe("pulse delay: defaults to 0.5", () => {
  it("both forms seed the field with PULSE_DELAY_DEFAULT", () => {
    expect(BLOCK_FORM).toMatch(/pulseDelay:\s*String\(PULSE_DELAY_DEFAULT\)/);
    expect(SIMPLE_FORM).toMatch(/pulse_delay:\s*String\(PULSE_DELAY_DEFAULT\)/);
  });
});

describe("pulse delay: validation 0.03–1.90 with a clean message", () => {
  it("block-setup-form validates the range with the exact error", () => {
    expect(BLOCK_FORM).toMatch(
      /pd < PULSE_DELAY_MIN \|\| pd > PULSE_DELAY_MAX/,
    );
    expect(BLOCK_FORM).toMatch(
      /Pulse delay must be between 0\.03 and 1\.90 seconds\./,
    );
  });
  it("block-actions validateReadings enforces the range (server defense)", () => {
    expect(BLOCK_ACTIONS).toMatch(
      /d < PULSE_DELAY_MIN \|\| d > PULSE_DELAY_MAX/,
    );
    expect(BLOCK_ACTIONS).toMatch(/PULSE_DELAY_RANGE_ERROR/);
  });
  it("the FormData action path validates + throws the same message", () => {
    expect(ACTIONS).toMatch(
      /n < PULSE_DELAY_MIN \|\| n > PULSE_DELAY_MAX/,
    );
    expect(ACTIONS).toMatch(/throw new Error\(PULSE_DELAY_RANGE_ERROR\)/);
  });
});

describe("pulse delay: saved only when pulse_count > 1 (single-pulse unaffected)", () => {
  it("block-actions resolves null when pulse_count <= 1", () => {
    expect(BLOCK_ACTIONS).toMatch(/function resolvePulseDelaySeconds/);
    expect(BLOCK_ACTIONS).toMatch(/if \(count <= 1\) return null/);
    // Written at the entry insert/update sites.
    expect(BLOCK_ACTIONS).toMatch(
      /pulse_delay_seconds: resolvePulseDelaySeconds\(readings\)/,
    );
  });
  it("the FormData action path resolves null when pulseCount <= 1", () => {
    expect(ACTIONS).toMatch(/if \(pulseCount <= 1\) return null/);
    expect(ACTIONS).toMatch(/pulse_delay_seconds: pulseDelaySeconds/);
  });
});

describe("pulse delay: displays in previous-session / treatment memory", () => {
  it("entry-row shows the delay only when pulse_count > 1 + value present", () => {
    expect(ENTRY_ROW).toMatch(
      /entry\.pulse_count > 1 &&\s*\n?\s*entry\.pulse_delay_seconds != null/,
    );
    expect(ENTRY_ROW).toMatch(/toFixed\(2\)\}s delay/);
    // Pushed alongside every pulse-count render path.
    expect(
      (ENTRY_ROW.match(/push\(pulseDelayLabel\)/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });
});
