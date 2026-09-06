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

describe("the retryable path is VISIBLE, and still costs nothing", () => {
  it("read_failed raises a durable alert — a broken lookup is not silent", async () => {
    // THE REGRESSION THIS EXISTS TO CATCH. A missing 0192 RPC or a privilege
    // regression makes every lookup fail, so every send returns read_failed.
    // With no durable row, SMS stops completely for every studio and the only
    // trace is stderr. Silent and total is the worst possible shape.
    resolveMock.mockResolvedValue({ ok: false, reason: "read_failed" });
    const a = admin();

    const r = await send(a);

    expect(alertSettled).toBe(true);
    expect(recordOpsAlert).toHaveBeenCalledTimes(1);
    const arg = recordOpsAlert.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.event).toBe("sms_sender_read_failed");
    // The message must not claim anything about the studio's sender — the
    // lookup failed, so nothing was learned about it.
    expect(String(arg.message)).toMatch(/lookup could not be performed/i);

    // ...and none of its runtime semantics changed.
    expect(r).toMatchObject({
      ok: false,
      preProvider: true,
      error: "sms_sender_read_failed",
      retryable: true,
    });
    expect(a.rpcCalls).not.toContain("claim_sms_send");
  });

  it("a sustained read failure is ONE open alert, not one per cron pass", async () => {
    // This is why log-only was never the right mitigation: the dedupe already
    // solves the volume the old exemption was protecting against.
    resolveMock.mockResolvedValue({ ok: false, reason: "read_failed" });
    await send(admin([{ id: "already-open" }]));
    expect(recordOpsAlert).not.toHaveBeenCalled();
  });

  it("a broken lookup is NOT deduped away by an open no-sender alert", async () => {
    // Different faults, different operator actions, so different events.
    resolveMock.mockResolvedValue({ ok: false, reason: "read_failed" });
    const a = admin();
    await send(a);
    expect(a.filters.event).toBe("sms_sender_read_failed");
    expect(a.filters.event).not.toBe("sms_sender_not_active_for_studio");
  });

  it("an alert failure on the retryable path still does not break booking", async () => {
    resolveMock.mockResolvedValue({ ok: false, reason: "read_failed" });
    recordOpsAlert.mockRejectedValueOnce(new Error("ops_alerts down"));
    const r = await send(admin());
    expect(r).toMatchObject({ ok: false, preProvider: true, retryable: true });
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
