import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  LIVE_MANUAL_FEE_HOLD_MESSAGE,
  MANUAL_FEE_LIVE_STUDIOS_ENV,
  isChargeReasonAllowedInLive,
  isManualFeeLiveEnabledForStudio,
  liveChargeReasonBlockMessage,
  parseManualFeeLiveStudios,
} from "@/lib/billing/live-charge-reason-allowlist";

// Per-studio live enablement for the two manual fees (route (a): an env allowlist, no
// migration). Synthetic ids only. The default is EMPTY, so a held fee stays held.

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
    expect(isManualFeeLiveEnabledForStudio(A, "*")).toBe(false);
    expect(isManualFeeLiveEnabledForStudio(A, "all")).toBe(false);
  });
});

describe("the live gate with the allowlist (LIVE mode)", () => {
  it("with the variable unset every fee is held for every studio, as before", () => {
    vi.stubEnv(MANUAL_FEE_LIVE_STUDIOS_ENV, "");
    for (const r of FEES) {
      expect(liveChargeReasonBlockMessage(r, true, A)).toBe(LIVE_MANUAL_FEE_HOLD_MESSAGE);
      expect(liveChargeReasonBlockMessage(r, true)).toBe(LIVE_MANUAL_FEE_HOLD_MESSAGE);
    }
  });
  it("a listed studio may run both fee reasons; an unlisted studio is still held", () => {
    vi.stubEnv(MANUAL_FEE_LIVE_STUDIOS_ENV, A);
    for (const r of FEES) {
      expect(liveChargeReasonBlockMessage(r, true, A)).toBeNull();
      expect(liveChargeReasonBlockMessage(r, true, B)).toBe(LIVE_MANUAL_FEE_HOLD_MESSAGE);
    }
  });
  it("no studio id (an old two-argument call) is held even when a studio is listed", () => {
    vi.stubEnv(MANUAL_FEE_LIVE_STUDIOS_ENV, A);
    for (const r of FEES) expect(liveChargeReasonBlockMessage(r, true)).toBe(LIVE_MANUAL_FEE_HOLD_MESSAGE);
    expect(liveChargeReasonBlockMessage(r0(), true, null)).toBe(LIVE_MANUAL_FEE_HOLD_MESSAGE);
    expect(liveChargeReasonBlockMessage(r0(), true, "")).toBe(LIVE_MANUAL_FEE_HOLD_MESSAGE);
  });
  it("session_payment is unaffected either way, and an unknown reason is never opened by the list", () => {
    for (const env of ["", A]) {
      vi.stubEnv(MANUAL_FEE_LIVE_STUDIOS_ENV, env);
      expect(liveChargeReasonBlockMessage("session_payment", true, A)).toBeNull();
      expect(liveChargeReasonBlockMessage("session_payment", true, B)).toBeNull();
      expect(liveChargeReasonBlockMessage("some_future_reason", true, A)).toBe(LIVE_MANUAL_FEE_HOLD_MESSAGE);
      expect(isChargeReasonAllowedInLive("some_future_reason", A)).toBe(false);
    }
  });
  it("TEST mode blocks nothing whatever the list says", () => {
    vi.stubEnv(MANUAL_FEE_LIVE_STUDIOS_ENV, "");
    for (const r of FEES) expect(liveChargeReasonBlockMessage(r, false, B)).toBeNull();
  });
  it("the list is read at call time, so removing a studio disables it at once (rollback)", () => {
    vi.stubEnv(MANUAL_FEE_LIVE_STUDIOS_ENV, A);
    expect(liveChargeReasonBlockMessage("no_show_fee", true, A)).toBeNull();
    vi.stubEnv(MANUAL_FEE_LIVE_STUDIOS_ENV, "");
    expect(liveChargeReasonBlockMessage("no_show_fee", true, A)).toBe(LIVE_MANUAL_FEE_HOLD_MESSAGE);
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
    expect(MANUAL_FEE_LIVE_STUDIOS_ENV.startsWith("NEXT_PUBLIC_")).toBe(false);
    expect(read("app/(app)/calendar/[id]/ManualFeeChargeCard.tsx")).not.toContain(MANUAL_FEE_LIVE_STUDIOS_ENV);
  });
  it("the allowlist module holds no studio id literal", () => {
    expect(read("lib/billing/live-charge-reason-allowlist.ts")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});
