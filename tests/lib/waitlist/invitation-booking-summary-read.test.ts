import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCommandCounts, loadOutcomeCounts } from "@/lib/waitlist/invitation-booking-summary-read";

const ROW = { invitations_total: 20, people_invited: 17, booked_linked_live: 5, booked_then_cancelled: 1, converted_unlinked: 1 };
const rpcClient = (result: unknown, calls: unknown[] = []) =>
  ({ rpc: async (name: string, args: unknown) => { calls.push([name, args]); if (result instanceof Error) throw result; return result; } }) as unknown as SupabaseClient;

describe("loadCommandCounts", () => {
  it("calls the command for this studio and period, and returns its five counts", async () => {
    const calls: unknown[] = [];
    const r = await loadCommandCounts(rpcClient({ data: [ROW], error: null }, calls), "s-1", "2026-10-23T00:00:00.000Z");
    expect(calls).toEqual([["waitlist_invitation_booking_counts", { p_studio_id: "s-1", p_from: "2026-10-23T00:00:00.000Z" }]]);
    expect(r).toEqual({ invitationsTotal: 20, peopleInvited: 17, bookedLinkedLive: 5, bookedThenCancelled: 1, convertedUnlinked: 1 });
  });
  it("zeros are real zeros", async () => {
    const z = { invitations_total: 0, people_invited: 0, booked_linked_live: 0, booked_then_cancelled: 0, converted_unlinked: 0 };
    expect(await loadCommandCounts(rpcClient({ data: [z], error: null }), "s", "t")).toMatchObject({ invitationsTotal: 0, bookedLinkedLive: 0 });
  });
  it.each([
    ["the command is not in the database", { data: null, error: { code: "PGRST202", message: "Could not find the function" } }],
    ["it refuses", { data: null, error: { code: "42501", message: "not allowed" } }],
    ["no row", { data: [], error: null }],
    ["a missing column", { data: [{ ...ROW, people_invited: undefined }], error: null }],
    ["a negative count", { data: [{ ...ROW, invitations_total: -1 }], error: null }],
    ["a count that is text", { data: [{ ...ROW, invitations_total: "20" }], error: null }],
    ["a fractional count", { data: [{ ...ROW, converted_unlinked: 1.5 }], error: null }],
  ])("is null (never zeros) when %s", async (_n, result) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadCommandCounts(rpcClient(result), "s", "t")).toBeNull();
  });
  it("is null when the call throws, and logs only a code", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadCommandCounts(rpcClient(new Error("network down with a secret")), "s", "t")).toBeNull();
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
  });
  it("logs only the event and the code on an error, never the message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await loadCommandCounts(rpcClient({ data: null, error: { code: "42501", message: "private words" } }), "s", "t");
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain("42501");
    expect(logged).not.toContain("private words");
  });
});

/** A fake builder that records every filter applied and answers with the count the test gives for that exact filter set. */
function headClient(answer: (filters: string[]) => { count: number | null; error: unknown } | Error) {
  const seen: Array<{ table: string; select: unknown; filters: string[] }> = [];
  const client = {
    from: (table: string) => ({
      select: (cols: string, opts: unknown) => {
        const filters: string[] = [];
        const q: any = {
          eq: (c: string, v: unknown) => (filters.push(`eq:${c}:${v}`), q),
          gte: (c: string, v: unknown) => (filters.push(`gte:${c}:${v}`), q),
          is: (c: string, v: unknown) => (filters.push(`is:${c}:${v}`), q),
          not: (c: string, op: string, v: unknown) => (filters.push(`not:${c}:${op}:${v}`), q),
          gt: (c: string, v: unknown) => (filters.push(`gt:${c}:${v}`), q),
          lte: (c: string, v: unknown) => (filters.push(`lte:${c}:${v}`), q),
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
            seen.push({ table, select: [cols, opts], filters: [...filters] });
            const a = answer(filters);
            return a instanceof Error ? Promise.reject(a).then(res, rej) : Promise.resolve(a).then(res, rej);
          },
        };
        return q;
      },
    }),
  } as unknown as SupabaseClient;
  return { client, seen };
}

describe("loadOutcomeCounts", () => {
  const START = "2026-10-23T00:00:00.000Z";
  const NOW = "2026-11-22T00:00:00.000Z";
  const has = (f: string[], x: string) => f.includes(x);
  it("reads exact HEAD-ONLY counts for this studio and period, one per outcome, and no rows", async () => {
    const { client, seen } = headClient((f) => ({ count: has(f, "not:declined_at:is:null") ? 3 : 7, error: null }));
    await loadOutcomeCounts(client, "s-1", START, NOW);
    expect(seen).toHaveLength(7);
    for (const s of seen) {
      expect(s.table).toBe("new_client_waitlist_invitations");
      expect(s.select).toEqual(["id", { count: "exact", head: true }]);
      expect(s.filters).toContain("eq:studio_id:s-1");
      expect(s.filters).toContain(`gte:issued_at:${START}`);
    }
  });
  it("each outcome is a distinct, mutually exclusive filter set in the history labels' order", async () => {
    const { client, seen } = headClient(() => ({ count: 1, error: null }));
    await loadOutcomeCounts(client, "s", START, NOW);
    const sets = seen.map((s) => s.filters.filter((f) => !f.startsWith("eq:studio_id") && !f.startsWith("gte:issued_at")).join(","));
    expect(sets).toEqual([
      "",
      "not:declined_at:is:null",
      "is:declined_at:null,not:redeemed_at:is:null",
      "is:declined_at:null,is:redeemed_at:null,not:expired_at:is:null",
      "is:declined_at:null,is:redeemed_at:null,is:expired_at:null,not:released_at:is:null",
      `is:declined_at:null,is:redeemed_at:null,is:expired_at:null,is:released_at:null,gt:expires_at:${NOW}`,
      `is:declined_at:null,is:redeemed_at:null,is:expired_at:null,is:released_at:null,lte:expires_at:${NOW}`,
    ]);
    expect(new Set(sets).size).toBe(7);
  });
  it("returns each count under its own name", async () => {
    const answers: Record<string, number> = {};
    const { client } = headClient((f) => {
      const k = f.filter((x) => !x.startsWith("eq:studio_id") && !x.startsWith("gte:issued_at")).join(",");
      const table: Record<string, number> = {
        "": 20, "not:declined_at:is:null": 3, "is:declined_at:null,not:redeemed_at:is:null": 8,
        "is:declined_at:null,is:redeemed_at:null,not:expired_at:is:null": 2,
        "is:declined_at:null,is:redeemed_at:null,is:expired_at:null,not:released_at:is:null": 1,
      };
      const n = k in table ? table[k]! : k.includes("gt:") ? 4 : 2;
      answers[k] = n;
      return { count: n, error: null };
    });
    expect(await loadOutcomeCounts(client, "s", START, NOW)).toEqual({ total: 20, declined: 3, linkUsed: 8, expiredRecorded: 2, released: 1, open: 4, deadlinePassed: 2 });
  });
  it("a count that errors, is missing, or throws is null: the others are still returned", async () => {
    const { client } = headClient((f) =>
      f.includes("not:declined_at:is:null") && f.length === 3 ? { count: null, error: { code: "x" } }
      : f.some((x) => x.startsWith("gt:")) ? { count: null, error: null }
      : f.some((x) => x.startsWith("lte:")) ? new Error("boom")
      : { count: 5, error: null });
    const r = await loadOutcomeCounts(client, "s", START, NOW);
    expect(r.declined).toBeNull();
    expect(r.open).toBeNull();
    expect(r.deadlinePassed).toBeNull();
    expect(r.total).toBe(5);
    expect(r.linkUsed).toBe(5);
  });
  it("a count of 0 is 0, not unavailable", async () => {
    const { client } = headClient(() => ({ count: 0, error: null }));
    expect((await loadOutcomeCounts(client, "s", START, NOW)).declined).toBe(0);
  });
});
