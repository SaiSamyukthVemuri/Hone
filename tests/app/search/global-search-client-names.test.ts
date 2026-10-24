import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-58 — global search finds the same client record by preferred name,
// legal name or surname, without parentheses or the exact display string,
// across case, spacing, punctuation and diacritics.
//
// The real server action runs against an in-memory fake that applies the
// PostgREST filters it builds (.eq / .is / .neq / .ilike / .or / .in /
// .order / .limit), so "found" means the query really admitted the row and
// matchesClientSearch really confirmed it. Every name is SYNTHETIC.

type Row = Record<string, unknown>;

const tables: Record<string, Row[]> = {};
const ilikeCalls: Array<{ table: string; col: string; pattern: string }> = [];

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
  let orderCol: string | null = null;
  let limit: number | null = null;
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
      const clauses = expr.split(",").map((c) => {
        const [col, op, ...rest] = c.split(".");
        if (op !== "ilike") throw new Error(`fake supabase: unsupported .or operator ${op}`);
        return { col, pattern: rest.join(".") };
      });
      predicates.push((r) => clauses.some((c) => matchesIlike(r[c.col], c.pattern)));
      return chain;
    },
    in(col: string, values: readonly unknown[]) {
      predicates.push((r) => values.includes(r[col]));
      return chain;
    },
    order(col: string) {
      orderCol = col;
      return chain;
    },
    limit(n: number) {
      limit = n;
      return chain;
    },
    then(resolve: (v: { data: Row[]; error: null }) => unknown) {
      let rows = (tables[table] ?? []).filter((r) => predicates.every((p) => p(r)));
      if (orderCol) {
        const col = orderCol;
        rows = [...rows].sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")));
      }
      if (limit != null) rows = rows.slice(0, limit);
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
