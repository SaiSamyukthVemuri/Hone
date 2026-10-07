import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// SMS-01 — the invitation SMS is wired beside the email, in the SAME request,
// and runs AFTER the practitioner's response.
//
// The raw token exists only in the request that minted the invitation, so the
// text can only be sent here. These cases drive the real adapter
// (`admissionCommandAdapter.inviteToBook`) with the database, the session and
// both channel senders substituted, and `after()` replaced by a queue the test
// drains, and pin:
//
//   * the action answers BEFORE the text runs, so a stalled provider can never
//     hold it open, and the text still runs once the response is out;
//   * both channels receive the SAME invitation id and the SAME secure link;
//   * the practitioner's outcome is still the EMAIL's disposition -- the text
//     can neither improve nor spoil it, even when it throws;
//   * a refused, lost or unreadable admission texts nobody;
//   * an email failure does not stop the text (independent channels).
// ===========================================================================

const RAW = "r".repeat(64);
const ADMITTED = {
  result: "admitted",
  invitation_id: "inv-1",
  raw_token: RAW,
  delivery_email: "prospect@example.test",
  issued_at: "2026-10-07T12:00:00.000Z",
  expires_at: "2026-10-09T12:00:00.000Z",
};

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ rpc }) }));

const getCurrentPractitionerWithStudio = vi.fn();
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: () => getCurrentPractitionerWithStudio(),
}));
const sessionActor = vi.fn();
vi.mock("@/lib/booking/session-actor", () => ({ sessionActor: () => sessionActor() }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://hone.care" }));

// after(): queued, so "answered before the text ran" is an assertion.
const deferred: Array<() => Promise<void>> = [];
const scheduling = { throws: false };
vi.mock("next/server", () => ({
  after: (work: () => Promise<void>) => {
    if (scheduling.throws) throw new Error("after() called outside a request scope");
    deferred.push(work);
  },
}));
async function flushPostResponse(): Promise<void> {
  for (const work of deferred.splice(0, deferred.length)) await work();
}

const sendWaitlistInvitationEmail = vi.fn();
vi.mock("@/lib/waitlist/delivery/send", () => ({ sendWaitlistInvitationEmail }));
const sendWaitlistInvitationSms = vi.fn();
vi.mock("@/lib/waitlist/delivery/sms", () => ({ sendWaitlistInvitationSms }));

const { admissionCommandAdapter } = await import("@/lib/waitlist/invite-to-book-adapter");

const invite = () =>
  admissionCommandAdapter.inviteToBook({
    entryId: "11111111-1111-4111-8111-111111111111",
    scope: { serviceId: "svc-1", windowDays: 14, allowedWeekdays: null },
  });

let errors: string[] = [];

beforeEach(() => {
  rpc.mockReset();
  getCurrentPractitionerWithStudio.mockReset();
  sessionActor.mockReset();
  sendWaitlistInvitationEmail.mockReset();
  sendWaitlistInvitationSms.mockReset();
  errors = [];
  deferred.length = 0;
  scheduling.throws = false;
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));

  getCurrentPractitionerWithStudio.mockResolvedValue({
    practitioner: { role: "owner", user_id: "user-1" },
    studio: { id: "studio-1", name: "Willow", timezone: "America/Vancouver", slug: "willow" },
  });
  sessionActor.mockResolvedValue({ studioId: "studio-1", actorUserId: "user-1" });
  rpc.mockImplementation((fn: string) =>
    Promise.resolve(
      fn === "admit_new_client_waitlist_entry"
        ? { data: [ADMITTED], error: null }
        : { data: [{ result: "recorded" }], error: null },
    ),
  );
  sendWaitlistInvitationEmail.mockResolvedValue({
    disposition: { delivered: "yes", providerAttempted: true },
    log: {},
  });
  sendWaitlistInvitationSms.mockResolvedValue({ state: "accepted" });
});

describe("both channels, one invitation, one link", () => {
  it("the action answers before the text runs; then both channels get the same invitation and link", async () => {
    const out = await invite();
    expect(out).toEqual({ state: "committed", expiresAt: ADMITTED.expires_at, delivery: "accepted" });
    expect(sendWaitlistInvitationEmail).toHaveBeenCalledTimes(1);
    expect(sendWaitlistInvitationSms, "the text ran inside the response path").not.toHaveBeenCalled();

    await flushPostResponse();
    expect(sendWaitlistInvitationSms).toHaveBeenCalledTimes(1);
    const email = sendWaitlistInvitationEmail.mock.calls[0]![0] as Record<string, unknown>;
    const sms = sendWaitlistInvitationSms.mock.calls[0]![0] as Record<string, unknown>;
    expect(sms.invitationId).toBe("inv-1");
    expect(email.invitationId).toBe("inv-1");
    expect(sms.invitationUrl).toBe(`https://hone.care/invitation/${RAW}`);
    expect(sms.invitationUrl).toBe(email.invitationUrl);
    expect(sms.studio).toMatchObject({ id: "studio-1", name: "Willow" });
  });
});

describe("the text never holds the response open", () => {
  it("a text that never finishes cannot delay the answer", async () => {
    sendWaitlistInvitationSms.mockImplementation(() => new Promise(() => undefined));
    const out = await invite();
    expect(out).toMatchObject({ state: "committed", delivery: "accepted" });
    expect(deferred).toHaveLength(1); // scheduled, not awaited
  });

  it("outside a request scope the text still runs, fire-and-forget", async () => {
    scheduling.throws = true;
    await invite();
    await Promise.resolve();
    expect(sendWaitlistInvitationSms).toHaveBeenCalledTimes(1);
  });
});

describe("the text never changes the practitioner's outcome", () => {
  it("a skipped or refused text leaves the email's disposition as the answer", async () => {
    for (const state of [{ state: "skipped", reason: "mobile_unverified" }, { state: "refused" }]) {
      sendWaitlistInvitationSms.mockResolvedValueOnce(state);
      expect(await invite()).toMatchObject({ state: "committed", delivery: "accepted" });
    }
  });

  it("a text path that THROWS is contained and logged without the token", async () => {
    sendWaitlistInvitationSms.mockRejectedValueOnce(new Error(`boom ${RAW}`));
    expect(await invite()).toEqual({ state: "committed", expiresAt: ADMITTED.expires_at, delivery: "accepted" });
    await flushPostResponse();
    const all = errors.join("\n");
    expect(all).toContain("waitlist_invitation_sms_failed");
    expect(all).not.toContain(RAW);
  });

  it("an email failure does not stop the text", async () => {
    sendWaitlistInvitationEmail.mockRejectedValueOnce(new Error("resend down"));
    const out = await invite();
    expect(out).toMatchObject({ state: "committed", delivery: "unknown" });
    await flushPostResponse();
    expect(sendWaitlistInvitationSms).toHaveBeenCalledTimes(1);
  });
});

describe("no admission, no text", () => {
  it("a refused admission texts nobody", async () => {
    rpc.mockImplementation(() => Promise.resolve({ data: [{ result: "round_full" }], error: null }));
    await invite();
    await flushPostResponse();
    expect(sendWaitlistInvitationSms).not.toHaveBeenCalled();
    expect(sendWaitlistInvitationEmail).not.toHaveBeenCalled();
  });

  it("a lost answer (transport error) texts nobody", async () => {
    rpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: "socket hang up" } }));
    await invite();
    await flushPostResponse();
    expect(sendWaitlistInvitationSms).not.toHaveBeenCalled();
  });

  it("a committed row that cannot be read texts nobody", async () => {
    rpc.mockImplementation(() =>
      Promise.resolve({ data: [{ ...ADMITTED, raw_token: null }], error: null }),
    );
    await invite();
    await flushPostResponse();
    expect(sendWaitlistInvitationSms).not.toHaveBeenCalled();
  });
});
