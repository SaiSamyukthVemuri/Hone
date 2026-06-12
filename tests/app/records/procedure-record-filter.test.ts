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
    expect(QUERIES).toMatch(
      /\.from\("sessions"\)[\s\S]*?\.eq\("studio_id", studioId\);\s*\n\s*if \(filter\.clientId\)/,
    );
  });

  it("filtered pulls are capped, unfiltered default stays 30", () => {
    expect(QUERIES).toMatch(/FILTERED_PROCEDURE_RECORD_LIMIT = 200/);
    expect(QUERIES).toMatch(
      /filter\.limit \?\? \(filter\.clientId \? FILTERED_PROCEDURE_RECORD_LIMIT : 30\)/,
    );
    expect(FILTERED_PROCEDURE_RECORD_LIMIT).toBe(200);
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
    expect(PRINT).toMatch(/getCurrentPractitionerWithStudio\(\)/);
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
    expect(PAGE).toMatch(/isOwner=\{isOwner\}/);
    expect(PAGE).toMatch(/Exposure incident history is owner-only/);
    expect(PRINT).toMatch(/owner-only and is not included in\s+this export/);
  });
});
