import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        in: () => q,
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: h.rows, error: null }).then(res),
      };
      return q;
    },
  }),
}));
import { loadOutboxCounts } from "@/lib/waitlist/decline-owner-email";
import { declineOwnerEmailRowEligible } from "@/lib/waitlist/decline-owner-email-gate";
import { emailStatusLine } from "@/lib/waitlist/decline-status-lines";

// The card and the sweep share ONE eligibility rule (declineOwnerEmailRowEligible). These are the card's side of it.
const NOW = new Date("2026-11-09T12:00:00.000Z");
const SINCE = "2026-11-09T00:00:00.000Z";
afterEach(() => {
  delete process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_ENABLED;
  delete process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_SINCE;
});
const on = (since = SINCE) => {
  process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_ENABLED = "true";
  process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_SINCE = since;
};
const line = async (status: string, created: string) => {
  h.rows = [{ invitation_id: "i1", status, created_at: created }];
  const counts = (await loadOutboxCounts("s", ["i1"], NOW))?.get("i1") ?? null;
  return emailStatusLine(true, counts);
};

describe("the card's email line for a held row", () => {
  it("activation AFTER the response: 'not sent', never 'sending'", async () => {
    on(SINCE);
    const l = await line("held", "2026-11-08T23:00:00.000Z");
    expect(l).toBe("Email: not sent.");
    expect(l).not.toMatch(/sending/);
  });
  it("a response AFTER activation that is held: 'sending'", async () => {
    on(SINCE);
    expect(await line("held", "2026-11-09T11:00:00.000Z")).toBe("Email: sending to 1 owner.");
  });
  it("a held row past its 23h window will never be tried: 'not sent'", async () => {
    on("2026-11-01T00:00:00.000Z");
    expect(await line("held", "2026-11-08T12:00:00.000Z")).toBe("Email: not sent.");
    expect(await line("held", "2026-11-09T11:00:00.000Z")).toBe("Email: sending to 1 owner.");
  });
  it("the helper agrees with the card at the boundary instant", async () => {
    on(SINCE);
    expect(declineOwnerEmailRowEligible(SINCE, new Date(SINCE), NOW)).toBe(true);
    expect(await line("held", SINCE)).toBe("Email: sending to 1 owner.");
    expect(declineOwnerEmailRowEligible("2026-11-08T23:59:59.999Z", new Date(SINCE), NOW)).toBe(false);
  });
  it("other statuses are unchanged by the cutoff", async () => {
    on(SINCE);
    expect(await line("sent", "2026-11-08T23:00:00.000Z")).toContain("sent to 1 owner");
    expect(await line("failed", "2026-11-08T23:00:00.000Z")).toContain("could not be sent");
  });
});
