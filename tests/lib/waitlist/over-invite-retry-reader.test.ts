import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({ deliverArgs: [] as unknown[][] }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/waitlist/over-invite-deliver", () => ({
  deliverIssued: async (...a: unknown[]) => { h.deliverArgs.push(a); return "accepted"; },
  mayStillSend: async () => "sendable",
}));
vi.mock("@/lib/waitlist/over-invite-port", async (orig) => ({
  ...(await orig<typeof import("@/lib/waitlist/over-invite-port")>()),
  replaceInvitation: async () => ({ ok: true, result: "replaced", issued: { invitationId: "new", rawToken: "t", issuedAt: "a", expiresAt: "b", deliveryEmail: null, deliveryName: null } }),
  settleItem: async () => ({ ok: true, result: "settled" }),
}));

const { retryByKind } = await import("@/lib/waitlist/over-invite-run");

// The retry's replace answer carries no address, so the address must come from the OWNER'S session reader. This is the only unit test that
// sees the reader reach the delivery step.
describe("retryByKind hands the owner's reader to delivery", () => {
  it("the very reader passed in is the 4th argument of deliverIssued", async () => {
    const row = { state: "failed", reason_class: "delivery_refused", invitation_id: "old" };
    const q: Record<string, unknown> = {};
    for (const k of ["select", "eq"]) q[k] = () => q;
    q.maybeSingle = async () => ({ data: row, error: null });
    const reader = { from: () => q } as never;
    const out = await retryByKind("refused", "studio", "actor", [{ entryId: "e1", itemId: "i1" }], reader);
    expect(out[0]).toMatchObject({ status: "sent" });
    expect(h.deliverArgs).toHaveLength(1);
    expect(h.deliverArgs[0][0]).toBe("studio");
    expect(h.deliverArgs[0][2]).toBe("e1");
    expect(h.deliverArgs[0][3]).toBe(reader);
  });
});
