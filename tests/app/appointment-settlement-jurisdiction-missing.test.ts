import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// T-0214-2: a settlement for a studio with no payment jurisdiction is refused
// by the 0214 insert trigger (payment_jurisdiction_missing). The three
// settlement actions used to answer every command error with "You are not
// authorized to do that." and log nothing. They now give that one refusal
// truthful copy and a distinct ops event; every other error is unchanged.
// All deps mocked; NO db, NO network. Ids are synthetic.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));

import {
  recordAppointmentSettlementAction,
  supersedeAppointmentSettlementAction,
  waiveAppointmentFeeAction,
} from "@/app/(app)/appointment-settlement-actions";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";

const whoami = getCurrentPractitionerWithStudio as unknown as Mock;
const client = createClient as unknown as Mock;

const STUDIO = "0b5f3c1e-7a2d-4c8e-9f10-2a3b4c5d6e7f";
const APPT = "1c6e4d2f-8b3e-4d9f-a021-3b4c5d6e7f80";
const SETTLEMENT = "2d7f5e30-9c4f-4ea0-b132-4c5d6e7f8091";
const NOT_AUTHORIZED = "You are not authorized to do that.";

const MISSING = {
  code: "23514",
  message: `payment_jurisdiction_missing: studio ${STUDIO} has no payment jurisdiction`,
};

let rpc: Mock;
let logged: string[];

beforeEach(() => {
  whoami.mockResolvedValue({
    practitioner: { id: "prac-1", role: "owner" },
    studio: { id: STUDIO },
  });
  rpc = vi.fn();
  client.mockResolvedValue({ rpc });
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const ACTIONS = [
  [
    "record",
    () => recordAppointmentSettlementAction(
      form({ appointment_id: APPT, method: "paid_cash", amount_cents: "4500" }),
    ),
  ],
  [
    "waive",
    () => waiveAppointmentFeeAction(form({ appointment_id: APPT, amount_cents: "4500" })),
  ],
  [
    "supersede",
    () => supersedeAppointmentSettlementAction(
      form({
        settlement_id: SETTLEMENT,
        appointment_id: APPT,
        method: "paid_cash",
        amount_cents: "4500",
        reason: "typed the wrong amount",
      }),
    ),
  ],
] as const;

describe.each(ACTIONS)("%s: payment_jurisdiction_missing", (action, run) => {
  it("returns truthful copy, never NOT_AUTHORIZED", async () => {
    rpc.mockResolvedValue({ data: null, error: MISSING });
    const r = await run();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("payment_jurisdiction_missing");
    expect(r.message).not.toBe(NOT_AUTHORIZED);
    expect(r.message).toMatch(/payment country and currency have not been confirmed/);
    expect(r.message).toMatch(/nothing was recorded/);
  });

  it("emits exactly one distinct ops event with no record id or message", async () => {
    rpc.mockResolvedValue({ data: null, error: MISSING });
    await run();
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0])).toEqual({
      event: "settlement_payment_jurisdiction_missing",
      action,
      dbCode: "23514",
    });
    expect(logged[0]).not.toContain(STUDIO);
    expect(logged[0]).not.toContain("has no payment jurisdiction");
  });

  // Negative controls: the mapping is keyed on the 0214 refusal only.
  it.each([
    ["another check_violation", { code: "23514", message: "payment_currency_mismatch: x" }],
    ["the slug not at the start", { code: "P0001", message: "wrapped: payment_jurisdiction_missing: x" }],
    ["a permission error", { code: "42501", message: "permission denied for function x" }],
    ["no message", { code: "XX000" }],
  ])("%s keeps the existing NOT_AUTHORIZED answer and logs nothing", async (_l, error) => {
    rpc.mockResolvedValue({ data: null, error });
    const r = await run();
    expect(r).toEqual({ ok: false, code: "unavailable", message: NOT_AUTHORIZED });
    expect(logged).toEqual([]);
  });
});
