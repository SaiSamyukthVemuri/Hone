import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// WHAT GETS WRITTEN DOWN, AND WHAT MUST NOT BE
// ===========================================================================
//
// 0196 stores an OBSERVED provider outcome. The durable contract:
//
//   NULL      no provider outcome was observed or attempted
//   accepted  the provider was reached and took custody
//   refused   the provider was reached and definitively declined
//   unknown   the provider was reached and the answer was unreadable
//
// Two adapter defects threatened that, both raised on review:
//
//  1. a PRE-PROVIDER failure (policy refusal, app-origin or transport
//     preparation) was persisted as if it were an observed verdict. The policy's
//     own note warns about exactly this: `delivered: "no"` says nothing arrived,
//     NOT whether anyone was called;
//  2. `admin.rpc(...)` was awaited without reading `error`, so a database
//     refusal looked like a successful write and nothing was recorded.
//
// These cases pin both. The attempt flag is CARRIED from the policy, never
// inferred from `delivered`, the delivery word, an exception class or a message.
// ===========================================================================

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ rpc }),
}));

const sendWaitlistInvitationEmail = vi.fn();
vi.mock("@/lib/waitlist/delivery/send", () => ({ sendWaitlistInvitationEmail }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://example.test" }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: vi.fn() }));

const STUDIO = "11111111-1111-4111-8111-111111111111";
const INVITATION = "22222222-2222-4222-8222-222222222222";

/** Reach the module's delivery seam without standing up the whole command. */
const loadAdapter = async () => await import("@/lib/waitlist/invite-to-book-adapter");

const recordCalls = () =>
  rpc.mock.calls.filter((c) => c[0] === "record_waitlist_invitation_delivery");

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
});

describe("the module exposes the delivery seam it is asked about", () => {
  it("loads without a database or a provider", async () => {
    const mod = await loadAdapter();
    expect(mod.admissionCommandAdapter).toBeDefined();
  });
});

// The decision under test is small and total, so it is exercised directly
// through the exported helper rather than by faking an entire authenticated
// admission. What matters is the RULE: attempted -> record once, not attempted
// -> never record, and both client failure shapes are observed.
describe("PRE-PROVIDER failures are never written down", () => {
  it("providerAttempted:false with delivered:no records NOTHING", async () => {
    const { recordObservedDelivery } = await loadAdapter();
    await recordObservedDelivery(STUDIO, INVITATION, {
      state: "refused",
      providerAttempted: false,
    });
    expect(recordCalls(), "a pre-send refusal was persisted as a provider verdict").toHaveLength(0);
  });

  it("providerAttempted:false with an unknown/preparation failure records NOTHING", async () => {
    const { recordObservedDelivery } = await loadAdapter();
    await recordObservedDelivery(STUDIO, INVITATION, {
      state: "unknown",
      providerAttempted: false,
    });
    expect(recordCalls()).toHaveLength(0);
  });
});

describe("an OBSERVED outcome is written exactly once", () => {
  for (const state of ["accepted", "refused", "unknown"] as const) {
    it(`providerAttempted:true + ${state} records ${state} once`, async () => {
      const { recordObservedDelivery } = await loadAdapter();
      await recordObservedDelivery(STUDIO, INVITATION, { state, providerAttempted: true });
      const calls = recordCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]![1]).toEqual({
        p_studio_id: STUDIO,
        p_invitation_id: INVITATION,
        p_disposition: state,
      });
    });
  }
});

describe("both client failure shapes are failures, and both are fail-soft", () => {
  it("a RESOLVED { error } is observed and logged, and does not throw", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    rpc.mockResolvedValue({ data: null, error: { message: "refused by database" } });
    const { recordObservedDelivery } = await loadAdapter();

    await expect(
      recordObservedDelivery(STUDIO, INVITATION, { state: "accepted", providerAttempted: true }),
    ).resolves.toBeUndefined();

    const line = JSON.parse(String(spy.mock.calls[0]?.[0]));
    expect(line.event).toBe("waitlist_invitation_delivery_record_failed");
    expect(line.shape).toBe("rpc_error");
    spy.mockRestore();
  });

  it("a THROWN client error is observed and logged, and does not throw", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    rpc.mockRejectedValue(new Error("socket hang up"));
    const { recordObservedDelivery } = await loadAdapter();

    await expect(
      recordObservedDelivery(STUDIO, INVITATION, { state: "refused", providerAttempted: true }),
    ).resolves.toBeUndefined();

    const line = JSON.parse(String(spy.mock.calls[0]?.[0]));
    expect(line.shape).toBe("threw");
    spy.mockRestore();
  });

  it("the failure line carries NO recipient, token, identity or payload", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { recordObservedDelivery } = await loadAdapter();
    await recordObservedDelivery(STUDIO, INVITATION, { state: "unknown", providerAttempted: true });

    const raw = String(spy.mock.calls[0]?.[0]);
    for (const leak of [STUDIO, INVITATION, "@", "token", "boom"]) {
      expect(raw, `leaked ${leak}`).not.toContain(leak);
    }
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["at", "event", "shape"]);
    spy.mockRestore();
  });

  it("NEITHER failure shape retries or resends", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { recordObservedDelivery } = await loadAdapter();
    await recordObservedDelivery(STUDIO, INVITATION, { state: "accepted", providerAttempted: true });
    // Exactly one attempt: no retry loop, and nothing that could resend mail.
    expect(recordCalls()).toHaveLength(1);
    expect(sendWaitlistInvitationEmail).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
