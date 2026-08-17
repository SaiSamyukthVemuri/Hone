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

describe("0184: GRANT/REVOKE only — no schema or data change", () => {
  it("contains no DDL", () => {
    for (const ddl of [
      /create table/i,
      /alter table/i,
      /drop table/i,
      /add column/i,
      /drop column/i,
      /add constraint/i,
      /drop constraint/i,
      /create index/i,
      /create trigger/i,
      /drop trigger/i,
      /create or replace function/i,
      /create policy/i,
      /drop policy/i,
      /alter policy/i,
    ]) {
      expect(CODE, String(ddl)).not.toMatch(ddl);
    }
  });

  it("mutates ZERO business rows", () => {
    expect(CODE).not.toMatch(/\binsert into\b/i);
    expect(CODE).not.toMatch(/\bupdate\s+public\./i);
    expect(CODE).not.toMatch(/\bdelete from\b/i);
    expect(CODE).not.toMatch(/\btruncate\b/i);
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

  it("re-states the privilege contract in the table comment", () => {
    expect(CODE).toContain("comment on table public.client_budget_context is");
    expect(SQL).toMatch(/authenticated holds SELECT\/INSERT\/UPDATE and nothing else/);
  });
});
