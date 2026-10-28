import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// HON-47 — the staff "appointment moved" email and the SMS manage line.
// ===========================================================================
//
// Both carry links into /manage and /reschedule. Each must carry only what the
// studio offers online, and must still deliver when it offers nothing.

vi.mock("server-only", () => ({}));

const sent = vi.hoisted(() => [] as Array<{ html: string; text: string }>);
vi.mock("@/lib/email/client", () => ({
  FROM_ADDRESS: "Hone <hello@hone.care>",
  getResendTransport: () => ({
    emails: {
      send: async (payload: { html: string; text: string }) => {
        sent.push(payload);
        return { data: { id: "msg_synthetic" }, error: null };
      },
    },
  }),
}));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => undefined }));
vi.stubEnv("APPOINTMENT_SIGNING_SECRET", "synthetic-secret-for-hmac-tests-only-0123456789");

const { notifyAppointmentMoved, buildAppointmentMovedEmail } = await import(
  "@/lib/email/notify-appointment-moved"
);
const { smsManageUrlFor } = await import("@/lib/sms/send-appointment");

const ORIGIN = "https://app.example.invalid";

function fakeAdmin(studioRow: Record<string, unknown> | null, studioError: { code: string } | null = null) {
  return {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (table === "studios") return { data: studioRow, error: studioError };
          return {
            data: {
              id: "00000000-0000-4000-8000-0000000000a1",
              starts_at: "2031-03-04T15:00:00Z",
              client: { name: "Synthetic Client", email: "client@example.invalid" },
              service: { name: "Synthetic Service" },
              studio: { name: "Synthetic Studio", timezone: "America/Toronto", owner_email: "owner@example.invalid", postcare_contact_email: null },
              practitioner: null,
            },
            error: null,
          };
        },
      };
      return chain;
    },
  };
}

async function moved(studioRow: Record<string, unknown> | null, studioError: { code: string } | null = null) {
  sent.length = 0;
  const status = await notifyAppointmentMoved(fakeAdmin(studioRow, studioError) as never, {
    appointmentId: "00000000-0000-4000-8000-0000000000a1",
    studioId: "00000000-0000-4000-8000-000000000047",
    appOrigin: ORIGIN,
  });
  const m = sent[0];
  return { status, both: m ? `${m.html}\n${m.text}` : "" };
}

beforeEach(() => {
  sent.length = 0;
});

describe("staff 'appointment moved' email", () => {
  it("DEFAULT (no policy columns): Reschedule and manage links, exactly as before", async () => {
    const r = await moved({ id: "s", name: "Synthetic Studio" });
    expect(r.status).toBe("sent");
    expect(r.both).toContain(`${ORIGIN}/reschedule/`);
    expect(r.both).toContain(`${ORIGIN}/manage/`);
    expect(r.both).toContain("Manage or reschedule:");
  });

  it("rescheduling off: manage link only, no reschedule link", async () => {
    const r = await moved({ id: "s", name: "Synthetic Studio", client_reschedule_enabled: false });
    expect(r.status).toBe("sent");
    expect(r.both).not.toContain("/reschedule/");
    expect(r.both).toContain(`${ORIGIN}/manage/`);
  });

  it("all off: still delivered, with the contact line and no link", async () => {
    const r = await moved({
      id: "s",
      name: "Synthetic Studio",
      client_reschedule_enabled: false,
      client_cancellation_enabled: false,
      client_portal_enabled: false,
    });
    expect(r.status).toBe("sent");
    expect(r.both).not.toMatch(/\/(manage|reschedule)\//);
    expect(r.both).toContain("Please contact Synthetic Studio directly.");
    expect(r.both).toContain("Synthetic Service");
  });

  it("an UNREADABLE policy withdraws every link but still delivers the update", async () => {
    const silence = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await moved(null, { code: "57014" });
    silence.mockRestore();
    expect(r.status).toBe("sent");
    expect(r.both).not.toMatch(/\/(manage|reschedule)\//);
  });

  it("the default builder output is unchanged when both links are present", () => {
    const p = {
      kind: "moved" as const,
      studioName: "Synthetic Studio",
      serviceName: "Synthetic Service",
      startsAt: new Date("2031-03-04T15:00:00Z"),
      timezone: "America/Toronto",
      practitionerName: null,
      manageUrl: `${ORIGIN}/manage/T`,
      rescheduleUrl: `${ORIGIN}/reschedule/T`,
      bookingReference: "K3M9QX",
    };
    const e = buildAppointmentMovedEmail(p);
    expect(e.html).toContain(
      `Need to make a change? <a href="${ORIGIN}/reschedule/T">Reschedule</a> or <a href="${ORIGIN}/manage/T">manage your appointment</a>.`,
    );
    expect(e.text).toContain(`Manage or reschedule: ${ORIGIN}/manage/T\n`);
  });
});

describe("SMS manage line", () => {
  const URL = `${ORIGIN}/manage/T`;
  it("DEFAULT (no policy columns): the manage line is kept", () => {
    expect(smsManageUrlFor({}, URL)).toBe(URL);
  });
  it.each([
    [{ client_cancellation_enabled: false }, URL],
    [{ client_reschedule_enabled: false }, URL],
    [{ client_portal_enabled: false }, URL],
    [{ client_cancellation_enabled: false, client_reschedule_enabled: false }, URL],
    [{ client_cancellation_enabled: false, client_reschedule_enabled: false, client_portal_enabled: false }, null],
  ])("%o -> %s", (flags, expected) => {
    expect(smsManageUrlFor(flags, URL)).toBe(expected);
  });
  it("both SMS send paths (confirmation and reminders) apply it", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../lib/sms/send-appointment.ts"), "utf8");
    expect(source).toContain("manageUrl: smsManageUrlFor(input.studio, input.manageUrl)");
    expect(source).toContain("manageUrl: smsManageUrlFor(args.studio, args.manageUrlFor(startsAt))");
  });
});
