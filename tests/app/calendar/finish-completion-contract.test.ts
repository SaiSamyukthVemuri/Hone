import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-45 (Sam's decision). Finish appointment writes COMPLETION and nothing else, with one honoured exception: a studio
// that explicitly opted into `postcare_delivery_mode = 'auto_on_complete'` still gets its automatic postcare. Finish NEVER
// charges, in any mode. This file runs the REAL markAppointmentCompleteAction and the REAL autoSendPostcareOnComplete
// against ONE recording fake admin client, and asserts what was touched: every RPC and every table read or written.
// Synthetic values only. No network, no provider.

const APPT = "aaaaaaaa-0000-4000-8000-000000000001";
const STUDIO = "bbbbbbbb-0000-4000-8000-000000000002";
const PRACT = "cccccccc-0000-4000-8000-000000000003";
const CLAIM_TOKEN = "2026-08-10T15:04:05.123+00:00";

const h = vi.hoisted(() => ({
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  tables: [] as string[],
  mode: "manual" as string,
  sendPostcare: vi.fn(),
  revalidate: vi.fn(),
}));

function row() {
  return {
    id: APPT,
    status: "completed",
    starts_at: "2026-08-10T12:00:00.000Z",
    postcare_email_sent_at: null,
    postcare_email_send_attempts: 0,
    client: { name: "Client", email: "c@example.com" },
    service: { name: "Electrolysis", modality: "electrolysis" },
    studio: {
      id: STUDIO,
      name: "Studio",
      owner_email: "o@example.com",
      timezone: "America/Toronto",
      postcare_delivery_mode: h.mode,
      postcare_aftercare_text: "Ice the area.",
      postcare_warning_signs_text: null,
      postcare_product_recommendations_text: null,
      postcare_review_url: null,
      postcare_review_prompt_text: null,
      postcare_contact_email: null,
    },
    practitioner: { display_name: "Prac" },
  };
}

vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: () => { throw new Error("no RLS client in this path"); } }) }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: PRACT, active: true, role: "owner" },
    studio: { id: STUDIO },
  }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      h.tables.push(table);
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: row(), error: null });
      q.update = () => { throw new Error("Finish must not write any table directly"); };
      q.insert = () => { throw new Error("Finish must not write any table directly"); };
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcs.push({ fn, args });
      if (fn === "claim_postcare_send") return { data: [{ result: "claimed", claimed_at: CLAIM_TOKEN, send_attempts: 1 }], error: null };
      if (fn === "settle_postcare_send") return { data: [{ result: "settled" }], error: null };
      return { data: null, error: null };
    },
  }),
}));
vi.mock("@/lib/email/send-appointment", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendPostcareToClient: h.sendPostcare,
}));

import { markAppointmentCompleteAction } from "@/app/(app)/calendar/actions";

function form() {
  const fd = new FormData();
  fd.set("appointment_id", APPT);
  return fd;
}

// What a charge or a payment would touch. None of these may appear anywhere in a Finish.
const MONEY = /payment|charge|stripe|refund|fee|settlement/i;

beforeEach(() => {
  h.rpcs.length = 0;
  h.tables.length = 0;
  h.mode = "manual";
  h.sendPostcare.mockReset();
  h.sendPostcare.mockResolvedValue({ ok: true });
  h.revalidate.mockReset();
});

describe("Finish appointment writes completion only (manual studio)", () => {
  it("completes through the one command and touches NOTHING else: no postcare, no payment, no charge", async () => {
    h.mode = "manual";
    const result = await markAppointmentCompleteAction(form());

    expect(result).toEqual({ ok: true });
    // The ONLY RPC is the completion command, for this appointment, as the signed-in practitioner.
    expect(h.rpcs).toEqual([
      { fn: "mark_appointment_complete", args: { p_appointment_id: APPT, p_studio_id: STUDIO, p_practitioner_id: PRACT } },
    ]);
    // Postcare: never claimed, never handed to the provider.
    expect(h.sendPostcare).not.toHaveBeenCalled();
    expect(h.rpcs.some((c) => /postcare/.test(c.fn))).toBe(false);
    // Money: no RPC and no table that has anything to do with payments.
    expect(h.rpcs.filter((c) => MONEY.test(c.fn))).toEqual([]);
    expect(h.tables.filter((t) => MONEY.test(t))).toEqual([]);
  });
});

describe("Finish appointment in an opted-in studio (auto_on_complete)", () => {
  it("completes, then sends postcare exactly once (claim, provider, settle), and still takes no payment", async () => {
    h.mode = "auto_on_complete";
    const result = await markAppointmentCompleteAction(form());

    expect(result).toEqual({ ok: true });
    expect(h.rpcs.map((c) => c.fn)).toEqual(["mark_appointment_complete", "claim_postcare_send", "settle_postcare_send"]);
    expect(h.sendPostcare).toHaveBeenCalledTimes(1);
    // Charging is never part of Finish, in any mode.
    expect(h.rpcs.filter((c) => MONEY.test(c.fn))).toEqual([]);
    expect(h.tables.filter((t) => MONEY.test(t))).toEqual([]);
  });
});
