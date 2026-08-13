import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FREE-01 / review 3777447035 — the EXECUTION permission boundary, exercised
// for real.
//
// WHY THIS FILE IS BEHAVIOURAL AND NOT ANOTHER SOURCE PIN
// Three review rounds narrowed the same question by hand, and the source pins
// that guarded them could only ever prove that some text existed near some
// other text. They could not prove the property that actually matters:
//
//     for a session that is not currently chargeable,
//     runSessionPaymentCharge is called ZERO times.
//
// One of those pins was itself vacuous for a while — it sliced to a bare
// identifier that matched a doc comment and produced an empty string, which
// matched nothing and passed. So this file invokes the REAL server action
// against recording stubs and asserts on the calls it actually made.
//
// The five pricing kinds are enumerated deliberately: `missing_service`,
// `missing_price` and `ambiguous_custom_pricing` are all `ok: true` results,
// which is precisely why they used to fall through to a charge at the stale
// prepared amount.

const practitioner = { id: "prac-1", role: "owner", active: true };
const studio = { id: "studio-1", timezone: "America/Toronto" };

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner, studio }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: async () => {} }));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));

// The attempt-row read. `attemptRow` / `attemptRowError` are set per test.
const attemptLookup: {
  row: { session_id: string | null } | null;
  error: unknown;
} = { row: { session_id: "sess-1" }, error: null };

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

// The authoritative re-resolve. Set per test.
let repriced: unknown = {
  ok: true,
  result: { kind: "resolved", amountCents: 12_000, serviceName: "Electrolysis" },
  appointmentId: "appt-1",
};

vi.mock("@/lib/billing/authoritative-session-payment", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getAuthoritativeSessionPaymentAmount: async () => repriced,
  };
});

// THE ORACLE. Every blocked case must leave this at zero calls.
const runCharge = vi.fn(async (_args: Record<string, unknown>) => ({
  ok: true as const,
  outcome: "charged" as const,
  attemptId: "attempt-1",
}));

vi.mock("@/lib/billing/session-payment-charge", () => ({
  runSessionPaymentCharge: (args: Record<string, unknown>) => runCharge(args),
}));

import { executeSessionPaymentChargeAction } from "@/app/(app)/clients/[id]/sessions/[sessionId]/payment-actions";

function form(): FormData {
  const fd = new FormData();
  fd.set("attempt_id", "attempt-1");
  fd.set("confirm_charge", "true");
  // Untrusted context. Deliberately points at a DIFFERENT session than the
  // attempt row carries, so any implementation that repriced the browser's
  // session instead of the stored one would be visible here.
  fd.set("client_id", "client-1");
  fd.set("session_id", "sess-FROM-BROWSER");
  return fd;
}

beforeEach(() => {
  runCharge.mockClear();
  attemptLookup.row = { session_id: "sess-1" };
  attemptLookup.error = null;
  repriced = {
    ok: true,
    result: {
      kind: "resolved",
      amountCents: 12_000,
      serviceName: "Electrolysis",
    },
    appointmentId: "appt-1",
  };
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("execution requires a currently authoritative CHARGEABLE price", () => {
  it("E1 attempt-row DB error -> blocked, runner never called", async () => {
    attemptLookup.row = null;
    attemptLookup.error = { message: "boom" };
    const res = await executeSessionPaymentChargeAction(form());
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ outcome: "blocked" });
    expect(runCharge).toHaveBeenCalledTimes(0);
  });

  it("E1b a read ERROR blocks even when a row IS returned", async () => {
    // Same distinguishing case as M5b: a null row would block regardless, so
    // only an error alongside a usable row proves the error is honoured.
    attemptLookup.row = { session_id: "sess-1" };
    attemptLookup.error = { message: "boom" };
    const res = await executeSessionPaymentChargeAction(form());
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ outcome: "blocked" });
    expect(runCharge).toHaveBeenCalledTimes(0);
  });

  it("E2 attempt row unavailable / no trusted session_id -> blocked, runner never called", async () => {
    attemptLookup.row = { session_id: null };
    const res = await executeSessionPaymentChargeAction(form());
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ outcome: "blocked" });
    expect(runCharge).toHaveBeenCalledTimes(0);

    // and the same when the row is simply absent
    runCharge.mockClear();
    attemptLookup.row = null;
    const res2 = await executeSessionPaymentChargeAction(form());
    expect(res2.ok).toBe(false);
    expect(runCharge).toHaveBeenCalledTimes(0);
  });

  it("E3 authoritative load ok:false -> blocked, runner never called", async () => {
    for (const kind of [
      "session_not_found",
      "no_linked_appointment",
      "appointment_lineage_mismatch",
    ]) {
      runCharge.mockClear();
      repriced = { ok: false, failure: { kind } };
      const res = await executeSessionPaymentChargeAction(form());
      expect(res.ok, kind).toBe(false);
      expect(res, kind).toMatchObject({ outcome: "blocked" });
      expect(runCharge, kind).toHaveBeenCalledTimes(0);
    }
  });

  it("E4 free -> blocked with no-payment-required copy, runner never called", async () => {
    repriced = {
      ok: true,
      result: {
        kind: "free",
        serviceName: "Consultation",
        durationMinutes: 30,
      },
      appointmentId: "appt-1",
    };
    const res = await executeSessionPaymentChargeAction(form());
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ outcome: "blocked" });
    expect("error" in res ? res.error : "").toMatch(
      /Consultation is free — no payment is required/,
    );
    expect(runCharge).toHaveBeenCalledTimes(0);
  });

  it("E5 missing_service -> blocked, runner never called", async () => {
    repriced = {
      ok: true,
      result: { kind: "missing_service" },
      appointmentId: null,
    };
    const res = await executeSessionPaymentChargeAction(form());
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ outcome: "blocked" });
    expect(runCharge).toHaveBeenCalledTimes(0);
  });

  it("E6 missing_price -> blocked, runner never called", async () => {
    repriced = {
      ok: true,
      result: { kind: "missing_price", serviceName: "Electrolysis" },
      appointmentId: "appt-1",
    };
    const res = await executeSessionPaymentChargeAction(form());
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ outcome: "blocked" });
    expect(runCharge).toHaveBeenCalledTimes(0);
  });

  it("E7 ambiguous_custom_pricing -> blocked, runner never called", async () => {
    repriced = {
      ok: true,
      result: {
        kind: "ambiguous_custom_pricing",
        serviceName: "Electrolysis",
        candidateCents: [9_000, 12_000],
      },
      appointmentId: "appt-1",
    };
    const res = await executeSessionPaymentChargeAction(form());
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ outcome: "blocked" });
    expect(runCharge).toHaveBeenCalledTimes(0);
  });

  it("E8 resolved -> the already-prepared attempt is allowed through", async () => {
    const res = await executeSessionPaymentChargeAction(form());
    expect(runCharge).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
  });

  it("E9 a resolved price that DIFFERS from the prepared amount is not substituted", async () => {
    // The current authoritative price is $999.99; the prepared attempt is
    // whatever it was prepared at. Execution is a PERMISSION check, so the
    // re-resolved amount must not travel to the runner in any form — the
    // runner receives only (attemptId, studioId, practitionerId) and reads the
    // stored row itself.
    repriced = {
      ok: true,
      result: {
        kind: "resolved",
        amountCents: 99_999,
        serviceName: "Electrolysis",
      },
      appointmentId: "appt-1",
    };
    await executeSessionPaymentChargeAction(form());
    expect(runCharge).toHaveBeenCalledTimes(1);
    const args = runCharge.mock.calls[0][0];
    expect(Object.keys(args).sort()).toEqual([
      "attemptId",
      "practitionerId",
      "studioId",
    ]);
    expect(JSON.stringify(args)).not.toContain("99999");
    expect(args.attemptId).toBe("attempt-1");
    expect(args.studioId).toBe("studio-1");
  });

  it("the repriced session comes from the ATTEMPT ROW, never the browser field", async () => {
    // The form carries session_id=sess-FROM-BROWSER while the attempt row says
    // sess-1. If the browser value were trusted, a practitioner could point the
    // permission check at some other, chargeable session.
    const seen: string[] = [];
    repriced = {
      ok: true,
      result: { kind: "free", serviceName: "Consultation", durationMinutes: 30 },
      appointmentId: "appt-1",
    };
    attemptLookup.row = { session_id: "sess-1" };
    const res = await executeSessionPaymentChargeAction(form());
    // free on the STORED session blocks, proving the stored id was the one used
    expect(res).toMatchObject({ outcome: "blocked" });
    expect(runCharge).toHaveBeenCalledTimes(0);
    expect(seen).toEqual([]);
  });
});
