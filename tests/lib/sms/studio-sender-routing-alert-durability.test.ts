import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// COMMS-01B2 — the routing alert must SURVIVE, and must not repeat forever.
//
// Routing fails before the claim, which is correct: a missing sender must not
// burn one of the row's three send attempts. Two consequences follow, and this
// file pins both.
//
//   DURABILITY — the general failure logger persists its alert from an unawaited
//   IIFE. Fine for a transient provider error that will be retried and re-logged;
//   wrong for a terminal routing failure, where a serverless invocation can
//   return and be torn down before the insert lands, losing the one signal an
//   operator gets.
//
//   REPETITION — because no attempt is consumed, the appointment stays eligible
//   and the every-15-minute cron re-selects it forever. Un-deduped, one
//   unprovisioned studio produces ~96 identical unresolved alerts a day, and an
//   unreadable ops list is the same as no alert at all.

const resolveMock = vi.fn();
vi.mock("@/lib/sms/sender-routing", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, resolveActiveStudioSender: (...a: unknown[]) => resolveMock(...a) };
});

let alertSettled = false;
const recordOpsAlert = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {
  // Force real asynchrony so "was it awaited?" is observable rather than
  // accidentally true because the mock resolved synchronously.
  await new Promise((r) => setTimeout(r, 5));
  alertSettled = true;
});
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: (...a: unknown[]) => recordOpsAlert(...a),
}));

import { sendBookingConfirmationSmsToClient } from "@/lib/sms/send-appointment";

/** Admin double over ops_alerts + the claim RPC. */
function admin(openAlerts: Array<{ id: string }> = [], readError: unknown = null) {
  const rpcCalls: string[] = [];
  const filters: Record<string, unknown> = {};
  const client = {
    rpc: async (fn: string) => {
      rpcCalls.push(fn);
      return { data: true, error: null };
    },
    from(table: string) {
      filters.table = table;
      const chain = {
        select: () => chain,
        eq: (c: string, v: unknown) => {
          filters[c] = v;
          return chain;
        },
        is: () => chain,
        limit: async () => ({ data: openAlerts, error: readError }),
      };
      return chain;
    },
  };
  return { client: client as never, rpcCalls, filters };
}

const studio = (id: string | null) =>
  ({
    id,
    name: "S",
    send_confirmation_sms: true,
    send_24h_sms_reminders: true,
    send_2h_sms_reminders: true,
  }) as never;

const client = {
  phone: "+15555550123",
  sms_consent_at: "2026-01-01T00:00:00.000Z",
  sms_opted_out_at: null,
} as never;

async function send(a: ReturnType<typeof admin>, studioId: string | null = "studio-a") {
  return sendBookingConfirmationSmsToClient({
    admin: a.client,
    appointmentId: "appt-1",
    startsAt: new Date("2026-10-01T15:00:00.000Z"),
    timezone: "America/Toronto",
    studio: studio(studioId),
    client,
    manageUrl: "https://hone.care/manage/t",
  } as never);
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resolveMock.mockReset();
  recordOpsAlert.mockReset();
  alertSettled = false;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe("the terminal alert is DURABLE — awaited, not fire-and-forget", () => {
  it("no ACTIVE sender: the alert has fully settled before the send returns", async () => {
    resolveMock.mockResolvedValue({ ok: false, reason: "none_active" });
    const a = admin();

    const r = await send(a);

    // THE MUTATION TARGET. Under fire-and-forget this is false: the send
    // resolves while the insert is still in flight, and a torn-down invocation
    // loses it.
    expect(alertSettled).toBe(true);
    expect(recordOpsAlert).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, preProvider: true, retryable: false });
    // Still pre-provider: no attempt claimed.
    expect(a.rpcCalls).not.toContain("claim_sms_send");
  });

  it("an ambiguous sender is equally durable", async () => {
    resolveMock.mockResolvedValue({ ok: false, reason: "ambiguous" });
    await send(admin());
    expect(alertSettled).toBe(true);
    expect(recordOpsAlert).toHaveBeenCalledTimes(1);
  });

  it("an alert INSERT failure does not break the booking path", async () => {
    // Alerting is not the business transaction.
    resolveMock.mockResolvedValue({ ok: false, reason: "none_active" });
    recordOpsAlert.mockRejectedValueOnce(new Error("ops_alerts insert failed"));

    const r = await send(admin());

    expect(r).toMatchObject({
      ok: false,
      preProvider: true,
      error: "sms_sender_not_active_for_studio",
      retryable: false,
    });
  });

  it("an alert READ failure records rather than silently suppressing", async () => {
    // A failed dedupe read must not be mistaken for "already alerted".
    resolveMock.mockResolvedValue({ ok: false, reason: "none_active" });
    await send(admin([], { message: "read failed" }));
    expect(recordOpsAlert).toHaveBeenCalledTimes(1);
  });
});

describe("the actionable condition is deduped at STUDIO scope", () => {
  it("an existing unresolved alert for this studio+reason suppresses a new one", async () => {
    resolveMock.mockResolvedValue({ ok: false, reason: "none_active" });
    const a = admin([{ id: "already-open" }]);

    const r = await send(a);

    expect(recordOpsAlert).not.toHaveBeenCalled();
    // The SEND still fails the same way — dedupe changes notification, never
    // the routing decision.
    expect(r).toMatchObject({ ok: false, preProvider: true, retryable: false });
  });

  it("it scopes by studio_id AND event, not by appointment", async () => {
    resolveMock.mockResolvedValue({ ok: false, reason: "none_active" });
    const a = admin();
    await send(a, "studio-a");
    expect(a.filters.table).toBe("ops_alerts");
    expect(a.filters.studio_id).toBe("studio-a");
    expect(a.filters.event).toBe("sms_sender_not_active_for_studio");
    // Appointment scope would defeat the purpose: an operator fixes the studio.
    expect(a.filters.appointment_id).toBeUndefined();
  });

  it("a DIFFERENT studio is not suppressed by another studio's open alert", async () => {
    resolveMock.mockResolvedValue({ ok: false, reason: "none_active" });
    // This double answers "no open rows" for studio-b's query.
    const b = admin([]);
    await send(b, "studio-b");
    expect(recordOpsAlert).toHaveBeenCalledTimes(1);
    expect(b.filters.studio_id).toBe("studio-b");
  });

  it("a DIFFERENT reason gets its own event, so it is not deduped away", async () => {
    resolveMock.mockResolvedValue({ ok: false, reason: "ambiguous" });
    const a = admin();
    await send(a);
    expect(a.filters.event).toBe("sms_sender_ambiguous");
    expect(recordOpsAlert).toHaveBeenCalledTimes(1);
  });

  it("after resolution, a recurrence alerts again — never suppressed forever", async () => {
    resolveMock.mockResolvedValue({ ok: false, reason: "none_active" });
    // Resolved rows do not match `resolved_at is null`, so the double returns
    // none and the condition re-alerts. This is the existing ops doctrine:
    // resolution re-arms the alert.
    await send(admin([]));
    expect(recordOpsAlert).toHaveBeenCalledTimes(1);
  });
});

describe("the retryable path stays quiet", () => {
  it("read_failed logs but raises NO durable alert", async () => {
    // A transient read alerting every 15 minutes is the spam this prevents.
    resolveMock.mockResolvedValue({ ok: false, reason: "read_failed" });
    const a = admin();

    const r = await send(a);

    expect(recordOpsAlert).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      ok: false,
      preProvider: true,
      error: "sms_sender_read_failed",
      retryable: true,
    });
    expect(errSpy).toHaveBeenCalled();
  });
});

describe("metrics stay true — no fake send is ever claimed", () => {
  it("every routing failure is pre-provider and claims no attempt", async () => {
    for (const reason of ["none_active", "ambiguous", "read_failed"]) {
      resolveMock.mockResolvedValue({ ok: false, reason });
      const a = admin();
      const r = await send(a);
      expect(r, `${reason}`).toMatchObject({ preProvider: true });
      expect(a.rpcCalls, `${reason}`).not.toContain("claim_sms_send");
    }
  });
});
