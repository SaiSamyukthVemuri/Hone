import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Review 3777890257: ENDPOINT AUTHORITY for the manual-fee execution action.
//
// THE BYPASS THIS PROVES CLOSED
// `runSessionPaymentCharge` has exactly two runtime callers. The session-payment
// action gates on current authoritative pricing; the manual-fee action did not,
// and it decided what it was willing to execute using the GLOBAL live-mode
// allowlist. That allowlist deliberately permits `session_payment` (ordinary
// live session payments are allowed), so an authenticated caller could post a
// ready `session_payment` attempt id to the manual-fee action and reach the
// shared runner with NO pricing permission check, reopening the stale
// prepared-amount bypass, in TEST mode as well as live.
//
// These tests invoke the REAL action and assert on runner call counts. The
// live hard-hold helper is NOT mocked: M4 exercises the real one.

const practitioner = { id: "prac-1", role: "owner", active: true };
const studio = { id: "studio-1", timezone: "America/Toronto" };

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner, studio }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const attemptLookup: {
  row: { charge_reason: string | null } | null;
  error: unknown;
} = { row: { charge_reason: "no_show_fee" }, error: null };

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      q.select = chain;
      q.eq = chain;
      q.maybeSingle = async () => ({
        data: attemptLookup.row,
        error: attemptLookup.error,
      });
      return q;
    },
  }),
}));

let livemode = false;
vi.mock("@/lib/stripe/server", () => ({
  inferStripeLivemode: () => livemode,
}));

// THE ORACLE.
const runCharge = vi.fn(async (_args: Record<string, unknown>) => ({
  ok: true as const,
  outcome: "charged" as const,
  attemptId: "attempt-1",
  stripePaymentIntentId: "pi_1",
  stripeChargeId: "ch_1",
}));

vi.mock("@/lib/billing/session-payment-charge", () => ({
  runSessionPaymentCharge: (args: Record<string, unknown>) => runCharge(args),
}));

import { chargeManualFeeAttemptAction } from "@/app/(app)/calendar/[id]/manual-fee-actions";

function form(): FormData {
  const fd = new FormData();
  fd.set("attempt_id", "attempt-1");
  fd.set("confirm_charge", "true");
  // A caller cannot declare which flow they want; the reason is read from the
  // row. Setting it here must change nothing.
  fd.set("charge_reason", "no_show_fee");
  return fd;
}

beforeEach(() => {
  runCharge.mockClear();
  attemptLookup.row = { charge_reason: "no_show_fee" };
  attemptLookup.error = null;
  livemode = false;
});
afterEach(() => vi.clearAllMocks());

describe("manual-fee endpoint executes ONLY manual-fee attempts", () => {
  it("M1 a ready session_payment attempt is refused, in TEST mode too", async () => {
    attemptLookup.row = { charge_reason: "session_payment" };
    const res = await chargeManualFeeAttemptAction(form());
    expect(res.ok).toBe(false);
    expect(runCharge).toHaveBeenCalledTimes(0);
  });

  it("M2 no_show_fee in TEST mode still executes", async () => {
    attemptLookup.row = { charge_reason: "no_show_fee" };
    const res = await chargeManualFeeAttemptAction(form());
    expect(runCharge).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
  });

  it("M3 late_cancellation_fee in TEST mode still executes", async () => {
    attemptLookup.row = { charge_reason: "late_cancellation_fee" };
    const res = await chargeManualFeeAttemptAction(form());
    expect(runCharge).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
  });

  it("M4 no_show_fee in LIVE mode remains held by the real hard hold", async () => {
    livemode = true;
    attemptLookup.row = { charge_reason: "no_show_fee" };
    const res = await chargeManualFeeAttemptAction(form());
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ outcome: "blocked" });
    expect(runCharge).toHaveBeenCalledTimes(0);
  });

  it("M5 attempt lookup DB error -> blocked, runner never called", async () => {
    attemptLookup.row = null;
    attemptLookup.error = { message: "boom" };
    const res = await chargeManualFeeAttemptAction(form());
    expect(res.ok).toBe(false);
    expect(runCharge).toHaveBeenCalledTimes(0);
  });

  it("M5b a read ERROR blocks even when a row IS returned", async () => {
    // The distinguishing case. M5 alone cannot prove the error is honoured,
    // because a null row blocks anyway, a mutant that drops the error check
    // still passes it. If the driver reports an error, the row is not
    // trustworthy no matter how valid it looks.
    attemptLookup.row = { charge_reason: "no_show_fee" };
    attemptLookup.error = { message: "boom" };
    const res = await chargeManualFeeAttemptAction(form());
    expect(res.ok).toBe(false);
    expect(runCharge).toHaveBeenCalledTimes(0);
  });

  it("M6 attempt not found -> blocked with generic copy, runner never called", async () => {
    attemptLookup.row = null;
    const res = await chargeManualFeeAttemptAction(form());
    expect(res.ok).toBe(false);
    expect(runCharge).toHaveBeenCalledTimes(0);
    // Nothing about the attempt's existence or ownership leaks.
    const msg = "error" in res ? res.error : "";
    expect(msg).not.toMatch(/session_payment|charge_reason|studio|attempt-1/i);
  });

  it("M7 an unknown/unsupported charge reason is refused", async () => {
    for (const reason of ["refund", "subscription", "", "SESSION_PAYMENT"]) {
      runCharge.mockClear();
      attemptLookup.row = { charge_reason: reason };
      const res = await chargeManualFeeAttemptAction(form());
      expect(res.ok, reason).toBe(false);
      expect(runCharge, reason).toHaveBeenCalledTimes(0);
    }
    // and a null reason
    runCharge.mockClear();
    attemptLookup.row = { charge_reason: null };
    const res = await chargeManualFeeAttemptAction(form());
    expect(res.ok).toBe(false);
    expect(runCharge).toHaveBeenCalledTimes(0);
  });

  it("M8 the GLOBAL live allowlist permitting session_payment does not admit it here", async () => {
    // Both modes: endpoint authority is independent of deployment mode.
    for (const mode of [false, true]) {
      livemode = mode;
      runCharge.mockClear();
      attemptLookup.row = { charge_reason: "session_payment" };
      const res = await chargeManualFeeAttemptAction(form());
      expect(res.ok, `livemode=${mode}`).toBe(false);
      expect(runCharge, `livemode=${mode}`).toHaveBeenCalledTimes(0);
    }
    // Control: the global allowlist really does permit session_payment in
    // live, which is exactly why relying on it here was wrong.
    const { liveChargeReasonBlockMessage } = await import(
      "@/lib/billing/live-charge-reason-allowlist"
    );
    expect(liveChargeReasonBlockMessage("session_payment", true)).toBeNull();
  });
});

describe("execution entry-point census", () => {
  // The endpoint-authority argument is only sound while the set of runtime
  // callers is known. If a THIRD caller appears, its authority has not been
  // reasoned about and this must fail loudly rather than be widened by regex.
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next" || name === ".git") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  }

  it("runSessionPaymentCharge has exactly TWO runtime call sites, both documented", () => {
    const roots = ["app", "lib", "components"];
    const callers: string[] = [];
    for (const root of roots) {
      for (const file of walk(join(process.cwd(), root))) {
        const src = readFileSync(file, "utf8")
          .split("\n")
          .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
          .join("\n");
        // a CALL, not the declaration or an import
        const calls = src.match(/(?<!function )runSessionPaymentCharge\(/g) ?? [];
        const isDeclaration = /export async function runSessionPaymentCharge\(/.test(
          src,
        );
        const n = calls.length - (isDeclaration ? 1 : 0);
        for (let i = 0; i < n; i++) {
          callers.push(file.replace(`${process.cwd()}/`, ""));
        }
      }
    }
    expect(callers.sort()).toEqual([
      // no_show_fee / late_cancellation_fee ONLY; manual-fee authority + live hold
      "app/(app)/calendar/[id]/manual-fee-actions.ts",
      // session_payment ONLY; requires current authoritative pricing permission
      "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts",
    ]);
  });

  it("each caller enforces its OWN endpoint authority before the runner", () => {
    const SESSION = readFileSync(
      join(
        process.cwd(),
        "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts",
      ),
      "utf8",
    );
    const MANUAL = readFileSync(
      join(process.cwd(), "app/(app)/calendar/[id]/manual-fee-actions.ts"),
      "utf8",
    );
    const sIdx = SESSION.indexOf("decideExecutionPricingPermission(");
    const sRun = SESSION.indexOf("await runSessionPaymentCharge({");
    expect(sIdx).toBeGreaterThan(-1);
    expect(sRun).toBeGreaterThan(sIdx);

    const mIdx = MANUAL.indexOf("isManualFeeChargeReason(");
    const mRun = MANUAL.indexOf("await runSessionPaymentCharge({");
    expect(mIdx).toBeGreaterThan(-1);
    expect(mRun).toBeGreaterThan(mIdx);
    // and the manual-fee endpoint never consults the pricing permission (that
    // would couple manual fees to booked-service pricing)
    expect(MANUAL).not.toMatch(/decideExecutionPricingPermission/);
  });
});
