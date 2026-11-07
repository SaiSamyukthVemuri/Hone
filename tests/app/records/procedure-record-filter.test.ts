import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeProcedureRecordFilter,
  utcInstantsForLocalDayRange,
  FILTERED_PROCEDURE_RECORD_LIMIT,
} from "@/lib/record-keeping/queries";

// PR #223: per-client procedure record filter + print. Pure helpers
// are tested directly; the page/print wiring is source-pinned (no
// browser E2E harness exists yet; documented limitation).

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const QUERIES = read("lib/record-keeping/queries.ts");
const PAGE = read("app/(app)/records/page.tsx");
const PRINT = read("app/(app)/records/print/page.tsx");

const CLIENT_ID = "0b9f3c64-1111-4222-8333-444455556666";

describe("normalizeProcedureRecordFilter (pure)", () => {
  it("accepts a UUID client id and YYYY-MM-DD dates", () => {
    expect(
      normalizeProcedureRecordFilter({
        clientId: CLIENT_ID,
        from: "2026-06-01",
        to: "2026-06-12",
      }),
    ).toEqual({ clientId: CLIENT_ID, from: "2026-06-01", to: "2026-06-12" });
  });

  it("rejects non-UUID ids and malformed dates", () => {
    expect(
      normalizeProcedureRecordFilter({
        clientId: "1 or 1=1",
        from: "06/01/2026",
        to: "yesterday",
      }),
    ).toEqual({ clientId: null, from: null, to: null });
  });

  it("drops an inverted date range entirely", () => {
    expect(
      normalizeProcedureRecordFilter({
        clientId: CLIENT_ID,
        from: "2026-06-12",
        to: "2026-06-01",
      }),
    ).toEqual({ clientId: CLIENT_ID, from: null, to: null });
  });

  it("treats an impossible calendar date as absent, for from and for to, and never throws", () => {
    for (const bad of ["2026-13-01", "2026-00-10", "2026-06-00", "2026-06-32", "2026-02-30", "2027-02-29", "not-a-date", ""]) {
      expect(() => normalizeProcedureRecordFilter({ clientId: CLIENT_ID, from: bad, to: "2026-06-12" }), `from=${bad}`).not.toThrow();
      expect(normalizeProcedureRecordFilter({ clientId: CLIENT_ID, from: bad, to: "2026-06-12" }), `from=${bad}`).toEqual({
        clientId: CLIENT_ID,
        from: null,
        to: "2026-06-12",
      });
      expect(normalizeProcedureRecordFilter({ clientId: CLIENT_ID, from: "2026-06-01", to: bad }), `to=${bad}`).toEqual({
        clientId: CLIENT_ID,
        from: "2026-06-01",
        to: null,
      });
    }
  });

  it("drops a real date outside 1900-2100 so the +1 day arithmetic can never overflow (Insurance F-1)", () => {
    for (const bad of ["9999-12-31", "2101-01-01", "1899-12-31", "0001-01-01"]) {
      expect(normalizeProcedureRecordFilter({ from: bad, to: bad }), bad).toEqual({ clientId: null, from: null, to: null });
      const f = normalizeProcedureRecordFilter({ to: bad });
      expect(() => utcInstantsForLocalDayRange(f.from, f.to, "America/Toronto"), bad).not.toThrow();
    }
    // The edges of the window stay valid and convert cleanly.
    const edge = normalizeProcedureRecordFilter({ from: "1900-01-01", to: "2100-12-31" });
    expect(edge).toEqual({ clientId: null, from: "1900-01-01", to: "2100-12-31" });
    expect(() => utcInstantsForLocalDayRange(edge.from, edge.to, "America/Toronto")).not.toThrow();
  });

  it("keeps a leap day and the last day of a month", () => {
    expect(normalizeProcedureRecordFilter({ from: "2028-02-29", to: "2028-03-31" })).toEqual({ clientId: null, from: "2028-02-29", to: "2028-03-31" });
  });

  it("a filter the normalizer lets through can always be converted to UTC bounds (no RangeError)", () => {
    for (const bad of ["2026-13-01", "2026-06-32", "junk"]) {
      const f = normalizeProcedureRecordFilter({ from: bad, to: bad });
      expect(() => utcInstantsForLocalDayRange(f.from, f.to, "America/Toronto"), bad).not.toThrow();
    }
  });

  it("treats absent params as no filter", () => {
    expect(normalizeProcedureRecordFilter({})).toEqual({
      clientId: null,
      from: null,
      to: null,
    });
  });
});

describe("utcInstantsForLocalDayRange (pure)", () => {
  it("interprets the day bounds in the studio timezone (Toronto, EDT)", () => {
    const { fromUtc, toUtcExclusive } = utcInstantsForLocalDayRange(
      "2026-06-01",
      "2026-06-12",
      "America/Toronto",
    );
    // Toronto midnight in June is 04:00 UTC; the upper bound is the
    // start of the NEXT local day (exclusive).
    expect(fromUtc).toBe("2026-06-01T04:00:00.000Z");
    expect(toUtcExclusive).toBe("2026-06-13T04:00:00.000Z");
  });

  it("half-open bounds: only the provided side is set", () => {
    expect(
      utcInstantsForLocalDayRange("2026-06-01", null, "America/Toronto"),
    ).toEqual({
      fromUtc: "2026-06-01T04:00:00.000Z",
      toUtcExclusive: null,
    });
    expect(
      utcInstantsForLocalDayRange(null, null, "America/Toronto"),
    ).toEqual({ fromUtc: null, toUtcExclusive: null });
  });
});

describe("query layer: filter shape and scoping", () => {
  it("applies the client filter and date bounds on the sessions query", () => {
    expect(QUERIES).toMatch(
      /if \(filter\.clientId\) query = query\.eq\("client_id", filter\.clientId\);/,
    );
    expect(QUERIES).toMatch(
      /if \(filter\.fromUtc\) query = query\.gte\("started_at", filter\.fromUtc\);/,
    );
    expect(QUERIES).toMatch(/query\.lt\("started_at", filter\.toUtcExclusive\)/);
  });

  it("studio scoping is unconditional, before any filter", () => {
    // PR #318: studio scoping + the soft-delete filter are both unconditional
    // (applied before the conditional client/date filters).
    expect(QUERIES).toMatch(
      /\.from\("sessions"\)[\s\S]*?\.eq\("studio_id", studioId\)[\s\S]*?\.is\("deleted_at", null\);\s*\n\s*if \(filter\.clientId\)/,
    );
  });

  it("filtered pulls are capped, unfiltered default stays 30", () => {
    expect(QUERIES).toMatch(/FILTERED_PROCEDURE_RECORD_LIMIT = 200/);
    // PR #318: the unfiltered cap is now a named constant (still 30) so the
    // print view can reference it for an honest truncation notice.
    expect(QUERIES).toMatch(/UNFILTERED_PROCEDURE_RECORD_LIMIT = 30/);
    expect(QUERIES).toMatch(
      /filter\.clientId\s*\?\s*FILTERED_PROCEDURE_RECORD_LIMIT\s*:\s*UNFILTERED_PROCEDURE_RECORD_LIMIT/,
    );
    expect(FILTERED_PROCEDURE_RECORD_LIMIT).toBe(200);
  });

  it("PR #318: getClientProcedureRecords excludes soft-deleted sessions", () => {
    // The sessions query must filter deleted_at so a session deleted as a
    // correction never appears in Procedure Records / the inspection print.
    const fn = QUERIES.slice(
      QUERIES.indexOf("export async function getClientProcedureRecords"),
      QUERIES.indexOf("export async function getClientProcedureRecords") + 900,
    );
    expect(fn).toMatch(/\.from\("sessions"\)/);
    expect(fn).toMatch(/\.eq\("studio_id", studioId\)[\s\S]{0,400}\.is\("deleted_at", null\)/);
  });

  it("PR #318: unfiltered procedures print shows a truncation notice at the cap", () => {
    expect(PRINT).toMatch(/UNFILTERED_PROCEDURE_RECORD_LIMIT/);
    expect(PRINT).toMatch(
      /!filter\.clientId && records\.length >= UNFILTERED_PROCEDURE_RECORD_LIMIT/,
    );
    expect(PRINT).toMatch(/Showing the most recent \{UNFILTERED_PROCEDURE_RECORD_LIMIT\} records/);
    expect(PRINT).toMatch(/Filter by client for a complete procedure log/);
  });

  it("queries module stays practitioner-facing (user-scoped client only)", () => {
    expect(QUERIES).toMatch(/import { createClient } from "@\/lib\/supabase\/server";/);
    expect(QUERIES).not.toMatch(/admin-server|createAdminClient|service_role/);
  });
});

describe("Records page: filter UI", () => {
  it("renders a GET filter form with client select and date inputs", () => {
    expect(PAGE).toMatch(/<input type="hidden" name="section" value="procedures" \/>/);
    expect(PAGE).toMatch(/name="clientId"/);
    expect(PAGE).toMatch(/All clients \(most recent sessions\)/);
    expect(PAGE).toMatch(/type="date"\s+name="from"/);
    expect(PAGE).toMatch(/type="date"\s+name="to"/);
    expect(PAGE).toMatch(/Apply filter/);
  });

  it("Clear filters restores the unfiltered section", () => {
    expect(PAGE).toMatch(
      /href="\/records\?section=procedures"[\s\S]{0,200}Clear filters/,
    );
  });

  it("the active filter is announced and the cap is explained", () => {
    expect(PAGE).toMatch(/Showing \{records\.length\} recorded session/);
    expect(PAGE).toMatch(/capped at the \$\{FILTERED_PROCEDURE_RECORD_LIMIT\} most recent/);
  });

  it("the Print / Export link carries the procedure filter", () => {
    expect(PAGE).toMatch(
      /\/records\/print\?section=\$\{section\}\$\{section === "procedures" \? procedureFilterQuery : ""\}/,
    );
  });

  it("filtered empty state is distinct from the no-data state", () => {
    expect(PAGE).toMatch(/No recorded sessions match this filter\./);
    expect(PAGE).toMatch(/No sessions recorded yet\./);
  });

  it("params are sanitized through the shared normalizer", () => {
    expect(PAGE).toMatch(/normalizeProcedureRecordFilter\(\{/);
    expect(PAGE).toMatch(/utcInstantsForLocalDayRange\(/);
  });
});

describe("print route: filter parity", () => {
  it("reads the same params and runs them through the same normalizer", () => {
    expect(PRINT).toMatch(/clientId\?: string;/);
    expect(PRINT).toMatch(/normalizeProcedureRecordFilter\(\{/);
    expect(PRINT).toMatch(/utcInstantsForLocalDayRange\(/);
  });

  it("history toggle and back link preserve the filter", () => {
    expect(PRINT).toMatch(
      /history=1"\}\$\{section === "procedures" \? procedureFilterQuery : ""\}/,
    );
    expect(PRINT).toMatch(
      /\/records\?section=\$\{section\}\$\{section === "procedures" \? procedureFilterQuery : ""\}/,
    );
  });

  it("document header names the filtered client and date range", () => {
    expect(PRINT).toMatch(/Filtered: client/);
    expect(PRINT).toMatch(/filteredClient\?\.name/);
    expect(PRINT).toMatch(/recorded sessions from \$\{procedureFilter\.from/);
  });

  it("filtered empty state renders instead of a broken page", () => {
    expect(PRINT).toMatch(/No recorded sessions match this filter\./);
  });

  it("print stays practitioner-authenticated (no public/anon path)", () => {
    expect(PRINT).toMatch(/requirePractitionerWithStudio\(\)/);
    expect(PRINT).not.toMatch(/admin-server|createAdminClient|service_role/);
  });
});

describe("scope guards", () => {
  it("machine frequency renders where recorded, never invented", () => {
    expect(PAGE).toMatch(/a\.machineFrequency \? ` · \$\{a\.machineFrequency\}` : ""/);
    expect(PRINT).toMatch(/a\.machineFrequency \? ` · \$\{a\.machineFrequency\}` : ""/);
    expect(QUERIES).toMatch(/machineFrequency: \(b\.machine_frequency as string \| null\) \?\? null/);
  });

  it("PR #222 exposure owner tier is untouched by this PR", () => {
    // RECORDS-SECTION-RECOVERY: the section is called directly (not as JSX).
    expect(PAGE).toMatch(/ExposureIncidentsSection\(\{ studioId: studio\.id, isOwner \}\)/);
    expect(PAGE).toMatch(/Exposure incident history is owner-only/);
    expect(PRINT).toMatch(/owner-only and is not included in\s+this export/);
  });
});
