import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Appointment, Studio } from "@/lib/types/database";

// ===========================================================================
// HON-47 — the REAL client email variants carry only the self-service links the
// studio offers, and still deliver.
// ===========================================================================
//
// Exercised at the SENDER, not the template: the senders are where the policy
// is applied, so every caller (public booking, portal rebook, reschedule, staff
// booking, the reminder cron) inherits it. The only thing replaced is the
// provider transport, which records what would have been sent.
//
// Synthetic studio and client only. No tenant name, slug or id.

const sent = vi.hoisted(
  () => [] as Array<{ to: string; subject: string; html: string; text: string; attachments?: Array<{ content: Buffer }> }>,
);

vi.mock("@/lib/email/client", () => ({
  FROM_ADDRESS: "Hone <hello@hone.care>",
  getResendTransport: () => ({
    emails: {
      send: async (payload: (typeof sent)[number]) => {
        sent.push(payload);
        return { data: { id: "msg_synthetic" }, error: null };
      },
    },
  }),
}));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => undefined }));

const ORIGIN = "https://app.example.invalid";
vi.stubEnv("NEXT_PUBLIC_APP_ORIGIN", ORIGIN);

const {
  sendBookingConfirmationToClient,
  send24hReminderToClient,
  send2hReminderToClient,
  sendCancellationEmail,
  sendNoShowFollowupToClient,
  sendPostcareToClient,
} = await import("@/lib/email/send-appointment");

type Flags = Partial<
  Pick<Studio, "client_cancellation_enabled" | "client_reschedule_enabled" | "client_portal_enabled">
>;

function studio(flags: Flags = {}): Studio {
  return {
    id: "00000000-0000-4000-8000-000000000047",
    name: "Synthetic Studio",
    owner_email: "owner@example.invalid",
    timezone: "America/Toronto",
    slug: "synthetic-studio",
    address: null,
    postcare_contact_email: null,
    ...flags,
  } as unknown as Studio;
}

const APPOINTMENT = {
  id: "00000000-0000-4000-8000-0000000000a1",
  starts_at: "2031-03-04T15:00:00Z",
  ends_at: "2031-03-04T15:45:00Z",
  duration_minutes: 45,
} as unknown as Appointment;

const CANCEL = `${ORIGIN}/cancel/SYNTHETIC_TOKEN`;
const RESCHEDULE = `${ORIGIN}/reschedule/SYNTHETIC_TOKEN`;
const PORTAL = `${ORIGIN}/portal/login?studio=synthetic-studio`;
const BOOK = `${ORIGIN}/book/synthetic-studio`;
const CONTACT = "please contact Synthetic Studio directly";

const ALL_OFF: Flags = {
  client_cancellation_enabled: false,
  client_reschedule_enabled: false,
  client_portal_enabled: false,
};

function confirmation(s: Studio) {
  return sendBookingConfirmationToClient({
    appointment: APPOINTMENT,
    service: { name: "Synthetic Service", default_duration_minutes: 45, pre_care_instructions: null },
    studio: s,
    practitionerDisplayName: null,
    clientName: "Synthetic Client",
    clientEmail: "client@example.invalid",
    cancellationUrl: CANCEL,
    rescheduleUrl: RESCHEDULE,
    intakeUrl: null,
    treatmentTimeLine: null,
    appBaseUrl: ORIGIN,
  });
}

function reminder(kind: "24h" | "2h", s: Studio) {
  const send = kind === "24h" ? send24hReminderToClient : send2hReminderToClient;
  return send({
    appointment: APPOINTMENT,
    service: { name: "Synthetic Service", default_duration_minutes: 45, pre_care_instructions: null },
    studio: s,
    practitionerDisplayName: null,
    clientName: "Synthetic Client",
    clientEmail: "client@example.invalid",
    cancellationUrl: CANCEL,
    rescheduleUrl: RESCHEDULE,
    treatmentTimeLine: null,
  });
}

function last() {
  const m = sent.at(-1);
  if (!m) throw new Error("nothing was sent");
  return { ...m, both: `${m.html}\n${m.text}` };
}

function ics(m: (typeof sent)[number]): string {
  return (m.attachments ?? []).map((a) => a.content.toString("utf8")).join("\n");
}

beforeEach(() => {
  sent.length = 0;
});

describe("DEFAULT: a studio with no policy columns (today's rows) is unchanged", () => {
  it("confirmation carries Cancel, Reschedule and the portal CTA, and the invite carries Cancel", async () => {
    expect((await confirmation(studio())).ok).toBe(true);
    const m = last();
    expect(m.both).toContain(CANCEL);
    expect(m.both).toContain(RESCHEDULE);
    expect(m.both).toContain(PORTAL);
    expect(m.both).not.toContain(CONTACT);
    expect(ics(sent[0])).toContain("Cancel:");
  });

  it("explicit TRUE flags render byte-for-byte the same as absent flags", async () => {
    await confirmation(studio());
    const absent = last();
    await confirmation(
      studio({ client_cancellation_enabled: true, client_reschedule_enabled: true, client_portal_enabled: true }),
    );
    const explicit = last();
    expect(explicit.html).toBe(absent.html);
    expect(explicit.text).toBe(absent.text);
  });

  it.each(["24h", "2h"] as const)("%s reminder carries Cancel, Reschedule and the portal CTA", async (kind) => {
    expect((await reminder(kind, studio())).ok).toBe(true);
    const m = last();
    expect(m.both).toContain(CANCEL);
    expect(m.both).toContain(RESCHEDULE);
    expect(m.both).toContain(PORTAL);
    expect(m.both).not.toContain(CONTACT);
  });
});

describe("each flag withdraws only its own CTA", () => {
  it("cancellation off: no Cancel link anywhere, Reschedule and portal stay, still delivered", async () => {
    expect((await confirmation(studio({ client_cancellation_enabled: false }))).ok).toBe(true);
    const m = last();
    expect(m.both).not.toContain("/cancel/");
    expect(m.both).not.toMatch(/Need to cancel\?/);
    expect(ics(sent[0])).not.toContain("/cancel/");
    expect(m.both).toContain(RESCHEDULE);
    expect(m.both).toContain(PORTAL);
  });

  it("rescheduling off: no Reschedule link, Cancel and portal stay", async () => {
    await confirmation(studio({ client_reschedule_enabled: false }));
    const m = last();
    expect(m.both).not.toContain("/reschedule/");
    expect(m.both).toContain(CANCEL);
    expect(m.both).toContain(PORTAL);
  });

  it("portal off: no portal CTA, Cancel and Reschedule stay", async () => {
    await confirmation(studio({ client_portal_enabled: false }));
    const m = last();
    expect(m.both).not.toContain("/portal");
    expect(m.both).not.toContain("secure client portal");
    expect(m.both).toContain(CANCEL);
    expect(m.both).toContain(RESCHEDULE);
  });
});

describe("the selected initial policy (all three off): reminders still deliver, with no self-service CTA", () => {
  const SELF_SERVICE = /\/(cancel|reschedule|manage|portal|book)(\/|\?|\b)/;

  it("confirmation delivers the appointment details and says how to make a change", async () => {
    const r = await confirmation(studio(ALL_OFF));
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(1);
    const m = last();
    expect(m.both).not.toMatch(SELF_SERVICE);
    expect(m.both).toContain("Synthetic Service");
    expect(m.both).toContain(CONTACT);
    // The lead no longer promises links that are not there.
    expect(m.both).not.toContain("links to manage your booking");
    expect(ics(sent[0])).not.toMatch(SELF_SERVICE);
  });

  it.each(["24h", "2h"] as const)("%s reminder delivers with the contact line and no CTA", async (kind) => {
    const r = await reminder(kind, studio(ALL_OFF));
    expect(r.ok).toBe(true);
    const m = last();
    expect(m.both).not.toMatch(SELF_SERVICE);
    expect(m.both).toContain("Synthetic Service");
    expect(m.both).toContain(CONTACT);
  });

  it("postcare delivers unchanged: it never carried a self-service CTA", async () => {
    for (const s of [studio(), studio(ALL_OFF)]) {
      const r = await sendPostcareToClient({
        clientName: "Synthetic Client",
        clientEmail: "client@example.invalid",
        studio: s,
        practitionerName: null,
        serviceName: "Synthetic Service",
        startsAt: new Date("2031-03-04T15:00:00Z"),
        aftercareText: "Synthetic aftercare.",
        warningSignsText: null,
        productRecommendationsText: null,
        reviewUrl: null,
        reviewPromptText: null,
        appointmentId: APPOINTMENT.id,
      });
      expect(r.ok).toBe(true);
      expect(last().both).not.toMatch(SELF_SERVICE);
      expect(last().both).toContain("Synthetic aftercare.");
    }
    const [a, b] = sent;
    expect(b.html).toBe(a.html);
    expect(b.text).toBe(a.text);
  });

  it("the client cancellation notice drops 'book another' only when the portal is off", async () => {
    const send = (s: Studio) =>
      sendCancellationEmail({
        to: "client@example.invalid",
        recipientName: "Synthetic Client",
        clientName: "Synthetic Client",
        studio: s,
        serviceName: "Synthetic Service",
        durationMinutes: 45,
        startsAt: new Date("2031-03-04T15:00:00Z"),
        actorName: null,
        actorRole: "owner",
        reason: null,
        isClient: true,
        rebookUrl: BOOK,
        appointmentId: APPOINTMENT.id,
      });
    expect((await send(studio())).ok).toBe(true);
    expect(last().both).toContain(BOOK);
    expect((await send(studio({ client_portal_enabled: false }))).ok).toBe(true);
    expect(last().both).not.toContain("/book/");
  });

  it("the no-show follow-up drops 'book another' only when the portal is off", async () => {
    const send = (s: Studio) =>
      sendNoShowFollowupToClient({
        clientName: "Synthetic Client",
        clientEmail: "client@example.invalid",
        studio: s,
        rebookUrl: BOOK,
        appointmentId: APPOINTMENT.id,
      });
    await send(studio());
    expect(last().both).toContain(BOOK);
    expect((await send(studio({ client_portal_enabled: false }))).ok).toBe(true);
    expect(last().both).not.toContain("/book/");
  });
});
