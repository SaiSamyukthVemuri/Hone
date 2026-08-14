import { beforeEach, describe, expect, it, vi } from "vitest";

// Global Search: behavioural proof that a treatment is findable by ANY of its
// structured treatment areas, not only by the legacy `primary_area`.
//
// These are NOT source greps. The real server action runs against an in-memory
// fake that implements the PostgREST filter semantics it actually uses
// (.eq / .is / .or / .ilike / .in / .order / .limit, terminated by .then), over
// real rows. So a test that says "Studio B is absent" is asserting that the
// query genuinely filtered it, and a test that says "one result" is asserting
// the merge genuinely deduplicated, not that some string appears in a file.
//
// The defect being pinned: a block charted as "Left Cheek · Right Sideburn"
// stores primary_area = "Cheek". Searching "Sideburn" matched nothing, even
// though the sideburn was displayed correctly once the block was found by some
// other means. Recall gap, not a display gap.

// ---------------------------------------------------------------------------
// Fake PostgREST read builder
// ---------------------------------------------------------------------------

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

// PostgREST filters an EMBEDDED resource with a dotted key, `session.deleted_at`,
// where `session` is the embed ALIAS. Resolving that path is not optional
// nicety: a fake that looked up the literal key `"session.deleted_at"` would find
// `undefined`, treat it as NULL, and pass EVERY row. The inactive-session tests
// would then be green against code that filters nothing at all.
//
// `{ found: false }` is distinct from `{ value: undefined }` so the caller can
// apply `!inner` semantics: a row whose embed is missing is DROPPED, exactly as
// an inner join drops it, never silently kept.
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
      // "col.ilike.%x%,other.ilike.%x%": the only .or shape the action builds.
      const clauses = expr.split(",").map((c) => {
        const [col, op, ...rest] = c.split(".");
        if (op !== "ilike") {
          throw new Error(`fake supabase: unsupported .or operator ${op}`);
        }
        return { col, pattern: rest.join(".") };
      });
      predicates.push((r) => clauses.some((c) => matchesIlike(r[c.col], c.pattern)));
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
    then(resolve: (v: { data: Row[]; error: null }) => unknown) {
      let rows = (tables[table] ?? []).filter((r) => predicates.every((p) => p(r)));
      for (const [col, ascending] of [...record.order].reverse()) {
        rows = [...rows].sort((a, b) => {
          const av = String(a[col] ?? "");
          const bv = String(b[col] ?? "");
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
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

const {
  createClientSpy,
  getCurrentPractitionerWithStudio,
  getSessionBlockAreasByBlockIds,
} = vi.hoisted(() => ({
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The multi-area block at the heart of the defect. primary_area is the LEGACY
// projection ("Cheek", the first area); the sideburn exists only as a child row.
const MULTI_AREA_BLOCK = {
  id: "block-multi",
  session_id: "session-1",
  studio_id: STUDIO_A,
  primary_area: "Cheek",
  side: null,
  block_name: null,
  caution_note: null,
  reaction_notes: null,
  probe_label: null,
  probe_lot_number: null,
  created_at: "2026-05-01T00:00:00Z",
  deleted_at: null,
  session: {
    client_id: "client-1",
    started_at: "2026-05-01T00:00:00Z",
    deleted_at: null,
    record_status: "draft",
    client: { name: "Ada Lovelace" },
  },
};

const AREAS_BY_BLOCK: Record<string, Array<{ area: string; laterality: string }>> = {
  "block-multi": [
    { area: "Cheek", laterality: "left" },
    { area: "Sideburn", laterality: "right" },
  ],
};

function seedDefault() {
  for (const key of Object.keys(tables)) delete tables[key];
  queries.length = 0;

  tables.session_blocks = [{ ...MULTI_AREA_BLOCK }];
  tables.session_block_areas = [
    {
      id: "area-1",
      session_block_id: "block-multi",
      studio_id: STUDIO_A,
      area: "Cheek",
      laterality: "left",
      display_order: 0,
      created_at: "2026-05-01T00:00:00Z",
    },
    {
      id: "area-2",
      session_block_id: "block-multi",
      studio_id: STUDIO_A,
      area: "Sideburn",
      laterality: "right",
      display_order: 1,
      created_at: "2026-05-01T00:00:01Z",
    },
  ];
  tables.clients = [];
  tables.sessions = [];
  tables.record_keeping_sterile_items = [];
  tables.record_keeping_disinfectants = [];
  tables.services = [];
  tables.appointments = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  seedDefault();
  createClientSpy.mockResolvedValue(fakeSupabase);
  getCurrentPractitionerWithStudio.mockResolvedValue({ studio: { id: STUDIO_A } });
  getSessionBlockAreasByBlockIds.mockImplementation(
    async (ids: readonly string[]) => {
      const out = new Map<string, Array<{ area: string; laterality: string }>>();
      for (const id of ids) {
        if (AREAS_BY_BLOCK[id]) out.set(id, AREAS_BY_BLOCK[id]);
      }
      return out;
    },
  );
});

async function search(q: string) {
  const res = await globalSearchAction(q);
  expect(res.ok).toBe(true);
  return res.ok ? res.results : [];
}

function memories(results: Awaited<ReturnType<typeof search>>) {
  return results.filter((r) => r.type === "memory");
}

function queriesFor(table: string) {
  return queries.filter((q) => q.table === table);
}

// ---------------------------------------------------------------------------

describe("a secondary structured area makes the treatment findable", () => {
  it("finds the block when ONLY a child area matches", async () => {
    const results = await search("Sideburn");
    const mem = memories(results);
    expect(mem).toHaveLength(1);
    expect(mem[0].id).toBe("memory:block:block-multi");
    expect(mem[0].title).toBe("Ada Lovelace");
  });

  it("shows the COMPLETE structured area label, not just the matched area", async () => {
    const mem = memories(await search("Sideburn"));
    expect(mem[0].subtitle).toBe("Session · Left Cheek · Right Sideburn");
  });

  it("links to the correct client session", async () => {
    const mem = memories(await search("Sideburn"));
    expect(mem[0].href).toBe("/clients/client-1/sessions/session-1");
    expect(mem[0].href.startsWith("/")).toBe(true);
  });

  it("is case-insensitive, following the existing ILIKE behaviour", async () => {
    for (const q of ["sideburn", "SIDEBURN", "Sideburn", "sIdEbUrN"]) {
      expect(memories(await search(q))).toHaveLength(1);
    }
  });

  it("matches a partial area word the same way the direct path does", async () => {
    expect(memories(await search("burn"))).toHaveLength(1);
  });

  it("still returns nothing for an area this studio never treated", async () => {
    // The negative half: recall widened, it did not become unconditional.
    expect(memories(await search("Nostril"))).toHaveLength(0);
  });
});

describe("a block matched by BOTH paths is one result", () => {
  it("dedupes the parent/child duplicate", async () => {
    // "Cheek" matches the legacy primary_area AND the structured child row.
    const mem = memories(await search("Cheek"));
    expect(mem).toHaveLength(1);
    expect(mem[0].id).toBe("memory:block:block-multi");
    // ...and the label is still the complete set.
    expect(mem[0].subtitle).toBe("Session · Left Cheek · Right Sideburn");
  });

  it("resolves areas for the merged id set exactly once", async () => {
    await search("Cheek");
    expect(getSessionBlockAreasByBlockIds).toHaveBeenCalledTimes(1);
    expect(getSessionBlockAreasByBlockIds.mock.calls[0][0]).toEqual(["block-multi"]);
    // Studio-scoped as defence in depth, exactly as the direct path was.
    expect(getSessionBlockAreasByBlockIds.mock.calls[0][1]).toBe(STUDIO_A);
  });
});

describe("tenant isolation and parent integrity", () => {
  it("scopes the child-area query to the current studio", async () => {
    await search("Sideburn");
    const [areaQuery] = queriesFor("session_block_areas");
    expect(areaQuery).toBeDefined();
    expect(areaQuery.eq).toContainEqual(["studio_id", STUDIO_A]);
    expect(areaQuery.ilike).toContainEqual(["area", "%Sideburn%"]);
    expect(areaQuery.limit).toBeGreaterThan(0);
  });

  it("scopes the parent-block fetch to the studio and excludes soft-deleted", async () => {
    await search("Sideburn");
    const parent = queriesFor("session_blocks").find((q) => q.in.length > 0);
    expect(parent).toBeDefined();
    expect(parent!.eq).toContainEqual(["studio_id", STUDIO_A]);
    expect(parent!.is).toContainEqual(["deleted_at", null]);
    expect(parent!.limit).toBeGreaterThan(0);
  });

  it("a foreign-studio area never surfaces its block", async () => {
    tables.session_blocks!.push({
      ...MULTI_AREA_BLOCK,
      id: "block-foreign",
      studio_id: STUDIO_B,
      primary_area: "Sideburn",
      // A COMPLETE, ACTIVE session: otherwise the parent-liveness filter would
      // drop this row and the tenant-isolation assertion would pass for the
      // wrong reason, hiding a studio-scoping regression.
      session: {
        client_id: "client-b",
        started_at: "2026-05-02T00:00:00Z",
        deleted_at: null,
        record_status: "draft",
        client: { name: "Other Studio Client" },
      },
    });
    tables.session_block_areas!.push({
      id: "area-foreign",
      session_block_id: "block-foreign",
      studio_id: STUDIO_B,
      area: "Sideburn",
      laterality: "right",
      display_order: 0,
      created_at: "2026-05-02T00:00:00Z",
    });
    const mem = memories(await search("Sideburn"));
    expect(mem).toHaveLength(1);
    expect(mem[0].id).toBe("memory:block:block-multi");
    expect(JSON.stringify(mem)).not.toContain("Other Studio Client");
  });

  it("a soft-deleted parent is excluded even when its child area matches", async () => {
    // session_block_areas has no soft-delete column of its own, the child row
    // survives, so the parent filter is the ONLY thing standing between a
    // deleted treatment and a search result.
    tables.session_blocks!.push({
      ...MULTI_AREA_BLOCK,
      id: "block-deleted",
      primary_area: "Jaw",
      deleted_at: "2026-05-03T00:00:00Z",
    });
    tables.session_block_areas!.push({
      id: "area-deleted",
      session_block_id: "block-deleted",
      studio_id: STUDIO_A,
      area: "Sideburn",
      laterality: "left",
      display_order: 0,
      created_at: "2026-05-03T00:00:00Z",
    });
    const mem = memories(await search("Sideburn"));
    expect(mem.map((m) => m.id)).toEqual(["memory:block:block-multi"]);
  });

  it("an orphaned child pointing at no live parent produces nothing", async () => {
    tables.session_block_areas!.push({
      id: "area-orphan",
      session_block_id: "block-that-does-not-exist",
      studio_id: STUDIO_A,
      area: "Nostril",
      laterality: "left",
      display_order: 0,
      created_at: "2026-05-04T00:00:00Z",
    });
    expect(memories(await search("Nostril"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Session 1C integration: a treatment record is searchable only while its PARENT
// SESSION is active. A live block can hang off a session that was soft-deleted
// or voided; surfacing it exposes history the studio logically removed and hands
// back a link that 404s. The filters live in the DATABASE (via `!inner`), so an
// inactive record is gone before ordering and before the cap.
// ---------------------------------------------------------------------------

function activeSession(over: Record<string, unknown> = {}) {
  return {
    client_id: "client-1",
    started_at: "2026-05-01T00:00:00Z",
    deleted_at: null,
    record_status: "draft",
    client: { name: "Ada Lovelace" },
    ...over,
  };
}

// A block that matches "Sideburn" DIRECTLY (legacy primary_area), with a parent
// session shaped by the caller. `created_at` is NEWER than the baseline block so
// an unfiltered implementation would rank it FIRST, making its absence
// meaningful rather than incidental.
function blockWithSession(
  id: string,
  session: Record<string, unknown>,
  over: Record<string, unknown> = {},
) {
  return {
    ...MULTI_AREA_BLOCK,
    id,
    session_id: `session-${id}`,
    primary_area: "Sideburn",
    created_at: "2026-09-01T00:00:00Z",
    session,
    ...over,
  };
}

function childAreaFor(blockId: string, area = "Sideburn") {
  return {
    id: `area-of-${blockId}`,
    session_block_id: blockId,
    studio_id: STUDIO_A,
    area,
    laterality: "left",
    display_order: 0,
    created_at: "2026-09-01T00:00:00Z",
  };
}

describe("only ACTIVE parent sessions are searchable", () => {
  it("an active direct match is included (positive control)", async () => {
    tables.session_blocks!.push(blockWithSession("blk-active-direct", activeSession()));
    const mem = memories(await search("Sideburn"));
    expect(mem.map((m) => m.id)).toContain("memory:block:blk-active-direct");
  });

  it("an active SECONDARY-area match is included (positive control)", async () => {
    tables.session_blocks!.push(
      blockWithSession("blk-active-child", activeSession(), { primary_area: "Jaw" }),
    );
    tables.session_block_areas!.push(childAreaFor("blk-active-child"));
    const mem = memories(await search("Sideburn"));
    expect(mem.map((m) => m.id)).toContain("memory:block:blk-active-child");
  });

  it("a SOFT-DELETED session's direct match is excluded", async () => {
    tables.session_blocks!.push(
      blockWithSession("blk-del-direct", activeSession({ deleted_at: "2026-09-02T00:00:00Z" })),
    );
    const mem = memories(await search("Sideburn"));
    expect(mem.map((m) => m.id)).not.toContain("memory:block:blk-del-direct");
  });

  it("a SOFT-DELETED session's child-area match is excluded", async () => {
    tables.session_blocks!.push(
      blockWithSession(
        "blk-del-child",
        activeSession({ deleted_at: "2026-09-02T00:00:00Z" }),
        { primary_area: "Jaw" },
      ),
    );
    tables.session_block_areas!.push(childAreaFor("blk-del-child"));
    const mem = memories(await search("Sideburn"));
    expect(mem.map((m) => m.id)).not.toContain("memory:block:blk-del-child");
  });

  it("a VOID session's direct match is excluded", async () => {
    tables.session_blocks!.push(
      blockWithSession("blk-void-direct", activeSession({ record_status: "void" })),
    );
    const mem = memories(await search("Sideburn"));
    expect(mem.map((m) => m.id)).not.toContain("memory:block:blk-void-direct");
  });

  it("a VOID session's child-area match is excluded", async () => {
    tables.session_blocks!.push(
      blockWithSession("blk-void-child", activeSession({ record_status: "void" }), {
        primary_area: "Jaw",
      }),
    );
    tables.session_block_areas!.push(childAreaFor("blk-void-child"));
    const mem = memories(await search("Sideburn"));
    expect(mem.map((m) => m.id)).not.toContain("memory:block:blk-void-child");
  });

  it("a 'finalized' session is still LIVE, only 'void' is withdrawn", async () => {
    // record_status is draft | finalized | void. Excluding anything other than
    // void would hide ordinary treatment history.
    tables.session_blocks!.push(
      blockWithSession("blk-finalized", activeSession({ record_status: "finalized" })),
    );
    const mem = memories(await search("Sideburn"));
    expect(mem.map((m) => m.id)).toContain("memory:block:blk-finalized");
  });

  it("a MALFORMED or missing parent never produces a result or a broken href", async () => {
    tables.session_blocks!.push(
      blockWithSession("blk-null-parent", null as never),
      blockWithSession("blk-no-client", activeSession({ client_id: null })),
    );
    const results = await search("Sideburn");
    const mem = memories(results);
    expect(mem.map((m) => m.id)).not.toContain("memory:block:blk-null-parent");
    expect(mem.map((m) => m.id)).not.toContain("memory:block:blk-no-client");
    for (const r of results) {
      expect(r.href).not.toContain("undefined");
      expect(r.href).not.toContain("null");
    }
  });

  it("the parent filters are applied by the QUERY, on BOTH block paths", async () => {
    await search("Sideburn");
    const blockQueries = queriesFor("session_blocks");
    expect(blockQueries.length).toBe(2);
    for (const q of blockQueries) {
      expect(q.select).toContain("sessions!inner");
      expect(q.is).toContainEqual(["deleted_at", null]);
      expect(q.is).toContainEqual(["session.deleted_at", null]);
      expect(q.neq).toContainEqual(["session.record_status", "void"]);
    }
  });

  it("the next-session-note path also excludes void sessions", async () => {
    await search("Sideburn");
    const [noteQuery] = queriesFor("sessions");
    expect(noteQuery).toBeDefined();
    expect(noteQuery.is).toContainEqual(["deleted_at", null]);
    expect(noteQuery.neq).toContainEqual(["record_status", "void"]);
  });
});

describe("inactive records never consume a treatment-memory slot", () => {
  it("four NEWER inactive matches do not displace older ACTIVE ones", async () => {
    // Every inactive row is newer than every active row, so an implementation
    // that filtered in JavaScript AFTER the cap would return zero active
    // results here. Filtering in the database is what keeps the slots.
    for (let i = 0; i < 4; i++) {
      tables.session_blocks!.push(
        blockWithSession(`blk-dead-${i}`, activeSession({ deleted_at: "2026-12-31T00:00:00Z" }), {
          created_at: `2026-12-0${i + 1}T00:00:00Z`,
        }),
        blockWithSession(`blk-void-${i}`, activeSession({ record_status: "void" }), {
          created_at: `2026-11-0${i + 1}T00:00:00Z`,
        }),
      );
    }
    for (let i = 0; i < 3; i++) {
      tables.session_blocks!.push(
        blockWithSession(`blk-live-${i}`, activeSession(), {
          created_at: `2026-06-0${i + 1}T00:00:00Z`,
        }),
      );
    }
    const mem = memories(await search("Sideburn"));
    const ids = mem.map((m) => m.id);
    expect(ids.some((id) => id.includes("dead"))).toBe(false);
    expect(ids.some((id) => id.includes("void"))).toBe(false);
    // The live rows kept their slots.
    expect(ids).toContain("memory:block:blk-live-2");
    expect(ids).toContain("memory:block:blk-live-1");
    expect(ids).toContain("memory:block:blk-live-0");
    expect(mem.length).toBeLessThanOrEqual(4);
  });

  it("ordering among the surviving ACTIVE rows is still newest-first", async () => {
    for (let i = 0; i < 3; i++) {
      tables.session_blocks!.push(
        blockWithSession(`blk-ord-${i}`, activeSession(), {
          created_at: `2026-06-0${i + 1}T00:00:00Z`,
        }),
      );
    }
    tables.session_blocks!.push(
      blockWithSession("blk-ord-dead", activeSession({ record_status: "void" }), {
        created_at: "2026-12-31T00:00:00Z",
      }),
    );
    const mem = memories(await search("Sideburn"));
    const ordered = mem.map((m) => m.id).filter((id) => id.includes("blk-ord-"));
    expect(ordered).toEqual([
      "memory:block:blk-ord-2",
      "memory:block:blk-ord-1",
      "memory:block:blk-ord-0",
    ]);
  });

  it("a direct + child duplicate on an ACTIVE session still consumes ONE slot", async () => {
    tables.session_blocks!.push(blockWithSession("blk-both", activeSession()));
    tables.session_block_areas!.push(childAreaFor("blk-both"));
    const mem = memories(await search("Sideburn"));
    expect(mem.filter((m) => m.id === "memory:block:blk-both")).toHaveLength(1);
  });
});

describe("caps stay enforced", () => {
  it("never returns more than the memory cap, however many areas match", async () => {
    for (let i = 0; i < 12; i++) {
      tables.session_blocks!.push({
        ...MULTI_AREA_BLOCK,
        id: `block-${i}`,
        primary_area: "Jaw",
        created_at: `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      });
      tables.session_block_areas!.push({
        id: `area-x-${i}`,
        session_block_id: `block-${i}`,
        studio_id: STUDIO_A,
        area: "Sideburn",
        laterality: "left",
        display_order: 0,
        created_at: `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      });
    }
    const mem = memories(await search("Sideburn"));
    expect(mem.length).toBeLessThanOrEqual(4);
    expect(new Set(mem.map((m) => m.id)).size).toBe(mem.length);
    // Newest first: the original block (2026-05-01) outranks every 2026-04 one.
    expect(mem[0].id).toBe("memory:block:block-multi");
  });

  it("respects the global total cap", async () => {
    const results = await search("Sideburn");
    expect(results.length).toBeLessThanOrEqual(12);
  });

  it("clients and appointments are still reachable alongside memory results", async () => {
    // Memory is appended AFTER clients and appointments, so widening memory
    // recall must not push them out of the global cap.
    tables.clients = [
      {
        id: "client-1",
        studio_id: STUDIO_A,
        name: "Sideburn Sam",
        email: "sam@example.test",
        phone: null,
        archived_at: null,
      },
    ];
    const results = await search("Sideburn");
    expect(results.filter((r) => r.type === "client")).toHaveLength(1);
    expect(memories(results)).toHaveLength(1);
  });
});

describe("query shape", () => {
  it("issues exactly ONE child-area query and ONE parent fetch, no N+1", async () => {
    for (let i = 0; i < 6; i++) {
      tables.session_blocks!.push({
        ...MULTI_AREA_BLOCK,
        id: `block-n-${i}`,
        primary_area: "Jaw",
      });
      tables.session_block_areas!.push({
        id: `area-n-${i}`,
        session_block_id: `block-n-${i}`,
        studio_id: STUDIO_A,
        area: "Sideburn",
        laterality: "left",
        display_order: 0,
        created_at: "2026-04-01T00:00:00Z",
      });
    }
    await search("Sideburn");
    expect(queriesFor("session_block_areas")).toHaveLength(1);
    // Two session_blocks queries total: the direct text match and the single
    // bounded parent fetch. Never one per area row, never one per block.
    expect(queriesFor("session_blocks")).toHaveLength(2);
  });

  it("skips the parent fetch entirely when no child area matched", async () => {
    await search("Nostril");
    expect(queriesFor("session_block_areas")).toHaveLength(1);
    expect(queriesFor("session_blocks")).toHaveLength(1);
  });

  it("selects the same columns on both memory paths", async () => {
    await search("Cheek");
    const blockQueries = queriesFor("session_blocks");
    expect(blockQueries).toHaveLength(2);
    expect(blockQueries[0].select).toBe(blockQueries[1].select);
  });

  it("uses the user-scoped client only, no admin client anywhere", async () => {
    await search("Sideburn");
    expect(createClientSpy).toHaveBeenCalled();
    // createAdminClient is mocked to throw; reaching it would have failed above.
    const { createAdminClient } = await import("@/lib/supabase/admin-server");
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("sanitized result shape", () => {
  it("emits only the safe result fields and no clinical body text", async () => {
    tables.session_blocks = [
      {
        ...MULTI_AREA_BLOCK,
        caution_note: "PATIENT REPORTED A BURN, do not repeat",
        reaction_notes: "significant erythema noted",
      },
    ];
    const mem = memories(await search("Sideburn"));
    expect(Object.keys(mem[0]).sort()).toEqual([
      "date",
      "href",
      "id",
      "subtitle",
      "title",
      "type",
    ]);
    // The caution is FLAGGED, never quoted.
    expect(mem[0].subtitle).toBe("Recorded caution · Left Cheek · Right Sideburn");
    const serialized = JSON.stringify(mem);
    expect(serialized).not.toContain("do not repeat");
    expect(serialized).not.toContain("erythema");
    expect(serialized).not.toContain("studio_id");
  });
});
