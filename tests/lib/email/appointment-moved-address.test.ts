import { beforeEach, describe, expect, it, vi } from "vitest";
import { emailBookingReference } from "@/lib/email/booking-reference";
import { plainTextPreview, simulatedPreview } from "./helpers/email-preview";

// HON-50: the "appointment updated" email names where the appointment is, as
// the confirmation and both reminders already do (studios.address, the public
// address set under Settings > Booking). A studio with no address (home-based)
// gets exactly the email it gets today. The address sits in the body under the
// details, never in the subject or the preview window (#828, #1049). Every
// value is synthetic.

const sent = vi.hoisted(() => [] as Array<{ subject: string; html: string; text: string }>);
const selects = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/email/send-appointment", () => ({
  sendEmailSafely: async (opts: { subject: string; html: string; text: string }) => {
    sent.push({ subject: opts.subject, html: opts.html, text: opts.text });
    return { ok: true, messageId: "synthetic" };
  },
}));
vi.mock("@/lib/booking/tokens", () => ({ generateCancellationToken: () => "tok_SYNTH" }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => {} }));

import {
  buildAppointmentMovedEmail,
  notifyAppointmentMoved,
  type MoveNotificationKind,
} from "@/lib/email/notify-appointment-moved";

const KINDS: MoveNotificationKind[] = ["moved", "reassigned", "moved_and_reassigned"];
const ADDRESS = "100 Synthetic Avenue, Suite 2, Toronto ON";

function build(kind: MoveNotificationKind, studioAddress?: string | null) {
  return buildAppointmentMovedEmail({
    kind,
    studioName: "Synthetic Studio",
    ...(studioAddress === undefined ? {} : { studioAddress }),
    serviceName: "Synthetic Consultation",
    startsAt: new Date("2031-03-04T20:45:00Z"),
    timezone: "America/Toronto",
    practitionerName: "Synthetic Practitioner",
    manageUrl: "https://hone.care/manage/tok_SYNTH",
    rescheduleUrl: "https://hone.care/reschedule/tok_SYNTH",
    bookingReference: "REF-SYNTH",
  });
}

describe.each(KINDS)("appointment moved email (%s): the studio address", (kind) => {
  it("appears in the html and text bodies, under the appointment details", () => {
    const { html, text } = build(kind, ADDRESS);
    const details = html.indexOf("Synthetic Consultation");
    const address = html.indexOf(ADDRESS);
    const change = html.indexOf("Need to make a change?");
    expect(details).toBeGreaterThan(-1);
    expect(address).toBeGreaterThan(details);
    expect(change).toBeGreaterThan(address);
    expect(text).toContain(`\n\n${ADDRESS}\n`);
    expect(text.indexOf(ADDRESS)).toBeGreaterThan(text.indexOf("Synthetic Consultation"));
    expect(text.indexOf(ADDRESS)).toBeLessThan(text.indexOf("Booking reference:"));
  });

  it("stays out of the subject and the preview window", () => {
    const { subject, html, text } = build(kind, ADDRESS);
    expect(subject).not.toContain("Synthetic Avenue");
    expect(simulatedPreview(html)).not.toContain("Synthetic Avenue");
    expect(plainTextPreview(text)).not.toContain("Synthetic Avenue");
  });

  it("is escaped in the html", () => {
    const { html, text } = build(kind, `1 <b>Bold</b> & "Quoted" St`);
    expect(html).toContain("1 &lt;b&gt;Bold&lt;/b&gt; &amp; &quot;Quoted&quot; St");
    expect(html).not.toContain("<b>Bold</b>");
    expect(text).toContain(`1 <b>Bold</b> & "Quoted" St`);
  });

  it.each([null, "", "   "])("absent (%j) leaves the email exactly as it is without one", (blank) => {
    expect(build(kind, blank)).toEqual(build(kind));
  });

  it("is trimmed", () => {
    expect(build(kind, `  ${ADDRESS}  `)).toEqual(build(kind, ADDRESS));
  });
});

function admin(address: string | null) {
  const row = {
    id: "appt",
    starts_at: "2031-03-04T20:45:00Z",
    client: { name: "Synthetic Client", email: "client@synthetic.invalid" },
    service: { name: "Synthetic Consultation" },
    studio: {
      name: "Synthetic Studio",
      timezone: "America/Toronto",
      address,
      owner_email: null,
      postcare_contact_email: null,
    },
    practitioner: { display_name: "Synthetic Practitioner" },
  };
  const chain = {
    select: (cols: string) => {
      selects.push(cols);
      return chain;
    },
    eq: () => chain,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return { from: () => chain } as never;
}

describe("notifyAppointmentMoved: the sender reads and passes the studio address", () => {
  beforeEach(() => {
    sent.length = 0;
    selects.length = 0;
  });

  it("selects studios.address with the moved appointment", async () => {
    await notifyAppointmentMoved(admin(ADDRESS), {
      appointmentId: "appt",
      studioId: "studio",
      appOrigin: "https://hone.care",
    });
    expect(selects.join(" ")).toMatch(/studio:studios\([^)]*\baddress\b[^)]*\)/);
  });

  it.each(KINDS)("%s: the sent email carries the address", async (kind) => {
    const status = await notifyAppointmentMoved(admin(ADDRESS), {
      appointmentId: "appt",
      studioId: "studio",
      appOrigin: "https://hone.care",
      resultKind: kind,
    });
    expect(status).toBe("sent");
    expect(sent[0].html).toContain(ADDRESS);
    expect(sent[0].text).toContain(ADDRESS);
  });

  it("a studio with no address sends the email it sends today", async () => {
    await notifyAppointmentMoved(admin(null), {
      appointmentId: "appt",
      studioId: "studio",
      appOrigin: "https://hone.care",
    });
    const withNone = sent[0];
    expect(withNone.text).not.toContain("Synthetic Avenue");
    const expected = buildAppointmentMovedEmail({
      kind: "moved",
      studioName: "Synthetic Studio",
      serviceName: "Synthetic Consultation",
      startsAt: new Date("2031-03-04T20:45:00Z"),
      timezone: "America/Toronto",
      practitionerName: "Synthetic Practitioner",
      manageUrl: "https://hone.care/manage/tok_SYNTH",
      rescheduleUrl: "https://hone.care/reschedule/tok_SYNTH",
      bookingReference: emailBookingReference("appt"),
    });
    expect(withNone.html).toBe(expected.html);
  });
});
