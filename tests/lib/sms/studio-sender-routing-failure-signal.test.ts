import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// COMMS-01B2 — a routing failure must be LOUD and must not lie about the provider.
//
// The routing check returns before `claimSmsSend`, which is correct: a missing
// sender is a precondition, not a failed send, and must not burn one of the
// row's three attempts. But that same early return has two consequences this
// file exists to pin.
//
//   1. The reminder query keeps seeing attempts below the cap, so the row is
//      re-selected every cron pass and fails identically forever; and the
//      booking and reschedule callers discard the returned result entirely.
//      Without a signal raised at the failure site, a missing sender suppresses
//      every SMS for that studio permanently AND invisibly.
//
//   2. No Twilio request was made, so counting it as an attempt would corrupt
//      the delivery metrics the heartbeat reports.

const resolveMock = vi.fn();
vi.mock("@/lib/sms/sender-routing", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, resolveActiveStudioSender: (...a: unknown[]) => resolveMock(...a) };
});

const recordOpsAlert = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: (...a: unknown[]) => recordOpsAlert(...a),
}));

import { sendBookingConfirmationSmsToClient } from "@/lib/sms/send-appointment";

/** Admin double that records whether the claim RPC was ever reached. */
function admin() {
  const rpcCalls: string[] = [];
  return {
    calls: rpcCalls,
    client: {
      rpc: async (fn: string) => {
        rpcCalls.push(fn);
        return { data: true, error: null };
      },
    } as never,
  };
}

const studio = {
  id: "studio-a",
  name: "A",
  send_confirmation_sms: true,
  send_24h_sms_reminders: true,
  send_2h_sms_reminders: true,
} as never;

const client = {
  phone: "+15555550123",
  sms_consent_at: "2026-01-01T00:00:00.000Z",
  sms_opted_out_at: null,
} as never;

async function attemptSend(a: ReturnType<typeof admin>) {
  return sendBookingConfirmationSmsToClient({
    admin: a.client,
    appointmentId: "appt-1",
    startsAt: new Date("2026-10-01T15:00:00.000Z"),
    timezone: "America/Toronto",
    studio,
    client,
    manageUrl: "https://hone.care/manage/t",
  } as never);
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resolveMock.mockReset();
  recordOpsAlert.mockReset();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

describe("a terminal routing failure is surfaced, and consumes no attempt", () => {
  it("no ACTIVE sender raises an ops alert and never claims", async () => {
    resolveMock.mockResolvedValue({ ok: false, reason: "none_active" });
    const a = admin();

    const r = await attemptSend(a);

    // Terminal, non-retryable, and marked as never having reached the provider.
    expect(r).toMatchObject({
      ok: false,
      preProvider: true,
      error: "sms_sender_not_active_for_studio",
      retryable: false,
    });
    // The claim is what consumes one of the three attempts. It must not run.
    expect(a.calls).not.toContain("claim_sms_send");
    // And it must be LOUD: a structured failure line for the operator. The
    // routing signal moved out of the general SMS failure logger into its own
    // `sms_routing_failed` event when it became awaited and deduped, so the
    // assertion follows the signal rather than pinning the old location.
    expect(errSpy).toHaveBeenCalled();
    const logged = String(errSpy.mock.calls[0]?.[0] ?? "");
    expect(logged).toContain("sms_routing_failed");
    expect(logged).toContain("none_active");
    expect(logged).toContain('"terminal":true');
  });

  it("an ambiguous sender is equally terminal and equally loud", async () => {
    resolveMock.mockResolvedValue({ ok: false, reason: "ambiguous" });
    const a = admin();

    const r = await attemptSend(a);

    expect(r).toMatchObject({
      ok: false,
      preProvider: true,
      error: "sms_sender_ambiguous",
      retryable: false,
    });
    expect(a.calls).not.toContain("claim_sms_send");
    expect(errSpy).toHaveBeenCalled();
  });

  it("a read failure stays RETRYABLE and still never claims", async () => {
    // Transient: the next cron pass should try again, and must not have burned
    // an attempt doing so.
    resolveMock.mockResolvedValue({ ok: false, reason: "read_failed" });
    const a = admin();

    const r = await attemptSend(a);

    expect(r).toMatchObject({
      ok: false,
      preProvider: true,
      error: "sms_sender_read_failed",
      retryable: true,
    });
    expect(a.calls).not.toContain("claim_sms_send");
  });
});

describe("the result shape keeps provider metrics honest", () => {
  it("every routing failure carries preProvider, and none is a plain error", async () => {
    for (const reason of ["none_active", "ambiguous", "read_failed"]) {
      resolveMock.mockResolvedValue({ ok: false, reason });
      const r = await attemptSend(admin());
      // The cron's SMS pass branches on this to keep the row out of
      // attempted/failed. A plain error shape would inflate both on every pass.
      expect(r, `${reason} must be marked pre-provider`).toMatchObject({
        preProvider: true,
      });
      expect((r as { skipped?: boolean }).skipped).not.toBe(true);
    }
  });

  it("a routing failure is NOT a skip — skips are benign, this is terminal", async () => {
    resolveMock.mockResolvedValue({ ok: false, reason: "none_active" });
    const r = await attemptSend(admin());
    // If it were reported as `skipped`, the cron would file it beside a claim
    // collision and no operator would ever look at it.
    expect((r as { skipped?: boolean }).skipped).not.toBe(true);
  });
});
