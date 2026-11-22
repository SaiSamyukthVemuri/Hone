import { describe, expect, it } from "vitest";
import { groupName, groupFilter, filterGroup, scopeToGroup } from "@/lib/client-groups/model";
import { readGroups, readGroupMembers, readClientGroups } from "@/lib/client-groups/queries";
import { directoryHref } from "@/lib/clients/directory-query";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const group = { id: id(1), name: "Follow up", updated_at: "2030-01-01T00:00:00Z" };
type Call = { table: string; columns: string; ops: [string, unknown[]][] };
function fake(answer: (call: Call, start: number) => { data: unknown; count: number | null; error: unknown }) {
  const calls: Call[] = [];
  const db = { from(table: string) { return { select(columns: string) {
    const call: Call = { table, columns, ops: [] }; calls.push(call);
    const chain: Record<string, unknown> = {};
    for (const op of ["eq", "in", "order"]) chain[op] = (...args: unknown[]) => { call.ops.push([op, args]); return chain; };
    chain.limit = async (n: number) => { call.ops.push(["limit", [n]]); return answer(call, 0); };
    chain.range = async (start: number, end: number) => { call.ops.push(["range", [start, end]]); return answer(call, start); };
    return chain;
  } }; } };
  return { db: db as never, calls };
}
describe("custom client groups", () => {
  it("trims names, rejects empty, long/control names and treats markup as plain text", () => {
    expect(groupName("  Completed  ")).toBe("Completed");
    for (const n of ["", " ", "A\nB", "a".repeat(61), null]) expect(groupName(n)).toBeNull();
    expect(groupName("<script>name</script>")).toBe("<script>name</script>");
    expect(groupFilter("invalid")).toBe("invalid"); // request remains fail-closed
  });
  it("filters before pagination and preserves group across URL actions", () => {
    const rows = Array.from({ length: 51 }, (_, n) => ({ id: id(n) }));
    expect(filterGroup(rows, new Set([id(48), id(49)]))).toEqual([rows[48], rows[49]]);
    const url = directoryHref({ view: "archived", group: id(1), q: "A", page: 2, client: id(49), sort: "name" });
    const params = new URL(url, "https://example.test").searchParams;
    expect(params.get("group")).toBe(id(1)); expect(params.get("page")).toBe("2"); expect(params.get("client")).toBe(id(49));
  });
  it("an unreadable membership shows no rows; it never falls back to every client", () => {
    const rows = [{ id: id(1) }, { id: id(2) }];
    expect(scopeToGroup(rows, id(9), { available: false })).toEqual([]);
    expect(scopeToGroup(rows, id(9), { available: true, value: new Set([id(2)]) })).toEqual([rows[1]]);
    expect(scopeToGroup(rows, undefined, { available: false })).toEqual(rows);
  });
  it("one repeated client id is refused even when the count still adds up", async () => {
    // count 1 and one distinct id: only the repeat check can refuse this.
    expect(await readGroupMembers(fake(() => ({ data: [{ client_id: id(2) }, { client_id: id(2) }], count: 1, error: null })).db, id(5), true, id(1))).toEqual({ available: false });
  });
  it("a short or changing labels page is never accepted as complete", async () => {
    const catalogue = { available: true as const, value: [group] };
    const row = { client_id: id(3), group_id: id(1) };
    for (const response of [{ data: [row], count: 2, error: null }, { data: [row], count: null, error: null }, { data: [row, { client_id: id(3), group_id: id(1) }], count: 1, error: null }]) {
      expect(await readClientGroups(fake(() => response).db, id(5), true, [id(3)], catalogue)).toEqual({ available: false });
    }
    // a short page that promises more must stop at once, not keep asking
    const short = fake((_, start) => ({ data: start ? [] : [row], count: 2, error: null }));
    expect(await readClientGroups(short.db, id(5), true, [id(3)], catalogue)).toEqual({ available: false });
    expect(short.calls).toHaveLength(1);
    const full = Array.from({ length: 500 }, (_, n) => ({ client_id: id(3), group_id: id(1000 + n) }));
    const many = { available: true as const, value: full.map((r) => ({ id: r.group_id, name: "G", updated_at: "2030-01-01T00:00:00Z" })) };
    // a second page that is short of the promised 501, then one whose count changed
    expect(await readClientGroups(fake((_, start) => ({ data: start ? [] : full, count: 501, error: null })).db, id(5), true, [id(3)], many)).toEqual({ available: false });
    expect(await readClientGroups(fake((_, start) => ({ data: start ? [{ client_id: id(3), group_id: id(1000) }] : full, count: start ? 502 : 501, error: null })).db, id(5), true, [id(3)], many)).toEqual({ available: false });
  });
  it("denies nonowners before any read, including catalogue and visible membership", async () => {
    const { db, calls } = fake(() => ({ data: [group], count: 1, error: null }));
    expect(await readGroups(db, id(5), false)).toEqual({ available: false });
    expect(await readGroupMembers(db, id(5), false, id(1))).toEqual({ available: false });
    expect(await readClientGroups(db, id(5), false, [id(3)], { available: true, value: [group] })).toEqual({ available: false });
    expect(calls).toHaveLength(0);
  });
  it("reads minimal catalogue columns with studio filter, detects truncation/missing schema", async () => {
    const { db, calls } = fake(() => ({ data: [group], count: 1, error: null }));
    expect(await readGroups(db, id(5), true)).toEqual({ available: true, value: [group] });
    expect(calls[0].columns).toBe("id,name,updated_at");
    expect(calls[0].ops).toContainEqual(["eq", ["studio_id", id(5)]]);
    for (const response of [{ data: [group], count: 2, error: null }, { data: null, count: null, error: { code: "42P01" } }]) {
      expect(await readGroups(fake(() => response).db, id(5), true)).toEqual({ available: false });
    }
  });
  it("pages complete selected membership past the API ceiling", async () => {
    const { db, calls } = fake((_, start) => ({ data: Array.from({ length: Math.min(500, 1001 - start) }, (_, n) => ({ client_id: id(start + n) })), count: 1001, error: null }));
    const result = await readGroupMembers(db, id(5), true, id(1));
    expect(result.available && result.value.size).toBe(1001); expect(calls).toHaveLength(3);
    expect(calls[0].ops).toContainEqual(["eq", ["group_id", id(1)]]);
  });
  it("refuses truncated, changing-count and duplicate selected membership", async () => {
    const full = Array.from({ length: 500 }, (_, n) => ({ client_id: id(n) }));
    for (const answer of [() => ({ data: [{ client_id: id(2) }], count: 2, error: null }), (_: Call, start: number) => ({ data: full, count: start ? 1002 : 1001, error: null }), () => ({ data: [...full.slice(1), full[1]], count: 500, error: null })]) {
      expect(await readGroupMembers(fake(answer).db, id(5), true, id(1))).toEqual({ available: false });
    }
  });
  it("visible labels are bounded, scoped and reject unknown/duplicate pairs", async () => {
    const catalogue = { available: true as const, value: [group] };
    const row = { client_id: id(3), group_id: id(1) };
    const { db, calls } = fake(() => ({ data: [row], count: 1, error: null }));
    const read = await readClientGroups(db, id(5), true, [id(3)], catalogue);
    expect(read.available && read.value.get(id(3))).toEqual([group]);
    expect(calls[0].ops).toContainEqual(["in", ["client_id", [id(3)]]]);
    for (const rows of [[row, row], [{ ...row, group_id: id(99) }], [{ ...row, client_id: id(99) }]]) {
      expect(await readClientGroups(fake(() => ({ data: rows, count: rows.length, error: null })).db, id(5), true, [id(3)], catalogue)).toEqual({ available: false });
    }
  });
});
