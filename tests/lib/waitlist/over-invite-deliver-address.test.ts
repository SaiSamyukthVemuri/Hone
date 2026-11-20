import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  studio: { id: "s", name: "S", postcare_contact_email: null, owner_email: null } as unknown,
  deliveries: [] as { recipientEmail: string }[],
  deliverState: "accepted" as string,
  readerCalls: [] as string[],
  retryDeliver: [] as unknown[],
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    const q: Record<string, unknown> = {};
    for (const k of ["from", "select", "eq"]) q[k] = () => q;
    q.maybeSingle = async () => ({ data: h.studio, error: null });
    return q;
  },
}));
vi.mock("@/lib/waitlist/invite-to-book-adapter", () => ({
  deliverInvitation: async (a: { recipientEmail: string }) => {
    h.deliveries.push(a);
    return { state: h.deliverState };
  },
  recordObservedDelivery: async () => {},
}));

const { deliverIssued } = await import("@/lib/waitlist/over-invite-deliver");

const issued = (deliveryEmail: string | null) => ({ invitationId: "inv", rawToken: "tok", issuedAt: new Date("2026-01-01T00:00:00Z"), expiresAt: new Date("2026-01-02T00:00:00Z"), deliveryEmail, deliveryName: null });
const reader = (answer: { data: unknown; error: unknown }) => {
  const q: Record<string, unknown> = {};
  for (const k of ["select", "eq"]) q[k] = () => q;
  q.maybeSingle = async () => answer;
  return { from: (t: string) => { h.readerCalls.push(t); return q; } } as never;
};

beforeEach(() => { h.deliveries = []; h.readerCalls = []; h.deliverState = "accepted"; h.studio = { id: "s", name: "S", postcare_contact_email: null, owner_email: null }; });

// deliverIssued is mocked in every other unit test, so these are the only ones that pin where the recipient address comes from.
describe("deliverIssued: where the recipient address comes from", () => {
  it("uses the address the admit command returned, and reads nothing else", async () => {
    expect(await deliverIssued("s", issued("a@b.co"), "e", reader({ data: { email: "other@b.co" }, error: null }))).toBe("accepted");
    expect(h.deliveries.map((d) => d.recipientEmail)).toEqual(["a@b.co"]);
    expect(h.readerCalls).toEqual([]);
  });
  it("with no returned address (a retry), falls back to the owner's own session reader", async () => {
    expect(await deliverIssued("s", issued(null), "e", reader({ data: { email: "stored@b.co" }, error: null }))).toBe("accepted");
    expect(h.readerCalls).toEqual(["new_client_waitlist_entries"]);
    expect(h.deliveries.map((d) => d.recipientEmail)).toEqual(["stored@b.co"]);
  });
  it("with no reader and no address, it is refused and the provider is never called", async () => {
    expect(await deliverIssued("s", issued(null), "e")).toBe("refused");
    expect(h.deliveries).toEqual([]);
  });
  it("a reader that fails, finds nothing, or finds an empty address is refused with no provider call", async () => {
    for (const answer of [{ data: null, error: { message: "x" } }, { data: null, error: null }, { data: { email: "" }, error: null }, { data: { email: 5 }, error: null }]) {
      expect(await deliverIssued("s", issued(null), "e", reader(answer))).toBe("refused");
    }
    expect(h.deliveries).toEqual([]);
  });
  it("a studio that cannot be read is unknown, with no provider call", async () => {
    h.studio = null;
    expect(await deliverIssued("s", issued("a@b.co"), "e")).toBe("unknown");
    expect(h.deliveries).toEqual([]);
  });
});
