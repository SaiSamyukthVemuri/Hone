import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { NAMED_LIST_SIZE, rankNamedClients, usableName, type ClientFigure, type NameLookup, type NamedClients } from "@/lib/business-analytics/named-clients";
import { NAME_CHUNK, readClientNames } from "@/lib/business-analytics/server/client-names-read";
import { namedClientsCap } from "@/lib/business-analytics/copy";
import { compareClients, type ClientRow, type RankBy } from "@/lib/business-analytics/visit-metrics";

const fig = (id: string, visits: number, paid: number | null, gap: number | null): ClientFigure => ({ clientId: id, periodVisits: visits, periodPaidCents: paid, averageGapDays: gap });
const lookup = (ids: readonly string[], nameOf: (id: string) => string = (id) => `Name ${id}`): NameLookup => ({ ok: true, names: new Map(ids.map((id) => [id, nameOf(id)])) });
const rank = (figures: ClientFigure[], over: Partial<Parameters<typeof rankNamedClients>[0]> = {}): NamedClients => {
  const r = rankNamedClients({ figures, seen: figures.length, lookup: lookup(figures.map((f) => f.clientId)), moneyFailure: null, historyFailure: null, ...over });
  if (!r.available) throw new Error("unavailable");
  return r.value;
};
const names = (rows: ReadonlyArray<{ name: string }>) => rows.map((r) => r.name);
const spenders = (v: NamedClients) => (v.spenders.available ? v.spenders.value : []);
const returns = (v: NamedClients) => (v.frequentReturns.available ? v.frequentReturns.value : []);

describe("top spenders: order and ties", () => {
  it("orders by money kept, largest first", () => {
    const v = rank([fig("a", 1, 5000, null), fig("b", 1, 9000, null), fig("c", 1, 7000, null)]);
    expect(names(spenders(v))).toEqual(["Name b", "Name c", "Name a"]);
  });
  it("breaks an equal spend by more visits, then by name, then by id (never shown)", () => {
    const v = rank([fig("z1", 1, 5000, null), fig("a2", 2, 5000, null), fig("m3", 1, 5000, null)], { lookup: lookup(["z1", "a2", "m3"], (id) => ({ z1: "Zed", a2: "Zed", m3: "Amy" })[id] as string) });
    expect(names(spenders(v))).toEqual(["Zed", "Amy", "Zed"]); // a2 has more visits; then Amy before Zed
    const same = rank([fig("id2", 1, 100, null), fig("id1", 1, 100, null)], { lookup: lookup(["id1", "id2"], () => "Same Name") });
    expect(spenders(same).map((r) => r.rowKey)).toEqual(["spend-1", "spend-2"]);
  });
  it("puts a client whose money is not known last, as not available, never zero", () => {
    const v = rank([fig("a", 3, null, null), fig("b", 1, 100, null)]);
    expect(names(spenders(v))).toEqual(["Name b", "Name a"]);
    expect(spenders(v)[1].periodPaidCents).toBeNull();
  });
  it("names no highest spender when the leading amount is unknown, and when money is unavailable the list says so", () => {
    expect(rank([fig("a", 1, null, null)]).highestSpend).toBeNull();
    const v = rank([fig("a", 1, 9000, null)], { moneyFailure: "read_failed" });
    expect(v.spenders).toEqual({ available: false, reason: "read_failed" });
    expect(v.highestSpend).toBeNull();
    expect(v.mostVisits).toHaveLength(1); // the visit lists still render
  });
  it("the highest spend is the first spender", () => {
    const v = rank([fig("a", 1, 5000, null), fig("b", 1, 9000, null)]);
    expect(v.highestSpend?.name).toBe("Name b");
    expect(v.highestSpend?.periodPaidCents).toBe(9000);
  });
});

describe("most visits and most frequent returns", () => {
  it("most visits: by visits, then money, then name", () => {
    const v = rank([fig("a", 2, 100, null), fig("b", 3, 100, null), fig("c", 2, 900, null)]);
    expect(names(v.mostVisits)).toEqual(["Name b", "Name c", "Name a"]);
  });
  it("most frequent returns is the SHORTEST average gap; clients with fewer than two visit dates are counted apart, not ranked", () => {
    const v = rank([fig("a", 1, 1, 30), fig("b", 1, 1, 7), fig("c", 1, 1, null), fig("d", 1, 1, 14)]);
    expect(names(returns(v))).toEqual(["Name b", "Name d", "Name a"]);
    expect(v.fewerThanTwoDates).toBe(1);
  });
  it("an equal gap is broken by more visits in the period, then by name", () => {
    const v = rank([fig("a", 1, 1, 10), fig("b", 3, 1, 10), fig("c", 3, 1, 10)], { lookup: lookup(["a", "b", "c"], (id) => ({ a: "Aaa", b: "Zed", c: "Bob" })[id] as string) });
    expect(names(returns(v))).toEqual(["Bob", "Zed", "Aaa"]); // 3 visits before 1; then Bob before Zed
  });
  it("the fewer-than-two-visit-dates count is a number only when history was read", () => {
    const f = [fig("a", 1, 1, null), fig("b", 1, 1, 5)];
    expect(rank(f).fewerThanTwoDates).toBe(1);
    expect(rank(f, { historyFailure: "too_many_appointments" }).fewerThanTwoDates).toBeNull();
  });
  it("a client with a short gap but no visit in this period is in none of the lists", () => {
    const v = rank([fig("a", 0, 100, 3), fig("b", 1, 100, 20)]);
    expect(names(returns(v))).toEqual(["Name b"]);
    expect(names(v.mostVisits)).toEqual(["Name b"]);
    expect(names(spenders(v))).toEqual(["Name b"]);
  });
  it("an unreadable history makes only the returns list unavailable", () => {
    const v = rank([fig("a", 1, 100, null)], { historyFailure: "read_failed" });
    expect(v.frequentReturns).toEqual({ available: false, reason: "read_failed" });
    expect(v.fewerThanTwoDates).toBeNull(); // no history means no gaps for anyone: counting "fewer than two visit dates" would count everyone
    expect(spenders(v)).toHaveLength(1);
  });
});

describe("who is listed, and the cap", () => {
  it("lists at most five clients per list and says how many were seen", () => {
    const f = Array.from({ length: 9 }, (_, i) => fig(`c${i}`, 1, 1000 + i, 10 + i));
    const v = rank(f);
    expect(NAMED_LIST_SIZE).toBe(5);
    expect(v.mostVisits).toHaveLength(5);
    expect(spenders(v)).toHaveLength(5);
    expect(returns(v)).toHaveLength(5);
    expect(v.seen).toBe(9);
    expect(namedClientsCap(9, 5)).toBe("Top 5 of 9 clients seen in this period.");
  });
  it("the cap sentence for none, one, a few and exactly five", () => {
    expect(namedClientsCap(0, 5)).toBe("No clients were seen in this period.");
    expect(namedClientsCap(1, 5)).toBe("The 1 client seen in this period.");
    expect(namedClientsCap(3, 5)).toBe("All 3 clients seen in this period.");
    expect(namedClientsCap(5, 5)).toBe("All 5 clients seen in this period.");
    expect(namedClientsCap(6, 5)).toBe("Top 5 of 6 clients seen in this period.");
  });
  it("never pads: fewer than five clients make fewer rows", () => {
    expect(spenders(rank([fig("a", 1, 1, null), fig("b", 1, 1, null)]))).toHaveLength(2);
  });
  it("a client with no row read, a blank name, or whitespace only is not listed and never shown as Unknown, but is still counted as seen", () => {
    const f = [fig("a", 1, 100, null), fig("gone", 1, 900, null), fig("blank", 1, 800, null), fig("space", 1, 700, null)];
    const lk = lookup(["a", "blank", "space"], (id) => (id === "a" ? "Rowan" : id === "blank" ? "" : " \t "));
    const v = rank(f, { lookup: lk });
    expect(names(spenders(v))).toEqual(["Rowan"]);
    expect(v.seen).toBe(4);
    expect(v.notListed).toBe(3);
    expect(JSON.stringify(v)).not.toMatch(/unknown/i);
  });
  it("an archived client is one the read did not return, so they are left out and counted in notListed", () => {
    const v = rank([fig("a", 1, 100, null), fig("archived", 1, 5000, null)], { lookup: lookup(["a"]) });
    expect(names(spenders(v))).toEqual(["Name a"]);
    expect(v.notListed).toBe(1);
    expect(v.seen).toBe(2);
  });
  it("a failed name read makes the whole figure unavailable, not empty", () => {
    expect(rankNamedClients({ figures: [fig("a", 1, 1, null)], seen: 1, lookup: { ok: false }, moneyFailure: null, historyFailure: null })).toEqual({ available: false, reason: "read_failed" });
  });
  it("a name is trimmed and its inner whitespace collapsed", () => {
    expect(usableName("  Rowan   Example ")).toBe("Rowan Example");
    expect(usableName("")).toBeNull();
    expect(usableName(null)).toBeNull();
  });
  it("no client id leaves the module: rows carry a rank key, a name and figures only", () => {
    const v = rank([fig("secret-client-id-1", 2, 100, 9)], { lookup: lookup(["secret-client-id-1"], () => "Rowan") });
    expect(JSON.stringify(v)).not.toContain("secret-client-id");
    expect(Object.keys(spenders(v)[0]).sort()).toEqual(["averageGapDays", "name", "periodPaidCents", "periodVisits", "rowKey"]);
  });
});

// A recording stand-in for the query builder: every call is kept so the filters can be pinned.
function fakeSupabase(rowsFor: (ids: string[], select: string) => Array<{ id: string; name: string | null; preferred_name?: string | null }>, fail = false, missingPreferred = false) {
  const calls: Array<{ table: string; select: string; eq: Array<[string, unknown]>; is: Array<[string, unknown]>; inIds: string[] }> = [];
  const client = {
    from(table: string) {
      const call = { table, select: "", eq: [] as Array<[string, unknown]>, is: [] as Array<[string, unknown]>, inIds: [] as string[] };
      calls.push(call);
      const q: Record<string, unknown> = {
        select(s: string) { call.select = s; return q; },
        eq(c: string, v: unknown) { call.eq.push([c, v]); return q; },
        is(c: string, v: unknown) { call.is.push([c, v]); return q; },
        in(_c: string, ids: string[]) { call.inIds = ids; if (missingPreferred && call.select.includes("preferred_name")) return Promise.resolve({ data: null, error: { code: "42703", message: 'column clients.preferred_name does not exist' } });
          return Promise.resolve(fail ? { data: null, error: { message: "x" } } : { data: rowsFor(ids, call.select), error: null }); },
      };
      return q;
    },
  };
  return { client: client as never, calls };
}

describe("the names-only read", () => {
  it("asks only for id and name, in this studio, archived excluded IN THE QUERY, and only for the ids it was given", async () => {
    const f = fakeSupabase((ids) => ids.map((id) => ({ id, name: `N ${id}` })));
    const r = await readClientNames(f.client, "studio-1", ["a", "b", "a"]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].table).toBe("clients");
    expect(f.calls[0].select).toBe("preferred_name, id, name");
    expect(f.calls[0].eq).toEqual([["studio_id", "studio-1"]]);
    expect(f.calls[0].is).toEqual([["archived_at", null]]);
    expect(f.calls[0].inIds).toEqual(["a", "b"]);
    expect(r.ok && [...r.names.keys()]).toEqual(["a", "b"]);
  });
  it("makes no request for nobody", async () => {
    const f = fakeSupabase(() => []);
    const r = await readClientNames(f.client, "studio-1", []);
    expect(f.calls).toHaveLength(0);
    expect(r).toEqual({ ok: true, names: new Map() });
  });
  it("splits a long list into requests of a bounded size", async () => {
    const ids = Array.from({ length: NAME_CHUNK * 2 + 1 }, (_, i) => `c${i}`);
    const f = fakeSupabase((chunk) => chunk.map((id) => ({ id, name: id })));
    const r = await readClientNames(f.client, "studio-1", ids);
    expect(f.calls.map((c) => c.inIds.length).sort((a, b) => b - a)).toEqual([NAME_CHUNK, NAME_CHUNK, 1]);
    expect(r.ok && r.names.size).toBe(ids.length);
  });
  it("an error in any request is a failed lookup, never a partial one", async () => {
    expect(await readClientNames(fakeSupabase(() => [], true).client, "studio-1", ["a"])).toEqual({ ok: false });
  });
  it("a row with no name is not given one", async () => {
    const f = fakeSupabase(() => [{ id: "a", name: null }]);
    const r = await readClientNames(f.client, "studio-1", ["a"]);
    expect(r.ok && r.names.size).toBe(0);
  });
});

describe("the name shown is the app's display name, never the legal name", () => {
  it("a client with a preferred name shows it, and the stored name is not shown", async () => {
    const f = fakeSupabase(() => [{ id: "a", name: "Legal Lastname", preferred_name: "Rowan Example" }]);
    const r = await readClientNames(f.client, "studio-1", ["a"]);
    expect(r.ok && r.names.get("a")).toBe("Rowan Example");
  });
  it("a client without one shows the stored name; a whitespace preferred name does not hide it", async () => {
    const f = fakeSupabase(() => [{ id: "a", name: "Stored Name", preferred_name: null }, { id: "b", name: "Other Stored", preferred_name: "  " }]);
    const r = await readClientNames(f.client, "studio-1", ["a", "b"]);
    expect(r.ok && [r.names.get("a"), r.names.get("b")]).toEqual(["Stored Name", "Other Stored"]);
  });
  it("a database without the preferred-name column is read again without it and shows the stored name", async () => {
    const f = fakeSupabase((_ids, select) => (select.includes("preferred_name") ? [] : [{ id: "a", name: "Stored Name" }]), false, true);
    const r = await readClientNames(f.client, "studio-1", ["a"]);
    expect(f.calls.map((c) => c.select)).toEqual(["preferred_name, id, name", "id, name"]);
    expect(f.calls[1].is).toEqual([["archived_at", null]]); // the fallback keeps every filter
    expect(f.calls[1].eq).toEqual([["studio_id", "studio-1"]]);
    expect(r.ok && r.names.get("a")).toBe("Stored Name");
  });
  it("the blank rule applies to the resulting name: preferred and stored both blank is not listed", async () => {
    const f = fakeSupabase(() => [{ id: "a", name: " ", preferred_name: "" }]);
    const r = await readClientNames(f.client, "studio-1", ["a"]);
    expect(r.ok && r.names.size).toBe(0);
  });
  it("a different failure on the first attempt is not retried and is a failed lookup", async () => {
    const f = fakeSupabase(() => [], true);
    expect(await readClientNames(f.client, "studio-1", ["a"])).toEqual({ ok: false });
    expect(f.calls).toHaveLength(1);
  });
});

describe("the last tiebreak is the client id, so the order never depends on the order the rows arrive in", () => {
  const row = (clientId: string): ClientRow => ({ clientId, name: "Same Name", periodVisits: 2, periodPaidCents: 500, lifetimePaidCents: 500, averageGapDays: 9, lastVisitDate: "2026-11-01" });
  for (const by of ["spend", "visits", "interval", "lifetime", "last_visit", "name"] as RankBy[]) {
    it(`${by}: two clients equal in name and every figure sort by id in either input order`, () => {
      const forward = [row("id-1"), row("id-2")].sort(compareClients(by)).map((r) => r.clientId);
      const backward = [row("id-2"), row("id-1")].sort(compareClients(by)).map((r) => r.clientId);
      expect(forward).toEqual(["id-1", "id-2"]);
      expect(backward).toEqual(["id-1", "id-2"]);
    });
  }
});
