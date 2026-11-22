import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseOrFilter } from "./helpers/postgrest-or";
import { emailBookingReference } from "@/lib/email/booking-reference";

// Global search by APPOINTMENT REFERENCE (the six characters in booking and
// cancellation email subjects). The real server action runs against an in-memory
// fake of the PostgREST reads it uses, over real rows, so "studio B is absent"
// means the query genuinely filtered it. The reference is derived from the id and
// recomputed over ids the viewer can read; these tests pin scope, normalisation,
// cancelled rows, ambiguity, honest failure and the scan bound.

type Row = Record<string, unknown>;

type QueryRecord = {
  table: string;
  select: string;
  eq: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
  neq: Array<[string, unknown]>;
  ilike: Array<[string, string]>;
  or: string[];
  in: Array<[string, readonly unknown[]]>;
  order: Array<[string, boolean]>;
  limit: number | null;
};

const tables: Record<string, Row[]> = {};
const queries: QueryRecord[] = [];
// When set, a read whose record it accepts answers with an error instead of
// rows; `failed` counts the reads it actually failed.
const fault: { when: ((q: QueryRecord) => boolean) | null; failed: number } = {
  when: null,
  failed: 0,
};

const RE_METACHARS = /[.*+?^${}()|[\]\\]/g;

// PostgREST ILIKE semantics: `%` matches any run, `_` matches one character, and
// a backslash escapes either into a literal. The action runs the practitioner's
// query through `escapeIlike` BEFORE interpolating it, so both wildcard and
// escaped forms genuinely reach this fake and both must be honoured.
//
// Translated with a single left-to-right scan rather than chained .replace()
// calls with placeholder sentinels: a sentinel must be a string that cannot occur
// in real input, and choosing one wrong silently corrupts the pattern.
function likeToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      // Escaped: the next character is a literal, whatever it is.
      out += pattern[++i].replace(RE_METACHARS, "\\$&");
      continue;
    }
    if (ch === "%") out += ".*";
    else if (ch === "_") out += ".";
    else out += ch.replace(RE_METACHARS, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

function matchesIlike(value: unknown, pattern: string): boolean {
  return typeof value === "string" && likeToRegExp(pattern).test(value);
}

// PostgREST filters an EMBEDDED resource with a dotted key — `session.deleted_at`
// — where `session` is the embed ALIAS. Resolving that path is not optional
// nicety: a fake that looked up the literal key `"session.deleted_at"` would find
// `undefined`, treat it as NULL, and pass EVERY row. The inactive-session tests
// would then be green against code that filters nothing at all.
//
// `{ found: false }` is distinct from `{ value: undefined }` so the caller can
// apply `!inner` semantics: a row whose embed is missing is DROPPED, exactly as
// an inner join drops it — never silently kept.
function resolvePath(row: Row, path: string): { found: boolean; value: unknown } {
  const segments = path.split(".");
  let current: unknown = row;
  for (const segment of segments) {
    if (Array.isArray(current)) current = current[0];
    if (current == null || typeof current !== "object") return { found: false, value: undefined };
    if (!(segment in (current as Record<string, unknown>))) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function builder(table: string, select: string) {
  const record: QueryRecord = {
    table,
    select,
    eq: [],
    is: [],
    neq: [],
    ilike: [],
    or: [],
    in: [],
    order: [],
    limit: null,
  };
  queries.push(record);
  const predicates: Array<(r: Row) => boolean> = [];
  let rangeWindow: [number, number] | null = null;

  const chain = {
    eq(col: string, val: unknown) {
      record.eq.push([col, val]);
      predicates.push((r) => r[col] === val);
      return chain;
    },
    is(col: string, val: unknown) {
      record.is.push([col, val]);
      // PostgREST .is(col, null) => col IS NULL. A dotted key targets the
      // embedded resource; with `!inner`, a row whose embed is absent is
      // dropped rather than treated as NULL-and-therefore-matching.
      predicates.push((r) => {
        const { found, value } = resolvePath(r, col);
        if (!found) return false;
        return (value ?? null) === val;
      });
      return chain;
    },
    neq(col: string, val: unknown) {
      record.neq.push([col, val]);
      predicates.push((r) => {
        const { found, value } = resolvePath(r, col);
        if (!found) return false;
        return value !== val;
      });
      return chain;
    },
    ilike(col: string, pattern: string) {
      record.ilike.push([col, pattern]);
      predicates.push((r) => matchesIlike(r[col], pattern));
      return chain;
    },
    or(expr: string) {
      record.or.push(expr);
      // "col.ilike.\"%x%\",…" — the only .or shape the action builds, parsed
      // the way PostgREST parses it (quoted values, backslash escapes).
      const clauses = parseOrFilter(expr).map((c) => {
        if (c.op !== "ilike") {
          throw new Error(`fake supabase: unsupported .or operator ${c.op}`);
        }
        return c;
      });
      predicates.push((r) => clauses.some((c) => matchesIlike(r[c.col], c.value)));
      return chain;
    },
    in(col: string, values: readonly unknown[]) {
      record.in.push([col, values]);
      predicates.push((r) => values.includes(r[col]));
      return chain;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      record.order.push([col, opts?.ascending !== false]);
      return chain;
    },
    limit(n: number) {
      record.limit = n;
      return chain;
    },
    // HON-58: the client-name candidate reads (non-ASCII names; paged).
    filter(col: string, op: string, value: string) {
      if (op !== "match") throw new Error(`fake supabase: unsupported filter ${op}`);
      const re = new RegExp(value, "u");
      predicates.push((r) => typeof r[col] === "string" && re.test(r[col] as string));
      return chain;
    },
    range(from: number, to: number) {
      rangeWindow = [from, to];
      return chain;
    },
    then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown) {
      if (fault.when?.(record)) {
        fault.failed++;
        return Promise.resolve({ data: null, error: { message: "fake read failure" } }).then(
          resolve as never,
        );
      }
      let rows = (tables[table] ?? []).filter((r) => predicates.every((p) => p(r)));
      for (const [col, ascending] of [...record.order].reverse()) {
        rows = [...rows].sort((a, b) => {
          const av = String(a[col] ?? "");
          const bv = String(b[col] ?? "");
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      if (rangeWindow) rows = rows.slice(rangeWindow[0], rangeWindow[1] + 1);
      if (record.limit != null) rows = rows.slice(0, record.limit);
      return Promise.resolve({ data: rows, error: null }).then(resolve as never);
    },
  };
  return chain;
}

const fakeSupabase = {
  from(table: string) {
    return { select: (cols: string) => builder(table, cols) };
  },
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const STUDIO_A = "studio-a";
const STUDIO_B = "studio-b";

const { createClientSpy, getCurrentPractitionerWithStudio, getSessionBlockAreasByBlockIds } = vi.hoisted(() => ({
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
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio, getSessionBlockAreasByBlockIds }));
// A tiny scan bound so the "stopped at the bound" case needs a handful of rows, not twenty thousand.
vi.mock("@/lib/search/appointment-reference", async (orig) => ({
  ...(await orig<typeof import("@/lib/search/appointment-reference")>()),
  REFERENCE_SCAN_PAGE: 2,
  REFERENCE_SCAN_CAP: 4,
}));
// Two appointments whose ids start "dup-" share one reference, so ambiguity is testable without a brute-force search.
vi.mock("@/lib/email/booking-reference", async (orig) => {
  const actual = await orig<typeof import("@/lib/email/booking-reference")>();
  return { ...actual, emailBookingReference: (id: string) => (id.startsWith("dup-") ? "DUPDUP" : actual.emailBookingReference(id)) };
});

import { globalSearchAction } from "@/app/(app)/global-search-actions";

function appt(id: string, studio: string, over: Record<string, unknown> = {}) {
  return {
    id, studio_id: studio, status: "confirmed", starts_at: "2026-11-25T18:00:00Z",
    client: { name: `Client ${id}` }, service: { name: "Facial" }, ...over,
  };
}
const idsOf = (r: Awaited<ReturnType<typeof globalSearchAction>>) =>
  r.ok ? r.results.filter((x) => x.type === "appointment").map((x) => x.id) : [];

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(tables)) delete tables[key];
  queries.length = 0;
  fault.when = null;
  fault.failed = 0;
  for (const t of ["session_blocks", "session_block_areas", "clients", "sessions", "record_keeping_sterile_items", "record_keeping_disinfectants", "services", "appointments"]) tables[t] = [];
  createClientSpy.mockResolvedValue(fakeSupabase);
  getCurrentPractitionerWithStudio.mockResolvedValue({ practitioner: { role: "practitioner" }, studio: { id: STUDIO_A } });
  getSessionBlockAreasByBlockIds.mockResolvedValue(new Map());
});

describe("appointment reference search", () => {
  it("finds the appointment from the reference as pasted (case, spaces, label), cancelled included, and lists it first", async () => {
    tables.appointments = [appt("a-1", STUDIO_A), appt("a-2", STUDIO_A, { status: "cancelled" }), appt("a-3", STUDIO_A)];
    const ref = emailBookingReference("a-2");
    for (const pasted of [ref, ref.toLowerCase(), `  ${ref}  `, `#${ref}`, `Ref ${ref.toLowerCase()}`, `reference: ${ref}`]) {
      const r = await globalSearchAction(pasted);
      expect(r.ok).toBe(true);
      expect(idsOf(r), pasted).toEqual(["appointment:a-2"]);
      if (r.ok) {
        const hit = r.results[0];
        expect(hit.href).toBe("/calendar/a-2");
        expect(hit.badge).toBe("cancelled");
      }
    }
  });

  it("never returns another studio's appointment, and every appointment read is scoped to the caller's studio", async () => {
    tables.appointments = [appt("b-1", STUDIO_B), appt("a-1", STUDIO_A)];
    const r = await globalSearchAction(emailBookingReference("b-1"));
    expect(idsOf(r)).toEqual([]);
    const reads = queries.filter((q) => q.table === "appointments");
    expect(reads.length).toBeGreaterThan(0);
    for (const q of reads) expect(q.eq).toContainEqual(["studio_id", STUDIO_A]);
  });

  it("an unknown reference is an empty, successful answer, not an error and not another appointment", async () => {
    tables.appointments = [appt("a-1", STUDIO_A)];
    const r = await globalSearchAction("ZZZZZZ");
    expect(r.ok).toBe(true);
    expect(idsOf(r)).toEqual([]);
  });

  it("ordinary text does not start a reference scan", async () => {
    tables.appointments = [appt("a-1", STUDIO_A)];
    for (const q of ["Ada", "Lovelace", "5 minutes", "a1b2c3d4"]) await globalSearchAction(q);
    expect(queries.filter((x) => x.table === "appointments" && x.select === "id")).toEqual([]);
  });

  it("an ambiguous reference lists every match and opens none by itself", async () => {
    tables.appointments = [appt("dup-1", STUDIO_A), appt("dup-2", STUDIO_A, { starts_at: "2026-11-26T18:00:00Z" }), appt("a-1", STUDIO_A)];
    const r = await globalSearchAction("dupdup");
    expect(idsOf(r).sort()).toEqual(["appointment:dup-1", "appointment:dup-2"]);
  });

  it("a failed read is a failed search, never 'no match'", async () => {
    tables.appointments = [appt("a-1", STUDIO_A)];
    fault.when = (q) => q.table === "appointments" && q.select === "id";
    expect(await globalSearchAction(emailBookingReference("a-1"))).toEqual({ ok: false });
    expect(fault.failed).toBeGreaterThan(0);
  });

  it("stopping at the scan bound without a match says so; a match inside the bound does not", async () => {
    tables.appointments = ["a-1", "a-2", "a-3", "a-4", "a-5", "a-6"].map((id) => appt(id, STUDIO_A));
    const beyond = await globalSearchAction(emailBookingReference("a-6"));
    expect(beyond.ok && beyond.referenceTruncated === true).toBe(true);
    expect(idsOf(beyond)).toEqual([]);
    const inside = await globalSearchAction(emailBookingReference("a-1"));
    expect(idsOf(inside)).toEqual(["appointment:a-1"]);
    tables.appointments = tables.appointments.slice(0, 4);
    const exact = await globalSearchAction("ZZZZZZ");
    expect(exact.ok && exact.referenceTruncated).toBeFalsy();
  });
});
