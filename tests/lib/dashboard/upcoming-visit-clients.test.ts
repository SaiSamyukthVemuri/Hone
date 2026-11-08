import { describe, expect, it } from "vitest";
import { getClientIdsWithUpcomingVisits } from "@/lib/dashboard/upcoming-visit-clients";

// Synthetic ids only.
function fake(rows: Array<{ client_id: string | null }>, error = false) {
  const seen = { eq: [] as Array<[string, unknown]>, ranges: [] as number[] };
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = (c: string, v: unknown) => (seen.eq.push([c, v]), q);
  q.gte = () => q;
  q.lt = () => q;
  q.order = () => q;
  q.range = (a: number, b: number) => {
    seen.ranges.push(a);
    q.slice = rows.slice(a, b + 1);
    return q;
  };
  q.then = (resolve: (v: unknown) => unknown) =>
    resolve(error ? { data: null, error: { message: "x" } } : { data: q.slice, error: null });
  return { client: { from: () => q } as never, seen };
}

describe("getClientIdsWithUpcomingVisits", () => {
  it("returns distinct client ids, studio-scoped to confirmed visits", async () => {
    const { client, seen } = fake([{ client_id: "a" }, { client_id: "a" }, { client_id: "b" }, { client_id: null }]);
    const ids = await getClientIdsWithUpcomingVisits(client, "studio-1", "2026-11-01T12:00:00Z");
    expect([...ids].sort()).toEqual(["a", "b"]);
    expect(seen.eq).toContainEqual(["studio_id", "studio-1"]);
    expect(seen.eq).toContainEqual(["status", "confirmed"]);
  });

  it("pages past 1000 rows", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({ client_id: `c${i}` }));
    const { client, seen } = fake(rows);
    const ids = await getClientIdsWithUpcomingVisits(client, "studio-1", "2026-11-01T12:00:00Z");
    expect(ids.size).toBe(1200);
    expect(seen.ranges).toEqual([0, 1000]);
  });

  it("refuses on a read error and past the page ceiling rather than return a partial set", async () => {
    await expect(
      getClientIdsWithUpcomingVisits(fake([], true).client, "studio-1", "2026-11-01T12:00:00Z"),
    ).rejects.toThrow("Failed to load upcoming visits");
    const many = Array.from({ length: 5001 }, (_, i) => ({ client_id: `c${i}` }));
    await expect(
      getClientIdsWithUpcomingVisits(fake(many).client, "studio-1", "2026-11-01T12:00:00Z"),
    ).rejects.toThrow("Failed to load upcoming visits");
  });
});
