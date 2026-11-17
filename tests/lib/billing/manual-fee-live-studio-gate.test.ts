import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  LIVE_MANUAL_FEE_HOLD_MESSAGE,
  LATE_CANCEL_FEE_LIVE_STUDIOS_ENV,
  LEGACY_MANUAL_FEE_LIVE_STUDIOS_ENV,
  NO_SHOW_FEE_LIVE_STUDIOS_ENV,
  isChargeReasonAllowedInLive,
  isManualFeeLiveEnabledForStudio,
  liveChargeReasonBlockMessage,
  parseManualFeeLiveStudios,
} from "@/lib/billing/live-charge-reason-allowlist";

// Per-studio, per-reason live enablement for the two manual fees (route (a): env
// allowlists, no migration). Synthetic ids only. The default is EMPTY, so a held fee stays held.

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const FEES = ["no_show_fee", "late_cancellation_fee"] as const;

afterEach(() => vi.unstubAllEnvs());

describe("parseManualFeeLiveStudios", () => {
  it("unset, blank and non-string values give the empty set", () => {
    for (const v of [undefined, null, "", "   ", ",,,"]) {
      expect(parseManualFeeLiveStudios(v as string | undefined).size).toBe(0);
    }
  });
  it("keeps plain ids, trims, lower-cases, and drops anything that is not a UUID", () => {
    const set = parseManualFeeLiveStudios(` ${A.toUpperCase()} , ${B},*,all,true,11111111,${A}x`);
    expect([...set].sort()).toEqual([A, B].sort());
  });
  it("a wildcard or a name can never match a studio", () => {
    for (const r of FEES) {
      expect(isManualFeeLiveEnabledForStudio(r, A, "*")).toBe(false);
      expect(isManualFeeLiveEnabledForStudio(r, A, "all")).toBe(false);
    }
  });
});

const HELD = LIVE_MANUAL_FEE_HOLD_MESSAGE;

describe("per-reason live gate (LIVE mode)", () => {
  it("with both variables unset every fee is held for every studio, as before", () => {
    for (const r of FEES) {
      expect(liveChargeReasonBlockMessage(r, true, A)).toBe(HELD);
      expect(liveChargeReasonBlockMessage(r, true)).toBe(HELD);
    }
  });
  it("the late-cancel list opens late_cancellation_fee for a listed studio ONLY, and holds no_show_fee", () => {
    vi.stubEnv(LATE_CANCEL_FEE_LIVE_STUDIOS_ENV, A);
    expect(liveChargeReasonBlockMessage("late_cancellation_fee", true, A)).toBeNull();
    expect(liveChargeReasonBlockMessage("late_cancellation_fee", true, B)).toBe(HELD);
    expect(liveChargeReasonBlockMessage("no_show_fee", true, A)).toBe(HELD);
    expect(isChargeReasonAllowedInLive("no_show_fee", A)).toBe(false);
  });
  it("the no-show list opens no_show_fee for a listed studio ONLY, and holds late_cancellation_fee", () => {
    vi.stubEnv(NO_SHOW_FEE_LIVE_STUDIOS_ENV, A);
    expect(liveChargeReasonBlockMessage("no_show_fee", true, A)).toBeNull();
    expect(liveChargeReasonBlockMessage("no_show_fee", true, B)).toBe(HELD);
    expect(liveChargeReasonBlockMessage("late_cancellation_fee", true, A)).toBe(HELD);
  });
  it("both lists set: each studio gets exactly its own reason, nothing is shared", () => {
    vi.stubEnv(LATE_CANCEL_FEE_LIVE_STUDIOS_ENV, A);
    vi.stubEnv(NO_SHOW_FEE_LIVE_STUDIOS_ENV, B);
    expect(liveChargeReasonBlockMessage("late_cancellation_fee", true, A)).toBeNull();
    expect(liveChargeReasonBlockMessage("no_show_fee", true, A)).toBe(HELD);
    expect(liveChargeReasonBlockMessage("no_show_fee", true, B)).toBeNull();
    expect(liveChargeReasonBlockMessage("late_cancellation_fee", true, B)).toBe(HELD);
  });
  it("the same studio in both lists opens both reasons", () => {
    vi.stubEnv(LATE_CANCEL_FEE_LIVE_STUDIOS_ENV, A);
    vi.stubEnv(NO_SHOW_FEE_LIVE_STUDIOS_ENV, A);
    for (const r of FEES) expect(liveChargeReasonBlockMessage(r, true, A)).toBeNull();
  });
  it("the LEGACY single variable opens NOTHING, alone or beside the new ones", () => {
    vi.stubEnv(LEGACY_MANUAL_FEE_LIVE_STUDIOS_ENV, `${A},${B}`);
    for (const r of FEES) {
      expect(liveChargeReasonBlockMessage(r, true, A)).toBe(HELD);
      expect(liveChargeReasonBlockMessage(r, true, B)).toBe(HELD);
    }
    vi.stubEnv(LATE_CANCEL_FEE_LIVE_STUDIOS_ENV, A);
    expect(liveChargeReasonBlockMessage("late_cancellation_fee", true, A)).toBeNull();
    expect(liveChargeReasonBlockMessage("no_show_fee", true, A)).toBe(HELD);
    expect(liveChargeReasonBlockMessage("late_cancellation_fee", true, B)).toBe(HELD);
  });
  it("malformed values open nothing for that reason (and never the other one)", () => {
    for (const bad of ["*", "all", "true", "1", "11111111", `${A}x`, `x${A}`, ` , ,`, "{}", `${A};${B}`]) {
      vi.stubEnv(LATE_CANCEL_FEE_LIVE_STUDIOS_ENV, bad);
      vi.stubEnv(NO_SHOW_FEE_LIVE_STUDIOS_ENV, bad);
      for (const r of FEES) expect(liveChargeReasonBlockMessage(r, true, A)).toBe(HELD);
    }
  });
  it("a mixed list keeps the valid ids and drops the rest", () => {
    vi.stubEnv(LATE_CANCEL_FEE_LIVE_STUDIOS_ENV, `junk, ${B.toUpperCase()} ,*`);
    expect(liveChargeReasonBlockMessage("late_cancellation_fee", true, B)).toBeNull();
    expect(liveChargeReasonBlockMessage("late_cancellation_fee", true, A)).toBe(HELD);
  });
  it("no studio id (an old two-argument call) is held even when a studio is listed", () => {
    vi.stubEnv(LATE_CANCEL_FEE_LIVE_STUDIOS_ENV, A);
    vi.stubEnv(NO_SHOW_FEE_LIVE_STUDIOS_ENV, A);
    for (const r of FEES) expect(liveChargeReasonBlockMessage(r, true)).toBe(HELD);
    expect(liveChargeReasonBlockMessage(r0(), true, null)).toBe(HELD);
    expect(liveChargeReasonBlockMessage(r0(), true, "")).toBe(HELD);
  });
  it("session_payment is unaffected either way, and an unknown reason is never opened by a list", () => {
    for (const env of ["", A]) {
      vi.stubEnv(LATE_CANCEL_FEE_LIVE_STUDIOS_ENV, env);
      vi.stubEnv(NO_SHOW_FEE_LIVE_STUDIOS_ENV, env);
      expect(liveChargeReasonBlockMessage("session_payment", true, A)).toBeNull();
      expect(liveChargeReasonBlockMessage("session_payment", true, B)).toBeNull();
      expect(liveChargeReasonBlockMessage("some_future_reason", true, A)).toBe(HELD);
      expect(isChargeReasonAllowedInLive("some_future_reason", A)).toBe(false);
    }
  });
  it("TEST mode blocks nothing whatever the lists say", () => {
    for (const r of FEES) expect(liveChargeReasonBlockMessage(r, false, B)).toBeNull();
  });
  it("a late-cancel-only studio sees the no-show card held with the SAME hold message", () => {
    vi.stubEnv(LATE_CANCEL_FEE_LIVE_STUDIOS_ENV, A);
    expect(liveChargeReasonBlockMessage("no_show_fee", true, A)).toBe(liveChargeReasonBlockMessage("late_cancellation_fee", true, B));
  });
  it("the lists are read at call time, so removing a studio disables it at once (rollback)", () => {
    vi.stubEnv(LATE_CANCEL_FEE_LIVE_STUDIOS_ENV, A);
    expect(liveChargeReasonBlockMessage("late_cancellation_fee", true, A)).toBeNull();
    vi.stubEnv(LATE_CANCEL_FEE_LIVE_STUDIOS_ENV, "");
    expect(liveChargeReasonBlockMessage("late_cancellation_fee", true, A)).toBe(HELD);
  });
});

function r0() {
  return "late_cancellation_fee";
}

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}

describe("both call sites pass the studio, and the list never reaches the browser", () => {
  it("prepare (eligibility) passes the studio id", () => {
    expect(read("lib/billing/manual-fee-eligibility.ts")).toMatch(/liveChargeReasonBlockMessage\(feeChargeReason, livemode, args\.studioId\)/);
  });
  it("execute passes the studio of the signed-in owner, not a posted value", () => {
    const src = read("app/(app)/calendar/[id]/manual-fee-actions.ts");
    const call = src.slice(src.indexOf("liveChargeReasonBlockMessage("));
    expect(call.slice(0, 200)).toMatch(/studioId/);
    expect(src).not.toMatch(/formData\.get\("studio_id"\)/);
  });
  it("the variable name is server-only (no NEXT_PUBLIC_ prefix) and is read in no client file", () => {
    for (const name of [LATE_CANCEL_FEE_LIVE_STUDIOS_ENV, NO_SHOW_FEE_LIVE_STUDIOS_ENV, LEGACY_MANUAL_FEE_LIVE_STUDIOS_ENV]) {
      expect(name.startsWith("NEXT_PUBLIC_")).toBe(false);
      expect(read("app/(app)/calendar/[id]/ManualFeeChargeCard.tsx")).not.toContain(name);
    }
  });
  it("the legacy variable is never READ: its name appears only as a constant, and the one env read is the per-reason name", () => {
    const src = read("lib/billing/live-charge-reason-allowlist.ts");
    expect(src.match(/process\.env\b/g)?.length).toBe(1);
    expect(src).toMatch(/process\.env\[name\]/);
    expect(src.match(/LEGACY_MANUAL_FEE_LIVE_STUDIOS_ENV/g)?.length).toBe(1);
  });
  it("the allowlist module holds no studio id literal", () => {
    expect(read("lib/billing/live-charge-reason-allowlist.ts")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

describe("G1: the shared runner enforces the live gate itself", () => {
  const SRC = readFileSync(path.resolve(__dirname, "../../../lib/billing/session-payment-charge.ts"), "utf8");
  const RUN = SRC.slice(SRC.indexOf("export async function runSessionPaymentCharge"));
  it("calls liveChargeReasonBlockMessage with the attempt's reason, the deployment mode and the studio, and returns live_mode_blocked", () => {
    expect(RUN).toMatch(/liveChargeReasonBlockMessage\(\s*attemptRow\.charge_reason\s*,\s*livemode\s*,\s*args\.studioId\s*\)/);
    expect(RUN).toMatch(/if \(liveHold\) \{\s*return \{ ok: false, outcome: "live_mode_blocked"/);
  });
  it("the gate runs BEFORE the claim and before any Stripe call", () => {
    const gate = RUN.indexOf("liveChargeReasonBlockMessage(");
    for (const later of ["claim_session_payment_charge_attempt", "paymentIntents.create", "paymentIntents.retrieve"]) {
      const at = RUN.indexOf(later);
      if (at !== -1) expect(gate).toBeLessThan(at);
    }
  });
});
