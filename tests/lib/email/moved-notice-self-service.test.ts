import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// HON-47 — the moved-appointment notice must not promise rescheduling in the
// PLAIN-TEXT part after dropping it from the HTML (Codex 4309085858).
// ===========================================================================
//
// WHAT WENT WRONG, and why it is worth a test of its own. Slice 3 suppressed
// the reschedule link when a studio switches client rescheduling off, and it
// changed the HTML correctly — but the text alternative still read
// "Manage or reschedule: <url>". Two renderings of one email disagreed, and the
// text part is not a fallback nobody sees: plain-text clients render it, and so
// do some accessibility and preview tools.
//
// So BOTH parts are asserted here, for both states of the flag. An HTML-only
// assertion is what let this through.

const sent: Array<{ subject: string; html: string; text: string; to: string }> = [];

vi.mock("@/lib/email/send-appointment", () => ({
  sendEmailSafely: async (opts: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }) => {
    sent.push({ to: opts.to, subject: opts.subject, html: opts.html, text: opts.text });
    return { ok: true };
  },
}));

vi.mock("@/lib/booking/tokens", () => ({
  generateCancellationToken: () => "moved-raw-token",
}));

const { notifyAppointmentMoved } = await import("@/lib/email/notify-appointment-moved");

const STUDIO_ID = "4f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b";
const APPT_ID = "9e8d7c6b-5a49-4382-a716-152433221100";
const ORIGIN = "https://hone.care";

const scenario = { rescheduleEnabled: true, cancellationEnabled: true };

function admin() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    async maybeSingle() {
      return {
        data: {
          id: APPT_ID,
          starts_at: "2026-11-02T17:00:00.000Z",
          client: { name: "Synthetic Client", email: "client@synthetic.test" },
          service: { name: "Full Face" },
          studio: {
            name: "Test Studio",
            timezone: "UTC",
            owner_email: "owner@synthetic.test",
            postcare_contact_email: null,
            client_cancellation_enabled: scenario.cancellationEnabled,
            client_reschedule_enabled: scenario.rescheduleEnabled,
          },
          practitioner: { display_name: "Practitioner" },
        },
        error: null,
      };
    },
  };
  return { from: () => chain } as never;
}

const run = () =>
  notifyAppointmentMoved(admin(), {
    appointmentId: APPT_ID,
    studioId: STUDIO_ID,
    appOrigin: ORIGIN,
  });

beforeEach(() => {
  sent.length = 0;
  scenario.rescheduleEnabled = true;
  scenario.cancellationEnabled = true;
});

describe("the moved notice agrees with itself across HTML and text", () => {
  it("CONTROL — rescheduling ON: both parts offer it", async () => {
    expect(await run()).toBe("sent");
    const { html, text } = sent[0]!;
    expect(html).toContain(`${ORIGIN}/reschedule/moved-raw-token`);
    expect(html).toContain("Reschedule");
    // The text part names both, which is the behaviour this case preserves.
    expect(text).toContain("Manage or reschedule");
    expect(text).toContain(`${ORIGIN}/manage/moved-raw-token`);
  });

  it("rescheduling OFF: NEITHER part promises it", async () => {
    scenario.rescheduleEnabled = false;
    expect(await run()).toBe("sent");
    const { html, text } = sent[0]!;

    // HTML: no link, and no "Reschedule" label pointing nowhere.
    expect(html).not.toContain("/reschedule/");
    expect(html).not.toContain("Reschedule");
    expect(html).toContain(`${ORIGIN}/manage/moved-raw-token`);
    expect(html).toContain("Manage your appointment");

    // TEXT: the half that was wrong. The label is derived from the same
    // condition as the HTML, so it cannot promise what the HTML withdrew.
    expect(text, "the text part must not promise rescheduling").not.toContain(
      "reschedule",
    );
    expect(text).not.toContain("Reschedule");
    expect(text).toContain("Manage your appointment");
    expect(text).toContain(`${ORIGIN}/manage/moved-raw-token`);

    // /manage is never suppressed — it is the honest fallback, and both parts
    // still carry it.
    expect(html).toContain("/manage/");
    expect(text).toContain("/manage/");
  });

  it("the two parts never disagree about rescheduling, in either state", async () => {
    // Stated as a RELATION rather than two independent string checks: the
    // defect was precisely that one part said yes while the other said no, and
    // a future edit to either one alone fails here.
    for (const enabled of [true, false]) {
      sent.length = 0;
      scenario.rescheduleEnabled = enabled;
      await run();
      const { html, text } = sent[0]!;
      const htmlOffers = html.toLowerCase().includes("reschedule");
      const textOffers = text.toLowerCase().includes("reschedule");
      expect(
        textOffers,
        `with client_reschedule_enabled=${enabled} the HTML says ${htmlOffers} and the text says ${textOffers}`,
      ).toBe(htmlOffers);
    }
  });
});
