import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  LIVE_MANUAL_FEE_HOLD_MESSAGE,
  isChargeReasonAllowedInLive,
  liveChargeReasonBlockMessage,
} from "@/lib/billing/live-charge-reason-allowlist";

// Launch hard hold: LIVE-mode charging is session-payments-only; manual
// no-show / late-cancellation fees are blocked server-side (prepare AND
// execute). Test mode is unaffected. This suite proves the pure allowlist
// logic + pins the integration points (prepare eligibility, execute action,
// UI copy) and that session_payment is NOT gated.

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}

describe("allowlist logic", () => {
  it("session_payment is allowed in LIVE (and test)", () => {
    expect(isChargeReasonAllowedInLive("session_payment")).toBe(true);
    expect(liveChargeReasonBlockMessage("session_payment", true)).toBeNull();
    expect(liveChargeReasonBlockMessage("session_payment", false)).toBeNull();
  });

  it("no_show_fee is BLOCKED in LIVE with the exact hold message", () => {
    expect(isChargeReasonAllowedInLive("no_show_fee")).toBe(false);
    expect(liveChargeReasonBlockMessage("no_show_fee", true)).toBe(
      LIVE_MANUAL_FEE_HOLD_MESSAGE,
    );
  });

  it("late_cancellation_fee is BLOCKED in LIVE with the exact hold message", () => {
    expect(isChargeReasonAllowedInLive("late_cancellation_fee")).toBe(false);
    expect(liveChargeReasonBlockMessage("late_cancellation_fee", true)).toBe(
      LIVE_MANUAL_FEE_HOLD_MESSAGE,
    );
  });

  it("TEST mode blocks nothing (existing manual-fee test behavior preserved)", () => {
    expect(liveChargeReasonBlockMessage("no_show_fee", false)).toBeNull();
    expect(liveChargeReasonBlockMessage("late_cancellation_fee", false)).toBeNull();
    expect(liveChargeReasonBlockMessage("session_payment", false)).toBeNull();
  });

  it("defaults to blocked in LIVE for any non-allowlisted reason", () => {
    expect(liveChargeReasonBlockMessage("some_future_reason", true)).toBe(
      LIVE_MANUAL_FEE_HOLD_MESSAGE,
    );
  });

  it("exposes the exact required user-facing message", () => {
    expect(LIVE_MANUAL_FEE_HOLD_MESSAGE).toBe(
      "Live cancellation and no-show fee charging is on hold for this launch. Use session payments only unless manual fees are explicitly approved.",
    );
  });
});

describe("prepare gate: manual-fee eligibility", () => {
  const src = read("lib/billing/manual-fee-eligibility.ts");
  it("pushes the live hold into the eligibility blocking reasons", () => {
    expect(src).toMatch(/from "@\/lib\/billing\/live-charge-reason-allowlist"/);
    expect(src).toMatch(/const liveHold = liveChargeReasonBlockMessage\(feeChargeReason, livemode\)/);
    expect(src).toMatch(/if \(liveHold\) \{\s*\n?\s*reasons\.push\(liveHold\)/);
  });
});

describe("execute gate: manual-fee charge action (defense-in-depth)", () => {
  const src = read("app/(app)/calendar/[id]/manual-fee-actions.ts");
  it("re-checks the hold before calling the charge executor and blocks", () => {
    const gate = src.indexOf("liveChargeReasonBlockMessage");
    const exec = src.indexOf("runSessionPaymentCharge({");
    expect(gate).toBeGreaterThan(-1);
    // The gate must appear BEFORE the executor call.
    expect(gate).toBeLessThan(exec);
    expect(src).toMatch(/\.select\("charge_reason"\)/);
    expect(src).toMatch(/return \{ ok: false, outcome: "blocked", error: hold \}/);
  });

  it("does NOT change the session-payment executor itself (no Stripe SDK / no charge-logic edit)", () => {
    const charge = read("lib/billing/session-payment-charge.ts");
    // The shared executor is untouched by this PR, it does not import the
    // manual-fee allowlist (session payments are allowed everywhere).
    expect(charge).not.toMatch(/live-charge-reason-allowlist/);
  });
});

describe("session payments remain allowed (not gated by the hold)", () => {
  it("session-payment eligibility + prepare action do NOT import the fee hold", () => {
    expect(read("lib/billing/session-payment-eligibility.ts")).not.toMatch(
      /live-charge-reason-allowlist/,
    );
    expect(
      read("app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts"),
    ).not.toMatch(/live-charge-reason-allowlist/);
  });
});

describe("UI: fee settings reflect the hold and stay configurable", () => {
  const src = read("app/(app)/settings/payments/FeeAmountsCard.tsx");
  it("says live manual fee charging is on hold, money not charged, session payments unaffected", () => {
    expect(src).toMatch(/Live manual fee charging is currently on hold for this launch/);
    expect(src).toMatch(/Money is not charged here\./);
    expect(src).toMatch(/Session payments are\s*\n?\s*unaffected\./);
  });
  it("fee amounts remain configurable (inputs + save action intact)", () => {
    expect(src).toMatch(/late_cancel_fee_cents|no_show_fee_cents|type="number"|inputMode/);
    expect(src).toMatch(/<form/);
  });
});
