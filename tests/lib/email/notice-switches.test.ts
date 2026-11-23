import { beforeEach, describe, expect, it, vi } from "vitest";

// Separate studio switches for the client notices that follow a change to a booked appointment (0373):
//   send_moved_appointment_emails, send_client_cancellation_emails.
// Each is read live at send time, defaults ON, and is independent of send_confirmation_emails. Fake provider and fake database
// only: nothing is sent. Synthetic data only.

vi.mock("server-only", () => ({}));

const sent = vi.hoisted(() => [] as Array<{ to: unknown }>);
const provider = vi.hoisted(() => ({ refuse: false }));
vi.mock("@/lib/email/client", () => ({
  FROM_ADDRESS: "Hone <hello@hone.care>",
  getResendTransport: () => ({
    emails: {
      send: async (payload: { to: unknown }) => {
        sent.push({ to: payload.to });
        return provider.refuse
          ? { data: null, error: { name: "application_error", message: "PRIVATE provider detail" } }
          : { data: { id: "msg_synthetic" }, error: null };
      },
    },
  }),
}));
const alerts = vi.hoisted(() => [] as unknown[]);
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async (a: unknown) => { alerts.push(a); } }));
vi.stubEnv("APPOINTMENT_SIGNING_SECRET", "synthetic-secret-for-hmac-tests-only-0123456789");

const { readNoticeSwitch } = await import("@/lib/email/notice-switches");
const { notifyAppointmentMoved } = await import("@/lib/email/notify-appointment-moved");

const STUDIO = "00000000-0000-4000-8000-000000000047";
const APPT = "00000000-0000-4000-8000-0000000000a1";
const MOVED = "send_moved_appointment_emails" as const;
const CANCEL = "send_client_cancellation_emails" as const;

type Reply = { data: unknown; error: { code?: string } | null } | "throw";
const reads: string[] = [];
function admin(studioSwitchReply: Reply, other: { clientEmail?: string | null } = {}) {
  return {
    from(table: string) {
      let columns = "";
      const chain = {
        select: (c: string) => { columns = c; return chain; },
        eq: () => chain,
        maybeSingle: async () => {
          if (table === "studios") {
            reads.push(columns);
            if (studioSwitchReply === "throw") throw new Error("PRIVATE read threw");
            // The one-column switch read answers with the reply; the self-service policy read gets an empty row (defaults).
            return columns === MOVED || columns === CANCEL ? studioSwitchReply : { data: {}, error: null };
          }
          return {
            data: {
              id: APPT,
              starts_at: "2031-03-04T15:00:00Z",
              client: { name: "Synthetic Client", email: other.clientEmail === undefined ? "client@example.invalid" : other.clientEmail },
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
  } as never;
}

beforeEach(() => {
  sent.length = 0;
  alerts.length = 0;
  reads.length = 0;
  provider.refuse = false;
});

describe("readNoticeSwitch", () => {
  it.each([MOVED, CANCEL])("%s: true is on, false is off", async (key) => {
    expect(await readNoticeSwitch(admin({ data: { [key]: true }, error: null }), STUDIO, key)).toBe("on");
    expect(await readNoticeSwitch(admin({ data: { [key]: false }, error: null }), STUDIO, key)).toBe("off");
  });

  it.each([MOVED, CANCEL])("%s: an absent or null value is the default, ON (a row from before the column existed)", async (key) => {
    expect(await readNoticeSwitch(admin({ data: {}, error: null }), STUDIO, key)).toBe("on");
    expect(await readNoticeSwitch(admin({ data: { [key]: null }, error: null }), STUDIO, key)).toBe("on");
  });

  it.each([MOVED, CANCEL])("%s: a database without the column yet (42703) is the default, ON", async (key) => {
    expect(await readNoticeSwitch(admin({ data: null, error: { code: "42703" } }), STUDIO, key)).toBe("on");
  });

  it.each([MOVED, CANCEL])("%s: any other read failure, a missing studio, a throw, or a non-boolean is UNAVAILABLE, never on", async (key) => {
    expect(await readNoticeSwitch(admin({ data: null, error: { code: "XX000" } }), STUDIO, key)).toBe("unavailable");
    expect(await readNoticeSwitch(admin({ data: null, error: null }), STUDIO, key)).toBe("unavailable");
    expect(await readNoticeSwitch(admin("throw"), STUDIO, key)).toBe("unavailable");
    for (const junk of ["false", "true", 0, 1, {}]) {
      expect(await readNoticeSwitch(admin({ data: { [key]: junk }, error: null }), STUDIO, key)).toBe("unavailable");
    }
  });

  it("each switch reads only its own column, never the booking-confirmation switch", async () => {
    await readNoticeSwitch(admin({ data: { [MOVED]: true }, error: null }), STUDIO, MOVED);
    await readNoticeSwitch(admin({ data: { [CANCEL]: true }, error: null }), STUDIO, CANCEL);
    expect(reads).toEqual([MOVED, CANCEL]);
  });
});

describe("the moved-appointment email follows its own switch", () => {
  const run = (reply: Reply, other?: { clientEmail?: string | null }) =>
    notifyAppointmentMoved(admin(reply, other), { appointmentId: APPT, studioId: STUDIO, appOrigin: "https://app.example.invalid" });

  it("ON: sends one email to the client", async () => {
    expect(await run({ data: { [MOVED]: true }, error: null })).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("ABSENT (default): sends, so shipping the code before the column changes nothing", async () => {
    expect(await run({ data: {}, error: null })).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("OFF: sends nothing and reports a quiet skip, not a failure", async () => {
    expect(await run({ data: { [MOVED]: false }, error: null })).toBe("skipped");
    expect(sent).toHaveLength(0);
    expect(alerts).toEqual([]);
  });

  it("UNREADABLE setting: sends nothing, reports not delivered, and raises one alert with no private detail", async () => {
    expect(await run({ data: null, error: { code: "XX000" } })).toBe("degraded");
    expect(sent).toHaveLength(0);
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts)).not.toMatch(/PRIVATE|client@example/);
  });

  it("a client with no email is skipped before the setting is even read", async () => {
    expect(await run({ data: { [MOVED]: true }, error: null }, { clientEmail: null })).toBe("skipped");
    expect(reads).not.toContain(MOVED);
  });

  it("the OTHER switch does not matter: cancellation off, moved on still sends", async () => {
    // The fake answers only the moved column's reply; a read of the cancellation column would be a different question.
    expect(await run({ data: { [MOVED]: true, [CANCEL]: false }, error: null })).toBe("sent");
    expect(reads.filter((c) => c === CANCEL)).toEqual([]);
  });

  it("a refused send is reported as not delivered and is NOT retried (exactly one attempt)", async () => {
    provider.refuse = true;
    expect(await run({ data: { [MOVED]: true }, error: null })).toBe("degraded");
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(alerts)).not.toMatch(/PRIVATE/);
  });
});
