import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONCERN_TARGETS,
  concernTargetFromValue,
  concernTargetValue,
  ledgerStatusWords,
} from "@/lib/delivery/concerns";

// ===========================================================================
// DELIVERY-VISIBILITY-04 — "client says they did not receive it".
//
// The owner chooses from a CLOSED list of messages; the action runs with the
// owner's own session, so the database decides who may report; and the words
// shown for what the ledger said never claim the client saw anything.
// ===========================================================================

const h: { calls: Array<[string, unknown]>; answer: { data: unknown; error: unknown } } = {
  calls: [],
  answer: { data: [{ result: "reported", concern_id: "c", ledger_status: "delivered" }], error: null },
};

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (fn: string, args: unknown) => {
      h.calls.push([fn, args]);
      return Promise.resolve(h.answer);
    },
  }),
}));

const { reportDeliveryConcernAction } = await import("@/components/delivery/report-concern-actions");

const STUDIO = "4f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b";
const APPT = "9e8d7c6b-5a49-4382-a716-152433221100";
const form = (message: string) => {
  const f = new FormData();
  f.set("studio_id", STUDIO);
  f.set("appointment_id", APPT);
  f.set("message", message);
  return f;
};

beforeEach(() => {
  h.calls = [];
  h.answer = { data: [{ result: "reported", concern_id: "c", ledger_status: "delivered" }], error: null };
});

describe("the closed list of messages", () => {
  it("accepts only a listed channel:purpose, and the SMS list never offers a channel the ledger lacks", () => {
    expect(concernTargetFromValue("email:appointment_postcare")).toMatchObject({ channel: "email" });
    expect(concernTargetFromValue("sms:appointment_postcare")).toBeNull();
    expect(concernTargetFromValue("email:marketing")).toBeNull();
    expect(concernTargetFromValue(42)).toBeNull();
    expect(new Set(CONCERN_TARGETS.map(concernTargetValue)).size).toBe(CONCERN_TARGETS.length);
  });

  it("never says the client saw, read or opened anything", () => {
    for (const status of ["delivered", "accepted", "sent", "delivery_delayed", "bounced", "failed", "unknown", "no_record", "x"]) {
      expect(ledgerStatusWords(status)).not.toMatch(/\b(read|opened|seen by)\b/i);
    }
    expect(ledgerStatusWords("delivered")).toContain("not that it was seen");
  });
});

describe("reportDeliveryConcernAction", () => {
  it("reports through the owner's own session with the chosen message", async () => {
    const state = await reportDeliveryConcernAction({ status: "idle" }, form("email:appointment_reminder_24h"));
    expect(h.calls).toEqual([
      [
        "report_delivery_concern",
        { p_studio_id: STUDIO, p_appointment_id: APPT, p_channel: "email", p_purpose: "appointment_reminder_24h" },
      ],
    ]);
    expect(state).toEqual({ status: "reported", ledgerStatus: "delivered" });
  });

  it("refuses an unlisted message without calling the database", async () => {
    const state = await reportDeliveryConcernAction({ status: "idle" }, form("email:marketing"));
    expect(state.status).toBe("error");
    expect(h.calls).toEqual([]);
  });

  it("explains a refusal for anyone who is not the owner", async () => {
    h.answer = { data: null, error: { code: "42501", message: "not the owner of this studio" } };
    expect(await reportDeliveryConcernAction({ status: "idle" }, form("sms:appointment_reminder_2h"))).toEqual({
      status: "error",
      message: "Only the studio owner can report a delivery concern.",
    });
  });

  it("reports an existing open concern as already open", async () => {
    h.answer = { data: [{ result: "already_open", concern_id: "c", ledger_status: "no_record" }], error: null };
    expect(await reportDeliveryConcernAction({ status: "idle" }, form("email:appointment_confirmation"))).toEqual({
      status: "already_open",
      ledgerStatus: "no_record",
    });
  });
});
