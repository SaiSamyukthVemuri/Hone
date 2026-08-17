import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  countVersion,
  fileForVersion,
  isRepoMax,
  migrationState,
  versionsAbove,
} from "./helpers/migration-state";

// 0184 — least-privilege repair for client_budget_context.
//
// 0183 is APPLIED TO PRODUCTION and therefore FROZEN. It stated its privilege
// contract as an allowlist ("authenticated gets SELECT/INSERT/UPDATE") but
// enforced it as a denylist (`revoke delete, truncate`), so every privilege it
// did not name survived from Supabase's create-time defaults — REFERENCES,
// TRIGGER and MAINTAIN. 0184 revokes everything and grants back exactly three.
//
// The behavioural half of this repair — that the tightened grants close the
// CREATE TRIGGER escalation while every trigger still fires — lives in
// tests/db/client-budget-context.db.test.ts against the real migrated
// database. This file is the source contract.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0184";
const SQL = readFileSync(
  path.join(ROOT, "supabase/migrations", fileForVersion(VERSION)),
  "utf8",
);
// The header deliberately discusses what 0184 does NOT do (and quotes 0183's
// defective statement), so negative assertions run against executable SQL only.
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

describe("0184: file and numbering", () => {
  it("is the repository maximum and carries the version exactly once", () => {
    expect(isRepoMax(VERSION)).toBe(true);
    expect(countVersion(VERSION)).toBe(1);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("is a NEW migration — 0183 was applied and must not be edited", () => {
    // The repair could not be made in place: 0183 has reached hosted
    // production, so its bytes are frozen and a correction is a new number.
    expect(countVersion("0183")).toBe(1);
    expect(migrationState().versions).toContain("0183");
  });

  it("never reintroduces 0158, which is permanently skipped", () => {
    expect(countVersion("0158")).toBe(0);
  });

  it("opens its own transaction with a bounded lock timeout", () => {
    expect(CODE).toMatch(/^begin;/m);
    expect(CODE).toMatch(/^commit;/m);
    expect(CODE).toMatch(/set local lock_timeout = '5s';/);
    expect(CODE.indexOf("set local lock_timeout")).toBeGreaterThan(
      CODE.indexOf("begin;"),
    );
  });
});

describe("0184: the table contract is an ALLOWLIST, not a denylist", () => {
  it("REVOKES ALL from every role before granting anything back", () => {
    // This is the whole fix. `revoke all` covers MAINTAIN — a PostgreSQL 17
    // privilege that no by-name revoke list written for 0183 could have
    // contained — and any privilege a future release invents.
    expect(CODE).toMatch(
      /revoke all on public\.client_budget_context\s*\n\s*from public, anon, authenticated, service_role;/,
    );
  });

  it("grants back EXACTLY select, insert and update, to authenticated only", () => {
    expect(CODE).toContain(
      "grant select, insert, update on public.client_budget_context to authenticated;",
    );
    // No second grant on the table to anyone else.
    const grants = CODE.match(/grant [^;]*on public\.client_budget_context[^;]*;/g) ?? [];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain("to authenticated");
  });

  it("does NOT re-enumerate privileges to remove — that was the defect", () => {
    // A `revoke delete, truncate ...` here would be the same mistake again.
    expect(CODE).not.toMatch(/revoke [a-z, ]*delete[a-z, ]*on public\.client_budget_context/);
    expect(CODE).not.toMatch(/revoke [a-z, ]*truncate[a-z, ]*on public\.client_budget_context/);
    expect(CODE).not.toMatch(/revoke [a-z, ]*references[a-z, ]*on public\.client_budget_context/);
  });

  it("names PUBLIC as well as the three roles", () => {
    // PUBLIC currently holds nothing, but the statement must express the whole
    // contract rather than only the delta that happens to be needed today.
    expect(CODE).toMatch(/from public, anon, authenticated, service_role/);
  });

  it("grants NO delete route", () => {
    expect(CODE).not.toMatch(/grant[^;]*delete[^;]*to authenticated/);
  });
});

describe("0184: trigger-function EXECUTE", () => {
  const FUNCTIONS = [
    "client_budget_context_set_studio_id",
    "client_budget_context_immutable_fields",
    "client_budget_context_server_timestamps",
  ];

  it("revokes EXECUTE on ALL THREE 0183 trigger functions", () => {
    for (const fn of FUNCTIONS) {
      expect(CODE, fn).toMatch(
        new RegExp(
          `revoke all privileges on function public\\.${fn}\\(\\)\\s*\\n\\s*from public, anon, authenticated, service_role;`,
        ),
      );
    }
  });

  it("does NOT touch public.set_updated_at()", () => {
    // A shared helper used by many tables since 0015. Its identical permissive
    // default is a repository-wide concern, not this ticket's.
    expect(CODE).not.toContain("set_updated_at");
  });

  it("touches no function outside the three 0183 introduced", () => {
    const touched = [...CODE.matchAll(/on function public\.([a-z_]+)\(\)/g)].map(
      (m) => m[1],
    );
    expect([...new Set(touched)].sort()).toEqual([...FUNCTIONS].sort());
  });
});

// ---------------------------------------------------------------------------
// POSITIVE EXECUTABLE-STATEMENT ALLOWLIST
//
// The previous protection was a denylist of forbidden DDL keywords, and that
// is exactly why a `comment on table` slipped into a migration whose header
// claimed "no DDL": the list enumerated CREATE/ALTER/DROP and nobody thought
// of COMMENT. It is the same enumerate-what-to-exclude mistake this migration
// exists to repair at the privilege layer, made one layer up in the proof.
//
// This asserts the opposite direction — that EVERY executable statement in the
// file is one of a small, exactly-enumerated set — so any newly inserted
// statement of ANY kind fails, including one nobody anticipated.
//
// Deliberately NOT a SQL parser. 0184 has a tiny finite grammar: strip whole
// line comments, split on `;`, normalize whitespace, and match each remaining
// statement against a fixed pattern list.
// ---------------------------------------------------------------------------

/** Executable statements in file order, comments stripped and whitespace collapsed. */
function executableStatements(): string[] {
  return SQL.split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

const FN = [
  "client_budget_context_set_studio_id",
  "client_budget_context_immutable_fields",
  "client_budget_context_server_timestamps",
] as const;

/** The COMPLETE set of statements 0184 is permitted to contain. */
const ALLOWED: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "begin", re: /^begin$/i },
  { label: "set local lock_timeout", re: /^set local lock_timeout = '5s'$/i },
  {
    label: "revoke all on the table",
    re: /^revoke all on public\.client_budget_context from public, anon, authenticated, service_role$/i,
  },
  {
    label: "grant the exact three to authenticated",
    re: /^grant select, insert, update on public\.client_budget_context to authenticated$/i,
  },
  ...FN.map((fn) => ({
    label: `revoke execute on ${fn}`,
    re: new RegExp(
      `^revoke all privileges on function public\\.${fn}\\(\\) from public, anon, authenticated, service_role$`,
      "i",
    ),
  })),
  { label: "commit", re: /^commit$/i },
];

describe("0184: GRANT/REVOKE only — positive statement contract", () => {
  it("EVERY executable statement is on the allowlist", () => {
    const unexpected = executableStatements().filter(
      (s) => !ALLOWED.some((a) => a.re.test(s)),
    );
    // Naming the offender makes a failure actionable rather than a bare count.
    expect(unexpected, `unrecognised executable statement(s): ${unexpected.join(" | ")}`).toEqual([]);
  });

  it("every allowlisted statement is actually PRESENT, exactly once", () => {
    // The mirror direction: an allowlist that permits statements which were
    // silently dropped would pass the check above while the repair did nothing.
    const statements = executableStatements();
    for (const { label, re } of ALLOWED) {
      const hits = statements.filter((s) => re.test(s));
      expect(hits, label).toHaveLength(1);
    }
  });

  it("contains EXACTLY the expected number of statements, in order", () => {
    const statements = executableStatements();
    expect(statements).toHaveLength(ALLOWED.length);
    statements.forEach((s, i) => {
      expect(s, `statement ${i} should be "${ALLOWED[i].label}"`).toMatch(
        ALLOWED[i].re,
      );
    });
  });

  it("prose in comments can never satisfy an executable assertion", () => {
    // The header quotes 0183's defective `revoke delete, truncate` and
    // discusses COMMENT ON. Those words exist in the file and must not count.
    expect(SQL).toContain("comment on table");
    expect(SQL).toMatch(/revoke delete, truncate/);
    const statements = executableStatements().join(" | ");
    expect(statements).not.toMatch(/comment on/i);
    expect(statements).not.toMatch(/revoke delete, truncate/i);
  });

  it("mutates ZERO business rows", () => {
    const statements = executableStatements().join(" | ");
    expect(statements).not.toMatch(/\binsert into\b/i);
    expect(statements).not.toMatch(/\bupdate\s+public\./i);
    expect(statements).not.toMatch(/\bdelete from\b/i);
    expect(statements).not.toMatch(/\btruncate\b/i);
  });

  it("touches no other table, and nothing outside budget context", () => {
    const tables = [...CODE.matchAll(/on (?:table )?public\.([a-z_]+)(?:\s|;)/g)]
      .map((m) => m[1])
      .filter((t) => !t.startsWith("client_budget_context"));
    expect(tables).toEqual([]);

    // Blank quoted literals before the keyword sweep: the table COMMENT is
    // prose that legitimately says "not income or payment data", and matching
    // that would be the same fixed-window mistake as reading past a statement
    // boundary — asserting on text rather than on statements.
    const statements = CODE.replace(/'[^']*'/g, "''");
    for (const forbidden of [
      "treatment_plans",
      "appointments",
      "sessions",
      "stripe",
      "payment",
      "client_clinical_notes",
      "client_personal_notes",
    ]) {
      expect(statements.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  it("states the privilege contract in the HEADER, not in an executable statement", () => {
    // The contract must still be written down where a reader will find it —
    // it just must not cost the migration a statement it did not declare.
    expect(SQL).toMatch(/authenticated\s+SELECT \+ INSERT \+ UPDATE/);
    expect(SQL).toMatch(/anon\s+nothing/);
    expect(SQL).toMatch(/service_role\s+nothing/);
    expect(SQL).toMatch(/PUBLIC\s+nothing/);
  });
});
