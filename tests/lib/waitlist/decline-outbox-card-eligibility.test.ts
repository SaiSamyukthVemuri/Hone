import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, calls: [] as string[][], fail: false }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: () => {
      let ids: string[] = [];
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        in: (_c: string, vs: string[]) => {
          h.calls.push(vs);
          ids = vs;
          return q;
        },
        limit: () => q,
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve(h.fail ? { data: null, error: { code: "x" } } : { data: h.rows.filter((r) => ids.includes(r.invitation_id as string)), error: null }).then(res),
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
  h.calls = [];
  h.fail = false;
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

describe("every invitation is read, never silently skipped", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `inv-${i}`);
  it("250 invitations are read in chunks, and the 201st still gets its real counts", async () => {
    on();
    const ids = many(250);
    h.rows = ids.map((id) => ({ invitation_id: id, status: "sent", created_at: "2026-11-09T11:00:00.000Z" }));
    const out = await loadOutboxCounts("s", ids, NOW);
    expect(out?.size).toBe(250);
    expect(out?.get("inv-249")?.sent).toBe(1);
    expect(h.calls.flat().sort()).toEqual([...ids].sort());
    expect(Math.max(...h.calls.map((c) => c.length))).toBeLessThanOrEqual(50);
  });
  it("a failed chunk makes the whole read unavailable (null), not a partial map that reads as 'no recipients'", async () => {
    on();
    h.fail = true;
    expect(await loadOutboxCounts("s", many(120), NOW)).toBeNull();
  });
  it("a chunk that fills the row ceiling is treated as possibly incomplete", async () => {
    on();
    h.rows = Array.from({ length: 1000 }, () => ({ invitation_id: "inv-0", status: "sent", created_at: "2026-11-09T11:00:00.000Z" }));
    expect(await loadOutboxCounts("s", ["inv-0"], NOW)).toBeNull();
  });
});
