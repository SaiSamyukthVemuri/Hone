import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  classifyStartSessionSource,
  resolveStartSessionShape,
} from "../db/helpers/start-session-shape";

// CLN-002 characterization is schema-aware (tests/db/cln002-coalesce-
// characterization.db.test.ts): it asks the database which start_session it runs.
// This pins the detector on BOTH shapes, without a database, so a wrong detector
// cannot make the DB test pass for the wrong reason.
//
//   0181  the REAL migration text in this repo (the production chain's body).
//   0241  a verbatim fixture of the body from #1035 head bfd266d9 (0241 is not in
//         this repo until #1035 merges; the fixture header carries its sha256).

const ROOT = path.resolve(__dirname, "../..");

function body0181(): string {
  const sql = readFileSync(path.join(ROOT, "supabase/migrations/0181_multi_studio_command_authority.sql"), "utf8");
  const start = sql.indexOf("create or replace function public.start_session(");
  expect(start).toBeGreaterThan(-1);
  const open = sql.indexOf("as $$\n", start);
  const close = sql.indexOf("\n$$;", open);
  const text = sql.slice(open + "as $$\n".length, close);
  // The five-argument function, not the four-argument wrapper that follows it.
  expect(text).toContain("p_studio_id");
  expect(text).toContain("pg_advisory_xact_lock");
  return text;
}

function body0241(): string {
  const fixture = readFileSync(path.join(ROOT, "tests/fixtures/cln002-0241-start-session-body.sql.txt"), "utf8");
  return fixture.split("--- BODY ---\n")[1];
}

describe("start_session shape detector", () => {
  it("reads the repo's real 0181 body as 0181", () => {
    expect(classifyStartSessionSource(body0181())).toBe("0181");
  });

  it("reads the verbatim 0241 body as 0241", () => {
    expect(classifyStartSessionSource(body0241())).toBe("0241");
  });

  it("does not mistake 0181 for 0241 on the predicates its NULL-promotion UPDATE shares", () => {
    const b = normalizeCheck(body0181());
    expect(b).toContain("s.appointment_id is null");
    expect(b).toContain("appointment_id = p_appointment_id");
    expect(classifyStartSessionSource(body0181())).toBe("0181");
  });

  it("a 0241 predicate that appears only in a -- comment still reads as 0181", () => {
    const commented = body0181().replace(
      "order by s.started_at desc",
      "-- and (p_appointment_id is null or s.appointment_id = p_appointment_id or s.appointment_id is null)\n   order by s.started_at desc",
    );
    expect(commented).not.toBe(body0181());
    expect(classifyStartSessionSource(commented)).toBe("0181");
  });

  it("is insensitive to whitespace and case", () => {
    expect(classifyStartSessionSource(body0241().replace(/--.*$/gm, "").replace(/\n\s*/g, "   ").toUpperCase())).toBe("0241");
  });

  it("an empty body throws", () => {
    expect(() => classifyStartSessionSource("")).toThrow(/empty/);
    expect(() => classifyStartSessionSource("  \n -- only a comment\n")).toThrow(/empty/);
  });

  it("a body with no coalesce lookup throws", () => {
    expect(() => classifyStartSessionSource("begin return query select 1; end;")).toThrow(/exactly one coalesce lookup/);
  });

  it("both bodies concatenated (two lookups) throws", () => {
    expect(() => classifyStartSessionSource(`${body0181()}\n${body0241()}`)).toThrow(/exactly one coalesce lookup/);
  });

  it("a third shape throws rather than reading as either", () => {
    const third = body0241().replace("or s.appointment_id is null)", "or s.appointment_id is not null)");
    expect(third).not.toBe(body0241());
    expect(() => classifyStartSessionSource(third)).toThrow();
    const dropped = body0181().replace("and s.modality = p_modality", "");
    expect(() => classifyStartSessionSource(dropped)).toThrow(/common condition/);
  });
});

describe("start_session shape resolution (source + recorded migrations must agree)", () => {
  const recorded = (...v: string[]) => ["0212", ...v];

  it("0181 source with no 0241 recorded resolves to 0181", () => {
    expect(resolveStartSessionShape({ prosrc: body0181(), migrationsRecorded: recorded() })).toBe("0181");
  });

  it("0241 source with 0241 recorded resolves to 0241", () => {
    expect(resolveStartSessionShape({ prosrc: body0241(), migrationsRecorded: recorded("0241") })).toBe("0241");
  });

  it("a contradiction between the two signals throws, both ways", () => {
    expect(() => resolveStartSessionShape({ prosrc: body0181(), migrationsRecorded: recorded("0241") })).toThrow(/reads as 0181 but migration 0241 is recorded/);
    expect(() => resolveStartSessionShape({ prosrc: body0241(), migrationsRecorded: recorded() })).toThrow(/reads as 0241 but migration 0241 is not recorded/);
  });

  it("an unreadable source throws even when the history is clear", () => {
    expect(() => resolveStartSessionShape({ prosrc: "", migrationsRecorded: recorded() })).toThrow();
  });
});

function normalizeCheck(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/\s+/g, " ");
}
