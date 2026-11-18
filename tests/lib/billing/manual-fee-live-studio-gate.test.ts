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

describe("self-service cancellations and independent no-show release", () => {
  it("all studios may configure cancellation fees without an operator list", () => {
    for (const studio of [A, B, undefined]) expect(liveChargeReasonBlockMessage("late_cancellation_fee", true, studio)).toBeNull();
  });
  it("stale late-cancellation and combined env values cannot open no-show fees", () => {
    vi.stubEnv(LATE_CANCEL_FEE_LIVE_STUDIOS_ENV, A);
    vi.stubEnv(LEGACY_MANUAL_FEE_LIVE_STUDIOS_ENV, A);
    expect(liveChargeReasonBlockMessage("no_show_fee", true, A)).toBe(HELD);
  });
  it("no-show requires its own exact studio list and can be rolled back independently", () => {
    vi.stubEnv(NO_SHOW_FEE_LIVE_STUDIOS_ENV, A);
    expect(liveChargeReasonBlockMessage("no_show_fee", true, A)).toBeNull();
    expect(liveChargeReasonBlockMessage("no_show_fee", true, B)).toBe(HELD);
    expect(liveChargeReasonBlockMessage("no_show_fee", true)).toBe(HELD);
    vi.stubEnv(NO_SHOW_FEE_LIVE_STUDIOS_ENV, "");
    expect(liveChargeReasonBlockMessage("no_show_fee", true, A)).toBe(HELD);
  });
  it("malformed no-show lists fail closed", () => {
    for (const bad of ["*", "all", "true", `${A}x`, `${A};${B}`]) {
      vi.stubEnv(NO_SHOW_FEE_LIVE_STUDIOS_ENV, bad);
      expect(liveChargeReasonBlockMessage("no_show_fee", true, A)).toBe(HELD);
    }
  });
  it("session payments stay available; unknown live reasons stay closed; test mode is unchanged", () => {
    expect(isChargeReasonAllowedInLive("session_payment", A)).toBe(true);
    expect(isChargeReasonAllowedInLive("unknown", A)).toBe(false);
    for (const r of FEES) expect(liveChargeReasonBlockMessage(r, false, B)).toBeNull();
  });
});

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
