// HON-50. The client appointment emails show the studio address through ONE
// leak-safe rule (lib/booking/studio-location.ts). The visibility column is
// drafted and not yet applied, so every production row reads as 'both' and the
// emails are exactly today's. These cases prove both halves with captured mail:
// the real senders run against a capturing transport (lib/email/client is
// replaced), so what is asserted is the payload Resend would receive, including
// the confirmation's .ics attachment. All values are synthetic.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Captured = {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: ReadonlyArray<{ filename: string; content: Buffer }>;
};
const mail = vi.hoisted(() => [] as Captured[]);

vi.mock("@/lib/email/client", () => ({
  FROM_ADDRESS: "Hone <hello@hone.care>",
  getResendTransport: () => ({
    emails: {
      send: async (args: Captured) => {
        mail.push(args);
        return { data: { id: "synthetic-message-id" }, error: null };
      },
    },
  }),
}));
vi.mock("@/lib/booking/tokens", () => ({ generateCancellationToken: () => "tok_SYNTH" }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => {} }));
vi.mock("server-only", () => ({}));

import { build24hReminderEmail } from "@/lib/email/templates/reminders";
import { notifyAppointmentMoved } from "@/lib/email/notify-appointment-moved";
import {
  send24hReminderToClient,
  send2hReminderToClient,
  sendBookingConfirmationToClient,
} from "@/lib/email/send-appointment";
import type { Studio } from "@/lib/types/database";

const ADDRESS = "100 Synthetic Avenue, Suite 2, Toronto ON";
const START = new Date("2031-03-04T20:45:00Z");
const END = new Date("2031-03-04T21:45:00Z");

// A production row today: no address_visibility at all.
function studio(fields: Record<string, unknown> = {}): Studio {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    name: "Synthetic Studio",
    slug: "synthetic",
    timezone: "America/Toronto",
    owner_email: "owner@synthetic.test",
    postcare_contact_email: null,
    address: ADDRESS,
    ...fields,
  } as unknown as Studio;
}

const appointment = {
  id: "00000000-0000-4000-8000-0000000000b1",
  studio_id: "00000000-0000-4000-8000-0000000000a1",
  starts_at: START.toISOString(),
  ends_at: END.toISOString(),
  duration_minutes: 60,
} as never;

const common = {
  appointment,
  service: { name: "Synthetic Consultation", default_duration_minutes: 60, pre_care_instructions: null },
  practitionerDisplayName: "Synthetic Practitioner",
  clientName: "Synthetic Client",
  clientEmail: "client@synthetic.test",
  cancellationUrl: "https://hone.care/cancel/tok_SYNTH",
  rescheduleUrl: "https://hone.care/reschedule/tok_SYNTH",
  treatmentTimeLine: null,
};

const SENDERS = {
  confirmation: (s: Studio) =>
    sendBookingConfirmationToClient({ ...common, studio: s, intakeUrl: null, appBaseUrl: "https://hone.care" }),
  reminder_24h: (s: Studio) => send24hReminderToClient({ ...common, studio: s }),
  reminder_2h: (s: Studio) => send2hReminderToClient({ ...common, studio: s }),
};

function only(): Captured {
  expect(mail).toHaveLength(1);
  return mail[0];
}
const icsOf = (m: Captured) =>
  (m.attachments ?? []).map((a) => a.content.toString("utf8")).join("\n");
const snapshot = (m: Captured) => ({ ...m, attachments: icsOf(m) });

beforeEach(() => {
  mail.length = 0;
  vi.stubEnv("RESEND_API_KEY", "synthetic");
});

describe("today: a production row (no visibility column) sends today's email", () => {
  it("the confirmation carries the stored address in html, text and the .ics LOCATION", async () => {
    await SENDERS.confirmation(studio());
    const m = only();
    // The template's own address block, byte for byte.
    expect(m.html).toContain(`<br/><br/>${ADDRESS}`);
    expect(m.text).toContain(`\n${ADDRESS}\n`);
    expect(icsOf(m)).toMatch(/LOCATION:100 Synthetic Avenue/);
  });

  it("the 24h reminder carries the stored address exactly as the template renders it", async () => {
    await SENDERS.reminder_24h(studio());
    const m = only();
    const direct = build24hReminderEmail({
      clientName: "Synthetic Client",
      studioName: "Synthetic Studio",
      studioAddress: ADDRESS,
      practitionerName: "Synthetic Practitioner",
      serviceName: "Synthetic Consultation",
      durationMinutes: 60,
      startsAt: START,
      endsAt: END,
      timezone: "America/Toronto",
      cancellationUrl: common.cancellationUrl,
      rescheduleUrl: common.rescheduleUrl,
      portalLoginUrl: "https://hone.care/portal/login?studio=synthetic",
      preCareInstructions: null,
      treatmentTimeLine: null,
      bookingReference: "x",
    });
    expect(m.text).toContain(`\n${ADDRESS}\n`);
    expect(direct.text).toContain(`\n${ADDRESS}\n`);
  });

  it.each(Object.entries(SENDERS))("%s: an explicit 'both' is identical to a row without the column", async (_n, send) => {
    await send(studio());
    const before = snapshot(only());
    mail.length = 0;
    await send(studio({ address_visibility: "both" }));
    expect(snapshot(only())).toEqual(before);
  });

  it.each(Object.entries(SENDERS))("%s: an unknown visibility value reads as 'both'", async (_n, send) => {
    await send(studio());
    const before = snapshot(only());
    mail.length = 0;
    await send(studio({ address_visibility: "everyone" }));
    expect(snapshot(only())).toEqual(before);
  });
});

describe.each(Object.entries(SENDERS))("routing once the column exists: %s", (name, send) => {
  it("'emails' shows the address in the email", async () => {
    await send(studio({ address_visibility: "emails" }));
    const m = only();
    expect(m.html).toContain(ADDRESS);
    expect(m.text).toContain(ADDRESS);
  });

  it("'booking_page' keeps the address out of html, text and subject", async () => {
    await send(studio({ address_visibility: "booking_page" }));
    const m = only();
    expect(m.html).not.toContain(ADDRESS);
    expect(m.text).not.toContain(ADDRESS);
    expect(m.subject).not.toContain(ADDRESS);
    if (name === "confirmation") expect(icsOf(m)).not.toMatch(/LOCATION:/);
  });

  it("a whitespace-only address renders no address block", async () => {
    await send(studio({ address: "   " }));
    const m = only();
    expect(m.html).not.toContain("<br/><br/>   ");
    if (name === "confirmation") expect(icsOf(m)).not.toMatch(/LOCATION:/);
  });
});

// The appointment-update sender loads its own row. Its select is unchanged
// (the column does not exist); the fake serves rows with and without it.
function admin(studioRow: Record<string, unknown>) {
  const row = {
    id: "00000000-0000-4000-8000-0000000000b1",
    starts_at: START.toISOString(),
    client: { name: "Synthetic Client", email: "client@synthetic.test" },
    service: { name: "Synthetic Consultation" },
    studio: studioRow,
    practitioner: { display_name: "Synthetic Practitioner" },
  };
  const q = { eq: () => q, maybeSingle: async () => ({ data: row, error: null }) };
  return { from: () => ({ select: () => q }) } as never;
}
const studioRow = (fields: Record<string, unknown> = {}) => ({
  name: "Synthetic Studio",
  timezone: "America/Toronto",
  address: ADDRESS,
  owner_email: "owner@synthetic.test",
  postcare_contact_email: null,
  ...fields,
});
const move = (a: never) =>
  notifyAppointmentMoved(a, {
    appointmentId: "00000000-0000-4000-8000-0000000000b1",
    studioId: "00000000-0000-4000-8000-0000000000a1",
    appOrigin: "https://hone.care",
    resultKind: "moved",
  } as never);

describe("appointment-update email", () => {
  it("a production row shows the address, as today", async () => {
    await move(admin(studioRow()));
    expect(only().text).toContain(ADDRESS);
  });

  it("'booking_page' keeps it out; 'emails' and 'both' keep it", async () => {
    await move(admin(studioRow({ address_visibility: "booking_page" })));
    expect(only().text).not.toContain(ADDRESS);
    for (const v of ["emails", "both"]) {
      mail.length = 0;
      await move(admin(studioRow({ address_visibility: v })));
      expect(only().text).toContain(ADDRESS);
    }
  });
});
