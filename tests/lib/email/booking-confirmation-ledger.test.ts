import { afterEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// DELIVERY-VISIBILITY-03 — the booking confirmation joins the email delivery
// ledger inside its one sender, so all four callers are covered.
//
// Pinned: the row is begun for THIS appointment and studio with the
// confirmation purpose; the message carries the hone_m tag; the provider's
// answer is settled onto the row; and when the ledger (or the service-role
// configuration) is unavailable, the very same email is sent untagged and the
// caller sees the same result.
// ===========================================================================

type Payload = Record<string, unknown>;
const h: {
  sent: Payload[];
  rpc: Array<[string, Record<string, unknown>]>;
  begin: { data: unknown; error: unknown };
  adminThrows: boolean;
} = { sent: [], rpc: [], begin: { data: null, error: null }, adminThrows: false };

const ROW = "6e5d4c3b-2a19-4807-a6b5-c4d3e2f1a0b9";
const EMAIL_ID = "0b8f1c1e-6a52-4c0e-9f3e-2f6c3c1a7d10";

vi.mock("@/lib/email/client", () => ({
  FROM_ADDRESS: "Hone <hello@hone.care>",
  getResendTransport: () => ({
    emails: {
      send: (payload: Payload) => {
        h.sent.push(payload);
        return Promise.resolve({ data: { id: EMAIL_ID }, error: null });
      },
    },
  }),
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    if (h.adminThrows) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
    return {
      rpc: (fn: string, args: Record<string, unknown>) => {
        h.rpc.push([fn, args]);
        return Promise.resolve(fn === "begin_appointment_email_message" ? h.begin : { data: "settled", error: null });
      },
    };
  },
}));

const { sendBookingConfirmationToClient, sendCancellationEmail, sendPostcareToClient } = await import(
  "@/lib/email/send-appointment"
);

const STUDIO_ID = "4f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b";
const APPT_ID = "9e8d7c6b-5a49-4382-a716-152433221100";

function params(over: Record<string, unknown> = {}) {
  return {
    appointment: {
      id: APPT_ID,
      studio_id: STUDIO_ID,
      starts_at: "2026-10-16T17:00:00.000Z",
      ends_at: "2026-10-16T17:45:00.000Z",
      duration_minutes: 45,
    },
    service: { name: "Electrolysis", default_duration_minutes: 45, pre_care_instructions: null },
    studio: {
      id: STUDIO_ID,
      name: "Synthetic Studio",
      address: null,
      owner_email: "owner@synthetic.test",
      timezone: "America/Los_Angeles",
      slug: null,
      postcare_contact_email: null,
    },
    practitionerDisplayName: "Practitioner",
    clientName: "Synthetic Client",
    clientEmail: "client@synthetic.test",
    cancellationUrl: "https://hone.care/cancel/x",
    rescheduleUrl: null,
    intakeUrl: null,
    treatmentTimeLine: null,
    appBaseUrl: "https://hone.care",
    ...over,
  } as never;
}

afterEach(() => {
  h.sent = [];
  h.rpc = [];
  h.begin = { data: ROW, error: null };
  h.adminThrows = false;
});

describe("sendBookingConfirmationToClient joins the ledger", () => {
  it("begins a confirmation row for this appointment, tags the email and settles the provider's answer", async () => {
    h.begin = { data: ROW, error: null };
    const result = await sendBookingConfirmationToClient(params());
    expect(result).toEqual({ ok: true, messageId: EMAIL_ID });
    expect(h.rpc[0]).toEqual([
      "begin_appointment_email_message",
      { p_studio_id: STUDIO_ID, p_appointment_id: APPT_ID, p_purpose: "appointment_confirmation" },
    ]);
    expect(h.sent[0]!.tags).toEqual([{ name: "hone_m", value: ROW }]);
    expect(h.rpc[1]).toEqual([
      "settle_email_message",
      { p_message_id: ROW, p_outcome: "accepted", p_provider_email_id: EMAIL_ID, p_provider_error: null, p_skip_reason: null },
    ]);
  });

  it("sends the same email untagged when the ledger row cannot be begun", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.begin = { data: null, error: { message: "db down" } };
    const result = await sendBookingConfirmationToClient(params());
    expect(result).toEqual({ ok: true, messageId: EMAIL_ID });
    expect(h.sent[0]).not.toHaveProperty("tags");
    expect(h.rpc.map(([fn]) => fn)).toEqual(["begin_appointment_email_message"]);
  });

  it("sends the same email untagged when there is no service-role configuration", async () => {
    h.adminThrows = true;
    const result = await sendBookingConfirmationToClient(params());
    expect(result.ok).toBe(true);
    expect(h.sent[0]).not.toHaveProperty("tags");
    expect(h.rpc).toEqual([]);
  });

  // WHY THE CASE ABOVE DID NOT CATCH 4307335313, which is the part worth
  // keeping: `params()` builds a COMPLETE appointment, including
  // `studio_id: STUDIO_ID`. No real public caller does. The fixture was more
  // complete than production, so the happy path read `appointment.studio_id`
  // successfully here and `undefined` in the three flows that matter — the
  // same shape of mistake as a fixture asserting a state it never built.
  it("the PARTIAL appointment the public callers really pass still joins the ledger", async () => {
    // THE EXACT OBJECT the three public flows construct and cast
    // `as unknown as Appointment`:
    //   app/book/[slug]/actions.ts:1425
    //   app/reschedule/[token]/actions.ts:1046
    //   app/portal/rebook-actions.ts:668
    // No `studio_id`, and the cast is why `tsc` never objected.
    const partial = {
      id: APPT_ID,
      starts_at: "2026-10-16T17:00:00.000Z",
      ends_at: "2026-10-16T17:45:00.000Z",
      duration_minutes: 45,
      created_at: "2026-10-15T12:00:00.000Z",
    };
    // THE FIXTURE'S OWN DISCRIMINATOR. If `studio_id` ever creeps back into
    // this object the test below passes for the wrong reason and stops
    // guarding anything.
    expect(Object.keys(partial)).not.toContain("studio_id");

    h.begin = { data: ROW, error: null };
    const result = await sendBookingConfirmationToClient(params({ appointment: partial }));

    expect(result).toEqual({ ok: true, messageId: EMAIL_ID });
    // Keyed to the STUDIO ARGUMENT. Before the fix this row was never begun:
    // `p_studio_id` arrived undefined, the helper failed soft, and the
    // confirmation went out untagged with no row, no attribution and no
    // incident — on exactly the flows the ledger exists to observe.
    expect(h.rpc[0]).toEqual([
      "begin_appointment_email_message",
      { p_studio_id: STUDIO_ID, p_appointment_id: APPT_ID, p_purpose: "appointment_confirmation" },
    ]);
    // And the email is tagged, which is the observable consequence of the row
    // existing — asserting the RPC args alone would not prove the send was
    // actually attributed.
    expect(h.sent[0]!.tags).toEqual([{ name: "hone_m", value: ROW }]);
    expect(h.rpc[1]?.[0]).toBe("settle_email_message");
  });

  it("CONTROL: a partial appointment never sends `undefined` as the studio", async () => {
    const partial = {
      id: APPT_ID,
      starts_at: "2026-10-16T17:00:00.000Z",
      ends_at: "2026-10-16T17:45:00.000Z",
      duration_minutes: 45,
      created_at: "2026-10-15T12:00:00.000Z",
    };
    h.begin = { data: ROW, error: null };
    await sendBookingConfirmationToClient(params({ appointment: partial }));
    const args = h.rpc[0]![1];
    // Stated separately from the equality above because this is the FAILURE
    // MODE, not the happy value: `beginAppointmentEmailMessage` types
    // `studioId: string`, so an undefined here is a type lie that only the
    // upstream cast made possible.
    expect(args.p_studio_id).toBeDefined();
    expect(typeof args.p_studio_id).toBe("string");
  });

  it("begins nothing when there is no recipient", async () => {
    const result = await sendBookingConfirmationToClient(params({ clientEmail: "" }));
    expect(result).toMatchObject({ ok: false, attempt: "none" });
    expect(h.rpc).toEqual([]);
    expect(h.sent).toEqual([]);
  });
});

describe("cancellation and postcare join the ledger when given the appointment (DELIVERY-VISIBILITY-04)", () => {
  const studio = (params() as unknown as { studio: unknown }).studio as never;
  const cancel = (isClient: boolean) =>
    sendCancellationEmail({
      to: isClient ? "client@synthetic.test" : "owner@synthetic.test",
      recipientName: "R",
      clientName: "Synthetic Client",
      studio,
      serviceName: "Electrolysis",
      durationMinutes: 45,
      startsAt: new Date("2026-10-16T17:00:00.000Z"),
      actorName: "Owner",
      actorRole: "owner",
      reason: null,
      isClient,
      ledger: { studioId: STUDIO_ID, appointmentId: APPT_ID },
    });

  it("ledgers the CLIENT's cancellation notice with its own purpose and tag", async () => {
    await cancel(true);
    expect(h.rpc[0]).toEqual([
      "begin_appointment_email_message",
      { p_studio_id: STUDIO_ID, p_appointment_id: APPT_ID, p_purpose: "appointment_cancellation" },
    ]);
    expect(h.sent[0]!.tags).toEqual([{ name: "hone_m", value: ROW }]);
    expect(h.rpc[1]![0]).toBe("settle_email_message");
  });

  it("does not ledger the studio's own copy of a cancellation", async () => {
    await cancel(false);
    expect(h.rpc).toEqual([]);
    expect(h.sent[0]).not.toHaveProperty("tags");
  });

  it("ledgers the postcare email with its own purpose, and sends untagged without an appointment", async () => {
    const base = {
      clientName: "Synthetic Client",
      clientEmail: "client@synthetic.test",
      studio,
      practitionerName: null,
      serviceName: null,
      startsAt: null,
      aftercareText: "Keep the area clean.",
      warningSignsText: null,
      productRecommendationsText: null,
      reviewUrl: null,
      reviewPromptText: null,
    };
    await sendPostcareToClient({ ...base, ledger: { studioId: STUDIO_ID, appointmentId: APPT_ID } });
    expect(h.rpc[0]![1]).toMatchObject({ p_purpose: "appointment_postcare" });
    expect(h.sent[0]!.tags).toEqual([{ name: "hone_m", value: ROW }]);
    h.rpc = [];
    await sendPostcareToClient(base);
    expect(h.rpc).toEqual([]);
    expect(h.sent[1]).not.toHaveProperty("tags");
  });
});
