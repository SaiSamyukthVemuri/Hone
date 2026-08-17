import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { decideBudgetExportRead } from "@/lib/budget/export-read";

// P1 EXPORT REGRESSION.
//
// The defect this pins: client_budget_context was excluded from the export's
// all-or-nothing error guard so the migration-first window would survive. That
// tolerated EVERY failure, so a permission denial, a network fault, a failed
// later pagination page, or the paginator's own partial-read refusal each
// produced an ok:true ZIP silently missing known data.
//
// Only the proven "this relation does not exist" condition may be tolerated.
//
// MUTATION CHECK: make decideBudgetExportRead return omit_not_installed for
// any error and cases B, C and D below go red.

// Verbatim captures from this repository's local Supabase stack.
const MISSING_RELATION = {
  code: "PGRST205",
  message:
    "Could not find the table 'public.client_budget_context' in the schema cache",
};
const STALE_CACHE = {
  code: "42P01",
  message: 'relation "public.client_budget_context" does not exist',
};
const PERMISSION_DENIED = {
  code: "42501",
  message: "permission denied for table client_budget_context",
};

describe("A. pre-migration: the ONE tolerated failure", () => {
  it("a missing relation omits the file without failing the export", () => {
    expect(decideBudgetExportRead({ data: null, error: MISSING_RELATION })).toEqual(
      { kind: "omit_not_installed" },
    );
  });

  it("the stale-cache form of the same condition is also tolerated", () => {
    expect(decideBudgetExportRead({ data: null, error: STALE_CACHE })).toEqual({
      kind: "omit_not_installed",
    });
  });
});

describe("B. permission failure FAILS the whole export", () => {
  it("permission denied is fatal, never an omission", () => {
    const d = decideBudgetExportRead({ data: null, error: PERMISSION_DENIED });
    expect(d.kind).toBe("fail");
    expect(d.kind === "fail" && d.message).toContain("permission denied");
  });

  it("an RLS refusal is fatal", () => {
    expect(
      decideBudgetExportRead({
        data: null,
        error: { code: "42501", message: "new row violates row-level security policy" },
      }).kind,
    ).toBe("fail");
  });
});

describe("C. a failed LATER pagination page FAILS the whole export", () => {
  it("fetchAllRows propagates the page error verbatim, and it is fatal", () => {
    // fetchAllRows returns { data: null, error } when any page fails — the
    // first six pages are never returned as if they were the table. The
    // exporter must not then treat that as 'no budget data'.
    const d = decideBudgetExportRead({
      data: null,
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    });
    expect(d.kind).toBe("fail");
  });

  it("a network-shaped error with no code is fatal", () => {
    expect(
      decideBudgetExportRead({ data: null, error: { message: "fetch failed" } }).kind,
    ).toBe("fail");
  });
});

describe("D. the paginator's partial-read refusal FAILS the whole export", () => {
  it("'refusing to return a partial table' is fatal, not an omission", () => {
    // This is the refusal lib/export/paginate.ts raises rather than returning
    // a silently capped set. Swallowing it would reintroduce the exact
    // truncation that module exists to prevent.
    const d = decideBudgetExportRead({
      data: null,
      error: {
        message:
          "Export read exceeded 500 pages (500000 rows); refusing to return a partial table.",
      },
    });
    expect(d.kind).toBe("fail");
    expect(d.kind === "fail" && d.message).toContain("partial table");
  });
});

describe("E. a normal post-migration read exports the file", () => {
  it("rows are handed through for serialization", () => {
    const rows = [
      { client_id: "c1", budget_level: "somewhat_limited", budget_notes: "n" },
      { client_id: "c2", budget_level: null, budget_notes: "" },
    ];
    expect(decideBudgetExportRead({ data: rows, error: null })).toEqual({
      kind: "export",
      rows,
    });
  });
});

describe("F. an EMPTY table is data, not a failure", () => {
  it("zero rows still exports a file (header-only), never an omission", () => {
    // "Zero rows" and "could not read rows" must never be conflated: the
    // first is a truthful statement about the studio, the second is not.
    const d = decideBudgetExportRead({ data: [], error: null });
    expect(d).toEqual({ kind: "export", rows: [] });
    expect(d.kind).not.toBe("omit_not_installed");
  });

  it("a null payload with no error is fatal, not an empty export", () => {
    // PostgREST returns [] for an empty table. A null payload means something
    // else went wrong and must not silently become an empty CSV.
    expect(decideBudgetExportRead({ data: null, error: null }).kind).toBe("fail");
  });
});

describe("a missing DIFFERENT relation is never swallowed", () => {
  it("a broken deployment fails the export rather than omitting budget", () => {
    expect(
      decideBudgetExportRead({
        data: null,
        error: {
          code: "PGRST205",
          message: "Could not find the table 'public.clients' in the schema cache",
        },
      }).kind,
    ).toBe("fail");
  });
});

describe("the exporter is wired to this single decision point", () => {
  const ACTIONS = readFileSync(
    path.resolve(__dirname, "../../../app/(app)/settings/data/actions.ts"),
    "utf8",
  );
  const CODE = ACTIONS.split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

  it("calls decideBudgetExportRead and returns ok:false on fail", () => {
    expect(CODE).toContain("decideBudgetExportRead(");
    expect(CODE).toMatch(
      /budgetDecision\.kind === "fail"[\s\S]{0,200}ok: false/,
    );
  });

  it("does not carry a second, ad-hoc tolerance for this table", () => {
    // A duplicated inline `error?.code === "PGRST205"` here is how the two
    // surfaces would drift apart.
    expect(CODE).not.toContain("PGRST205");
    expect(CODE).not.toContain("42P01");
  });

  it("writes the CSV only on the export decision", () => {
    expect(CODE).toMatch(/budgetDecision\.kind === "export"/);
  });
});
