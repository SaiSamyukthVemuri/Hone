import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseOrFilter } from "./helpers/postgrest-or";

// HON-58 — global search finds the same client record by preferred name,
// legal name or surname, without parentheses or the exact display string,
// across case, spacing, punctuation and diacritics.
//
// The real server action runs against an in-memory fake that applies the
// PostgREST filters it builds (.eq / .is / .neq / .ilike / .or / .in /
// .filter(match) / .order / .limit / .range), so "found" means the query really admitted the row and
// matchesClientSearch really confirmed it. Every name is SYNTHETIC.

type Row = Record<string, unknown>;

const tables: Record<string, Row[]> = {};
const ilikeCalls: Array<{ table: string; col: string; pattern: string }> = [];
// The most rows one response may carry (PostgREST db-max-rows). Tests lower it
// to prove a short page does not end a read early.
const server = { maxRows: 1000 };

const RE_METACHARS = /[.*+?^${}()|[\]\\]/g;

function likeToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      out += pattern[++i].replace(RE_METACHARS, "\\$&");
      continue;
    }
    if (ch === "%") out += ".*";
    else if (ch === "_") out += ".";
    else out += ch.replace(RE_METACHARS, "\\$&");
  }
  return new RegExp(`^${out}$`, "is");
}

function matchesIlike(value: unknown, pattern: string): boolean {
  return typeof value === "string" && likeToRegExp(pattern).test(value);
}

function builder(table: string) {
  const predicates: Array<(r: Row) => boolean> = [];
  const orderCols: string[] = [];
  let limit: number | null = null;
  let range: [number, number] | null = null;
  const chain = {
    eq(col: string, val: unknown) {
      predicates.push((r) => r[col] === val);
      return chain;
    },
    is(col: string, val: unknown) {
      predicates.push((r) => (r[col] ?? null) === val);
      return chain;
    },
    neq(col: string, val: unknown) {
      predicates.push((r) => r[col] !== val);
      return chain;
    },
    ilike(col: string, pattern: string) {
      ilikeCalls.push({ table, col, pattern });
      predicates.push((r) => matchesIlike(r[col], pattern));
      return chain;
    },
    or(expr: string) {
      const clauses = parseOrFilter(expr).map((c) => {
        if (c.op !== "ilike") throw new Error(`fake supabase: unsupported .or operator ${c.op}`);
        return c;
      });
      predicates.push((r) => clauses.some((c) => matchesIlike(r[c.col], c.value)));
      return chain;
    },
    filter(col: string, op: string, value: string) {
      if (op !== "match") throw new Error(`fake supabase: unsupported filter operator ${op}`);
      const re = new RegExp(value, "u");
      predicates.push((r) => typeof r[col] === "string" && re.test(r[col] as string));
      return chain;
    },
    in(col: string, values: readonly unknown[]) {
      predicates.push((r) => values.includes(r[col]));
      return chain;
    },
    order(col: string) {
      orderCols.push(col);
      return chain;
    },
    limit(n: number) {
      limit = n;
      return chain;
    },
    range(from: number, to: number) {
      range = [from, to];
      return chain;
    },
    then(resolve: (v: { data: Row[]; error: null }) => unknown) {
      let rows = (tables[table] ?? []).filter((r) => predicates.every((p) => p(r)));
      if (orderCols.length > 0) {
        rows = [...rows].sort((a, b) => {
          for (const col of orderCols) {
            const c = String(a[col] ?? "").localeCompare(String(b[col] ?? ""));
            if (c !== 0) return c;
          }
          return 0;
        });
      }
      if (range) rows = rows.slice(range[0], range[1] + 1);
      if (limit != null) rows = rows.slice(0, limit);
      rows = rows.slice(0, server.maxRows);
      return Promise.resolve({ data: rows, error: null }).then(resolve as never);
    },
  };
  return chain;
}

const fakeSupabase = {
  from(table: string) {
    return { select: () => builder(table) };
  },
};

const STUDIO_A = "studio-a";
const STUDIO_B = "studio-b";

const { createClientSpy, getCurrentPractitionerWithStudio, getSessionBlockAreasByBlockIds } =
  vi.hoisted(() => ({
    createClientSpy: vi.fn(),
    getCurrentPractitionerWithStudio: vi.fn(),
    getSessionBlockAreasByBlockIds: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({ createClient: createClientSpy }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: vi.fn(() => {
    throw new Error("global search must never use the service role");
  }),
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio,
  getSessionBlockAreasByBlockIds,
}));

import { globalSearchAction } from "@/app/(app)/global-search-actions";

function client(id: string, name: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    studio_id: STUDIO_A,
    name,
    email: null,
    phone: null,
    archived_at: null,
    ...extra,
  };
}

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  ilikeCalls.length = 0;
  server.maxRows = 1000;
  tables.clients = [
    client("c-janie", "Jane (Janie) Smith", { phone: "(555) 010-0001" }),
    client("c-obrien", "Saoirse O'Brien"),
    client("c-mk", "Mary-Kate Olsen"),
    client("c-jose", "José Álvarez"),
    client("c-comma", "Doe,  Robin"),
    client("c-other", "Janet Smithers"),
    client("c-archived", "Jane Smith", { archived_at: "2026-01-01T00:00:00Z" }),
    client("c-foreign", "Jane (Janie) Smith", { studio_id: STUDIO_B }),
  ];
  createClientSpy.mockResolvedValue(fakeSupabase);
  getCurrentPractitionerWithStudio.mockResolvedValue({
    practitioner: { id: "p-1", role: "owner" },
    studio: { id: STUDIO_A, google_calendar_connection_enabled: false },
  });
  getSessionBlockAreasByBlockIds.mockResolvedValue({});
});

async function clientIdsFor(query: string): Promise<string[]> {
  const res = await globalSearchAction(query);
  if (!res.ok) throw new Error("search failed");
  return res.results
    .filter((r) => r.type === "client")
    .map((r) => r.id.replace(/^client:/, ""));
}

describe("global search: one record, many ways in", () => {
  it.each([
    ["preferred name alone", "janie"],
    ["preferred name + surname, no parentheses", "janie smith"],
    ["legal given name + surname", "Jane Smith"],
    ["surname-first with a comma", "smith, janie"],
    ["upper case, doubled spaces", "JANIE   SMITH"],
    ["phone digits without formatting", "5550100001"],
  ])("%s (%j) finds the record", async (_label, query) => {
    expect(await clientIdsFor(query)).toContain("c-janie");
  });

  it.each([
    ["obrien", "c-obrien"],
    ["o brien", "c-obrien"],
    ["mary kate", "c-mk"],
    ["jose alvarez", "c-jose"],
    ["robin doe", "c-comma"],
  ])("%j finds %s across punctuation, diacritics and order", async (query, id) => {
    expect(await clientIdsFor(query)).toContain(id);
  });

  it("returns the record once, never a duplicate from two read paths", async () => {
    const ids = await clientIdsFor("smith");
    expect(ids.filter((id) => id === "c-janie")).toHaveLength(1);
  });

  it("does not widen past the studio or into archived clients", async () => {
    const ids = await clientIdsFor("janie smith");
    expect(ids).not.toContain("c-foreign");
    expect(await clientIdsFor("jane smith")).not.toContain("c-archived");
  });

  it("does not admit a candidate the shared matcher rejects", async () => {
    // "jane smith" is a subsequence of "Janet Smithers" for ILIKE, and is also a
    // word-prefix match, so it IS a legitimate result. "janie smith" is not.
    expect(await clientIdsFor("janie smith")).not.toContain("c-other");
  });

  it("builds candidate patterns from folded letters only", async () => {
    await clientIdsFor("O'Brien, (x%_)");
    const nameCandidates = ilikeCalls.filter((c) => c.table === "clients" && c.col === "name");
    expect(nameCandidates.length).toBeGreaterThan(0);
    for (const { pattern } of nameCandidates) {
      expect(pattern).toMatch(/^%(?:[\p{L}\p{N}_]%)+$/u);
    }
  });
});

// Codex P2 4366960913: a candidate cap applied BEFORE confirmation dropped
// genuine matches. Every row below passes the wide name prefilter for
// "janie smith" ("Jan Ieva Smith" carries j-a-n-i-e and s-m-i-t-h in order)
// but fails the shared matcher, and all of them sort before the real record.
describe("global search: candidates are confirmed before any cap", () => {
  const decoys = (n: number) =>
    Array.from({ length: n }, (_, i) => client(`c-decoy-${i}`, `Jan Ieva Smith ${String(i).padStart(4, "0")}`));

  it("finds the record behind 50 earlier unconfirmed candidates", async () => {
    tables.clients.push(...decoys(50), client("c-zoe", "Zoe (Janie) Smith"));
    expect(await clientIdsFor("janie smith")).toEqual(["c-janie", "c-zoe"]);
  });

  it("pages past a full page of unconfirmed candidates", async () => {
    tables.clients.push(...decoys(1200), client("c-zoe", "Zoe (Janie) Smith"));
    expect(await clientIdsFor("janie smith")).toEqual(["c-janie", "c-zoe"]);
  });

  it("a server row cap below the page size does not end the read early", async () => {
    server.maxRows = 7;
    tables.clients.push(...decoys(30), client("c-zoe", "Zoe (Janie) Smith"));
    expect(await clientIdsFor("janie smith")).toEqual(["c-janie", "c-zoe"]);
  });
});

// Codex P2 4366960916: the prefilter wildcarded only a, c, e, i, n, o, u and
// y, so a name whose diacritic sits on any other letter could never be a
// candidate, although the shared matcher (client list, booking drawer) finds it.
describe("global search: every letter the matcher folds can be found", () => {
  it.each([
    ["simon", "Šimon Novák"],
    ["novak", "Šimon Novák"],
    ["zaneta", "Žaneta Dvořáková"],
    ["dvorakova", "Žaneta Dvořáková"],
    ["łodz", "Łucja Łódź"],
    ["ozgur", "Özgür Şahin"],
    ["sahin", "Özgür Şahin"],
  ])("%j finds %j", async (query, name) => {
    tables.clients.push(client("c-accented", name));
    expect(await clientIdsFor(query)).toContain("c-accented");
  });

  it("agrees with the shared matcher for every stored name and query here", async () => {
    const { matchesClientSearch } = await import("@/lib/clients/name-search");
    const names = ["Šimon Novák", "Žaneta Dvořáková", "Ǆemal Ĳsselstein", "Ｊａｎｅ Ｓｍｉｔｈ", "José Álvarez", "Ana Ḃeth"];
    tables.clients.push(...names.map((n, i) => client(`c-n${i}`, n)));
    for (const q of ["simon", "zaneta", "dzemal", "ijsselstein", "jane smith", "jose", "beth", "smith jane"]) {
      const expected = names.flatMap((n, i) => (matchesClientSearch({ name: n }, q) ? [`c-n${i}`] : []));
      const got = (await clientIdsFor(q)).filter((id) => id.startsWith("c-n"));
      expect(got.sort(), q).toEqual(expected.sort());
    }
  });
});

// Codex P2 4367010228: the direct read swapped `,` `(` `)` `"` for the `_`
// wildcard and its rows were merged unconfirmed, so near-misses could fill
// the client cap. Every read now keeps the query's punctuation literal (each
// `.or()` value is double-quoted, PostgREST's escaping) and every client row is
// confirmed by the shared matcher before it counts.
describe("global search: punctuation stays literal and direct rows are confirmed", () => {
  const recordIdsFor = async (query: string) => {
    const res = await globalSearchAction(query);
    if (!res.ok) throw new Error("search failed");
    return res.results.filter((r) => r.type === "record").map((r) => r.id);
  };

  it("five earlier wildcard near-misses do not crowd out the literal match", async () => {
    tables.clients.push(
      ...["A", "B", "C", "D", "E"].map((x) => client(`c-near-${x}`, `Jane${x}Smith${x}`)),
      client("c-zoe-paren", "Zoe Jane(Smith)"),
    );
    const ids = await clientIdsFor("Jane(Smith)");
    expect(ids).toContain("c-zoe-paren");
    expect(ids.filter((id) => id.startsWith("c-near-"))).toEqual([]);
  });

  it("an unconfirmed direct row cannot take a slot from a genuine match", async () => {
    // "--" is a raw substring of these five names, but no client-list rule
    // accepts a name for a query with no letters or digits; the phone is a
    // genuine raw match.
    tables.clients.push(
      ...["A", "B", "C", "D", "E"].map((x) => client(`c-dash-${x}`, `${x}nna--Lee`)),
      client("c-dash-phone", "Zed Young", { phone: "555--0100" }),
    );
    expect(await clientIdsFor("--")).toEqual(["c-dash-phone"]);
  });

  it("a comma, quote or backslash in the query is matched literally, never as syntax", async () => {
    tables.clients.push(
      client("c-quote", 'Ann "Nan" Lee'),
      client("c-slash", "Bo\\Ko Lee"),
      client("c-comma2", "Lee, Ann"),
    );
    expect(await clientIdsFor('"Nan"')).toContain("c-quote");
    expect(await clientIdsFor("Bo\\Ko")).toContain("c-slash");
    expect(await clientIdsFor("Lee, Ann")).toContain("c-comma2");
  });

  it("the record reads match punctuation literally too", async () => {
    tables.record_keeping_sterile_items = [
      { id: "s-wild", studio_id: STUDIO_A, item_description: "Gauze aXb", lot_number: "L-1", date_purchased: "2026-01-02" },
      { id: "s-real", studio_id: STUDIO_A, item_description: "Gauze a(b", lot_number: "L-2", date_purchased: "2026-01-01" },
    ];
    const ids = await recordIdsFor("a(b");
    expect(ids).toContain("record:sterile:s-real");
    expect(ids).not.toContain("record:sterile:s-wild");
  });
});
