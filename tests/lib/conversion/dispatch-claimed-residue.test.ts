import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => {} }));
const { dispatchBookingConversion } = await import("@/lib/conversion/dispatch");

// CHARACTERIZATION of what a booking's conversion dispatch leaves behind when the send or the status write goes wrong. Named for today's behaviour so a
// later fix (a reaper, a retry) flips a test on purpose. The dispatch is fire-and-forget after the booking commits; none of these may reject.
const row = { provider: "meta", enabled: true, browser_tag_id: "PX", encrypted_server_token: "x", conversion_action_id: null, test_event_code: null, consent_mode: "explicit" };
const params = { studioId: "s", appointmentId: "appt_1", eventTimeUnixSeconds: 1_780_000_000, consentGranted: true, email: null, phone: null, serviceModality: "laser", eventSourceUrl: "https://example.test/book/x" };

function admin(opts: { finishThrows?: boolean; rows?: unknown[]; alwaysWin?: boolean }) {
  const status: string[] = [];
  const attempts = { updates: 0 };
  const claims: string[] = [];
  const client = {
    from() {
      let isUpdate = false;
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (p: { status?: string }) => {
          isUpdate = true;
          attempts.updates += 1;
          if (opts.finishThrows) throw new Error("db down");
          if (p.status) status.push(p.status);
          return chain;
        },
        eq: () => chain,
        then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(isUpdate ? { error: null } : { data: opts.rows ?? [row] }).then(f, r),
      };
      return chain;
    },
    rpc: (_n: string, a: { p_event_id: string }) => {
      claims.push(a.p_event_id);
      return Promise.resolve({ data: opts.alwaysWin ? true : claims.filter((c) => c === a.p_event_id).length === 1, error: null });
    },
  };
  return { client: client as never, status, claims, attempts };
}
const okDecrypt = () => ({ ok: true as const, token: "T" });
const adapter = (send: () => Promise<unknown>) => ({ provider: "meta", buildPayload: () => ({ provider: "meta", eventId: "e", body: {} }), send }) as never;

describe("conversion dispatch residue (today's behaviour)", () => {
  it("an adapter that THROWS: the dispatch still resolves, nothing is recorded after the claim, so the delivery row stays 'claimed'", async () => {
    const a = admin({});
    await expect(dispatchBookingConversion(params, { admin: a.client, adapters: { meta: adapter(async () => { throw new Error("boom"); }) }, decrypt: okDecrypt })).resolves.toBeUndefined();
    expect(a.claims).toEqual(["hone_booking_appt_1"]);
    expect(a.status).toEqual([]);
  });

  it("a status write that throws after a successful send: the send ran, the update was attempted, the dispatch still resolves, the row ends unmarked, and the NEXT provider row is still processed (the status write has its own catch)", async () => {
    const a = admin({ finishThrows: true, rows: [row, row], alwaysWin: true });
    const send = vi.fn(async () => ({ ok: true, providerEventId: null }));
    await expect(dispatchBookingConversion(params, { admin: a.client, adapters: { meta: adapter(send) }, decrypt: okDecrypt })).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(a.attempts.updates).toBe(2);
    expect(a.status).toEqual([]);
  });

  it("a second dispatch for the same appointment never sends again, even though the first left its row 'claimed' (a stuck claim is final, not retried)", async () => {
    const a = admin({});
    const send = vi.fn(async () => { throw new Error("boom"); });
    const deps = { admin: a.client, adapters: { meta: adapter(send) }, decrypt: okDecrypt };
    await dispatchBookingConversion(params, deps);
    await dispatchBookingConversion(params, deps);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
