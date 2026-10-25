// HON-50 PR B. Arrival/parking instructions and owner-chosen address
// visibility in the client appointment emails, proved two ways:
//
//   1. the builders: every intended email (confirmation, 24h and 2h reminders,
//      the three appointment-update kinds), html AND text;
//   2. captured mail: the real senders run against a capturing transport
//      (lib/email/client is replaced), so what is asserted is the payload
//      Resend would receive, including the .ics attachment.
//
// Invariants: a blank value renders no section and byte-identical output; the
// default (columns absent, or visibility 'both') is today's output; nothing new
// reaches the subject or the preview window (#828 / #1049). All values are
// synthetic.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Captured = {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: ReadonlyArray<{ filename: string; content: Buffer }>;
};
const mail = vi.hoisted(() => [] as Captured[]);
const selects = vi.hoisted(() => [] as string[]);

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

import { buildClientConfirmationEmail } from "@/lib/email/templates/appointment";
import { build24hReminderEmail, build2hReminderEmail } from "@/lib/email/templates/reminders";
import {
  buildAppointmentMovedEmail,
  notifyAppointmentMoved,
  type MoveNotificationKind,
} from "@/lib/email/notify-appointment-moved";
import {
  send24hReminderToClient,
  send2hReminderToClient,
  sendBookingConfirmationToClient,
} from "@/lib/email/send-appointment";
import type { Studio } from "@/lib/types/database";

const ADDRESS = "100 Synthetic Avenue, Suite 2, Toronto ON";
const ARRIVAL = "Park on Synthetic Street.\nRing the side-door buzzer <2>.";
const ARRIVAL_HTML = "Park on Synthetic Street.\nRing the side-door buzzer &lt;2&gt;.";
const START = new Date("2031-03-04T20:45:00Z");
const END = new Date("2031-03-04T21:45:00Z");
const BLANKS = [undefined, null, "", "   ", "\n\t "] as const;

// --------------------------------------------------------------------------
// 1. Builders
// --------------------------------------------------------------------------

type Built = { subject: string; html: string; text: string };
type Builder = (arrival: string | null | undefined, address?: string | null) => Built;

const reminderBase = (address: string | null) => ({
  clientName: "Synthetic Client",
  studioName: "Synthetic Studio",
  studioAddress: address,
  practitionerName: "Synthetic Practitioner",
  serviceName: "Synthetic Consultation",
  durationMinutes: 60,
  startsAt: START,
  endsAt: END,
  timezone: "America/Toronto",
  cancellationUrl: "https://hone.care/cancel/tok_SYNTH",
  rescheduleUrl: "https://hone.care/reschedule/tok_SYNTH",
  portalLoginUrl: "https://hone.care/portal/login?studio=synthetic",
  preCareInstructions: null,
  treatmentTimeLine: null,
  bookingReference: "REF-SYNTH",
});

function withArrival<T extends object>(base: T, arrival: string | null | undefined) {
  return arrival === undefined ? base : { ...base, arrivalInstructions: arrival };
}

const BUILDERS: Record<string, Builder> = {
  confirmation: (arrival, address = ADDRESS) =>
    buildClientConfirmationEmail(
      withArrival(
        { ...reminderBase(address), studioEmail: "studio@synthetic.test", intakeUrl: null },
        arrival,
      ),
    ),
  reminder_24h: (arrival, address = ADDRESS) =>
    build24hReminderEmail(withArrival(reminderBase(address), arrival)),
  reminder_2h: (arrival, address = ADDRESS) =>
    build2hReminderEmail(withArrival(reminderBase(address), arrival)),
  ...Object.fromEntries(
    (["moved", "reassigned", "moved_and_reassigned"] as MoveNotificationKind[]).map((kind) => [
      `update_${kind}`,
      ((arrival, address = ADDRESS) =>
        buildAppointmentMovedEmail(
          withArrival(
            {
              kind,
              studioName: "Synthetic Studio",
              studioAddress: address,
              serviceName: "Synthetic Consultation",
              startsAt: START,
              timezone: "America/Toronto",
              practitionerName: "Synthetic Practitioner",
              manageUrl: "https://hone.care/manage/tok_SYNTH",
              rescheduleUrl: "https://hone.care/reschedule/tok_SYNTH",
              bookingReference: "REF-SYNTH",
            },
            arrival,
          ),
        )) as Builder,
    ]),
  ),
};

describe.each(Object.entries(BUILDERS))("%s: arrival and parking section", (_name, build) => {
  it("renders the heading and the escaped instructions in html, and both in text", () => {
    const e = build(ARRIVAL);
    expect(e.html).toContain("<strong>Arrival and parking</strong>");
    expect(e.html).toContain(ARRIVAL_HTML);
    expect(e.html).not.toContain("buzzer <2>");
    expect(e.text).toContain(`Arrival and parking:\n${ARRIVAL}`);
  });

  it("sits after the address, in the body, never in the subject or the opening lead", () => {
    const e = build(ARRIVAL);
    expect(e.subject).not.toMatch(/arrival|park|buzzer/i);
    expect(e.html.indexOf("Arrival and parking")).toBeGreaterThan(e.html.indexOf(ADDRESS));
    expect(e.text.indexOf("Arrival and parking")).toBeGreaterThan(e.text.indexOf(ADDRESS));
    // The preview window: the first lines of the text body name only the studio.
    const preview = e.text.slice(0, 160);
    expect(preview).not.toMatch(/arrival|park|buzzer/i);
  });

  it("renders even when the studio has no address (instructions do not depend on it)", () => {
    const e = build(ARRIVAL, null);
    expect(e.text).toContain(`Arrival and parking:\n${ARRIVAL}`);
    expect(e.html).not.toContain(ADDRESS);
  });

  it.each(BLANKS)("a blank value (%j) renders no section and byte-identical output", (blank) => {
    const today = build(undefined);
    const e = build(blank);
    expect(e).toEqual(today);
    expect(e.html).not.toContain("Arrival and parking");
    expect(e.text).not.toContain("Arrival and parking");
  });
});

// --------------------------------------------------------------------------
// 2. Captured mail through the real senders
// --------------------------------------------------------------------------

function studio(fields: Partial<Studio> = {}): Studio {
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

beforeEach(() => {
  mail.length = 0;
  selects.length = 0;
  vi.stubEnv("RESEND_API_KEY", "synthetic");
});

describe.each(Object.entries(SENDERS))("captured mail: %s", (name, send) => {
  it("columns absent (pre-migration row): today's email, address shown", async () => {
    await send(studio());
    const m = only();
    expect(m.html).toContain(ADDRESS);
    expect(m.text).toContain(ADDRESS);
    expect(m.text).not.toContain("Arrival and parking");
  });

  it("visibility 'both' sends exactly what a pre-migration row sends", async () => {
    await send(studio());
    const before = only();
    mail.length = 0;
    await send(studio({ address_visibility: "both", arrival_instructions: null }));
    const after = only();
    expect({ ...after, attachments: icsOf(after) }).toEqual({ ...before, attachments: icsOf(before) });
  });

  it("visibility 'emails' shows the address in the email", async () => {
    await send(studio({ address_visibility: "emails" }));
    const m = only();
    expect(m.html).toContain(ADDRESS);
    expect(m.text).toContain(ADDRESS);
  });

  it("visibility 'booking_page' keeps the address out of the email (html, text, subject)", async () => {
    await send(studio({ address_visibility: "booking_page" }));
    const m = only();
    expect(m.html).not.toContain(ADDRESS);
    expect(m.text).not.toContain(ADDRESS);
    expect(m.subject).not.toContain(ADDRESS);
    if (name === "confirmation") expect(icsOf(m)).not.toContain("Synthetic Avenue");
  });

  it("arrival instructions are carried in html and text, not the subject", async () => {
    await send(studio({ arrival_instructions: ARRIVAL }));
    const m = only();
    expect(m.html).toContain(ARRIVAL_HTML);
    expect(m.text).toContain(`Arrival and parking:\n${ARRIVAL}`);
    expect(m.subject).not.toMatch(/arrival|park/i);
  });

  it("whitespace-only arrival instructions send today's email", async () => {
    await send(studio());
    const before = only();
    mail.length = 0;
    await send(studio({ arrival_instructions: "   \n " }));
    expect(only().text).toBe(before.text);
  });
});

describe("captured mail: the confirmation's calendar invite follows the email visibility", () => {
  it("LOCATION carries the address for both and emails", async () => {
    for (const v of ["both", "emails"] as const) {
      mail.length = 0;
      await SENDERS.confirmation(studio({ address_visibility: v }));
      expect(icsOf(only())).toMatch(/LOCATION:100 Synthetic Avenue/);
    }
  });

  it("LOCATION is absent for booking_page and for a blank address", async () => {
    await SENDERS.confirmation(studio({ address_visibility: "booking_page" }));
    expect(icsOf(only())).not.toMatch(/LOCATION:/);
    mail.length = 0;
    await SENDERS.confirmation(studio({ address: "   " }));
    expect(icsOf(only())).not.toMatch(/LOCATION:/);
  });

  it("arrival instructions are not put in the invite", async () => {
    await SENDERS.confirmation(studio({ arrival_instructions: ARRIVAL }));
    expect(icsOf(only())).not.toMatch(/buzzer|Synthetic Street/);
  });
});

// The appointment-update sender loads its own row.
function admin(studioRow: Record<string, unknown>, opts: { refuseLocationColumns?: boolean } = {}) {
  const row = {
    id: "00000000-0000-4000-8000-0000000000b1",
    starts_at: START.toISOString(),
    client: { name: "Synthetic Client", email: "client@synthetic.test" },
    service: { name: "Synthetic Consultation" },
    studio: studioRow,
    practitioner: { display_name: "Synthetic Practitioner" },
  };
  const chain = (cols: string) => {
    const refused =
      opts.refuseLocationColumns && /address_visibility|arrival_instructions/.test(cols);
    const result = refused
      ? { data: null, error: { code: "42703", message: "column studios_1.address_visibility does not exist" } }
      : { data: row, error: null };
    const q = { eq: () => q, maybeSingle: async () => result };
    return q;
  };
  return {
    from: (table: string) => ({
      select: (cols: string) => {
        // Only the appointment read is this file's subject; other reads (for
        // example HON-47's self-service policy) are not counted.
        if (table === "appointments") selects.push(cols);
        return chain(cols);
      },
    }),
  } as never;
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

describe("captured mail: appointment-update", () => {
  it("reads both location columns with the row", async () => {
    await move(admin(studioRow()));
    expect(selects[0]).toMatch(/studio:studios\([^)]*address_visibility[^)]*arrival_instructions/);
  });

  it("booking_page keeps the address out; emails and both keep it", async () => {
    await move(admin(studioRow({ address_visibility: "booking_page" })));
    expect(only().text).not.toContain(ADDRESS);
    for (const v of ["emails", "both"]) {
      mail.length = 0;
      await move(admin(studioRow({ address_visibility: v })));
      expect(only().text).toContain(ADDRESS);
    }
  });

  it("carries arrival instructions in html and text", async () => {
    await move(admin(studioRow({ arrival_instructions: ARRIVAL })));
    const m = only();
    expect(m.html).toContain(ARRIVAL_HTML);
    expect(m.text).toContain(`Arrival and parking:\n${ARRIVAL}`);
  });

  it("before the migration (42703 on the new columns) it retries once without them and sends today's email", async () => {
    const status = await move(admin(studioRow(), { refuseLocationColumns: true }));
    expect(selects).toHaveLength(2);
    expect(selects[1]).not.toMatch(/address_visibility|arrival_instructions/);
    expect(selects[1]).toMatch(/studio:studios\([^)]*\baddress\b/);
    const m = only();
    expect(m.text).toContain(ADDRESS);
    expect(m.text).not.toContain("Arrival and parking");
    expect(status).not.toBe("degraded");
  });
});
