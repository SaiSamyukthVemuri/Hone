import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  countVersion,
  fileForVersion,
  isRepoMax,
  versionsAbove,
} from "./helpers/migration-state";

// 0186 — intake reminders move to ~24h / ~2h and are COMPOSED into the window
// email. This file is the SOURCE CONTRACT.
//
// The migration is deliberately one additive column, and most of what matters
// about it is what it does NOT do. Two named mutations this file is built to
// catch:
//
//   * reusing the historical 7d/3d columns for the new cadence -> the
//     "leaves 0098 state alone" assertions fail here, and the behavioural
//     suite loses its at-most-one-email guarantee;
//   * re-creating claim_email_send / record_email_result to add a slot ->
//     the "creates no function" assertion fails here. That is the operation
//     that produced 0129 (anon missed), 0164 (service_role missed) and
//     0183/0184 (MAINTAIN missed), and this change has no reason to perform it.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0186";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", FILE), "utf8");

// The header explains at length what this migration must not do and names the
// objects it deliberately leaves alone, so every negative assertion runs
// against EXECUTABLE SQL only.
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

// CODE with SQL string literals blanked. `comment on column ... is '...'` is
// executable SQL, and this migration's comment names reminder_24h / reminder_2h
// in prose to explain the slot it rides on. Assertions about what the file
// TOUCHES run against this projection; assertions about what it SAYS run
// against CODE.
const STATEMENTS = CODE.replace(/'(?:[^']|'')*'/g, "''");

describe("0186 — migration state", () => {
  // THE HAND-OFF HAPPENED. This block used to assert isRepoMax("0186") and
  // versionsAbove([]). 0187 (appointment settlement, PAY-SETTLE) was authored
  // above it, so per CLAUDE.md §2 only the CURRENT maximum's own test carries
  // the "nothing above me" tripwire. The successor assertions now live in
  // tests/migrations/0187-appointment-settlement.test.ts. Same shape as the
  // 0180 -> 0181 and 0176 -> 0177 hand-offs before it.
  it("is no longer the repository maximum — 0187 was authored above it", () => {
    expect(isRepoMax(VERSION)).toBe(false);
    expect(versionsAbove(VERSION)).toContain("0187");
  });

  it("consumes exactly ONE number", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("is named for what it does", () => {
    expect(FILE).toBe("0186_intake_reminder_24h_2h.sql");
  });
});

describe("0186 — transactional envelope", () => {
  it("opens its own transaction and sets the lock timeout INSIDE it", () => {
    // `supabase db push` does not wrap a file in a transaction, so a bare
    // SET LOCAL emits 25P01 and never arms. Order matters: begin first.
    const beginAt = STATEMENTS.indexOf("begin;");
    const lockAt = STATEMENTS.indexOf("set local lock_timeout");
    expect(beginAt).toBeGreaterThan(-1);
    expect(lockAt).toBeGreaterThan(beginAt);
    expect(STATEMENTS).toMatch(/set local lock_timeout = '?/);
    expect(STATEMENTS.trimEnd().endsWith("commit;")).toBe(true);
  });
});

describe("0186 — the one thing it adds", () => {
  it("adds studios.send_intake_reminders, additive and re-runnable", () => {
    expect(STATEMENTS).toMatch(
      /alter table public\.studios\s+add column if not exists send_intake_reminders boolean not null default true;/,
    );
  });

  it("defaults TRUE, so no existing studio silently loses intake reminders", () => {
    expect(STATEMENTS).toMatch(/send_intake_reminders boolean not null default true/);
    expect(STATEMENTS).not.toMatch(/send_intake_reminders boolean not null default false/);
  });

  it("documents the column", () => {
    expect(CODE).toMatch(/comment on column public\.studios\.send_intake_reminders is/);
  });

  it("adds exactly ONE column and touches exactly ONE table", () => {
    expect(STATEMENTS.match(/add column/g) ?? []).toHaveLength(1);
    const tables = [...STATEMENTS.matchAll(/alter table (public\.\w+)/g)].map(
      (m) => m[1],
    );
    expect(new Set(tables)).toEqual(new Set(["public.studios"]));
  });
});

describe("0186 — creates no function, so the grant-enumeration class cannot recur", () => {
  it("does not create or replace ANY function", () => {
    expect(STATEMENTS).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
    expect(STATEMENTS).not.toMatch(/drop\s+function/i);
  });

  it("issues no grant or revoke at all", () => {
    expect(STATEMENTS).not.toMatch(/\bgrant\b/i);
    expect(STATEMENTS).not.toMatch(/\brevoke\b/i);
  });
});

describe("0186 — the historical 7d/3d state is preserved, not reinterpreted", () => {
  it("never renames, drops, alters or writes the 0098 intake-reminder columns", () => {
    expect(STATEMENTS).not.toMatch(/intake_reminder_7d/);
    expect(STATEMENTS).not.toMatch(/intake_reminder_3d/);
  });

  it("never touches the appointments table or its reminder send-state", () => {
    expect(STATEMENTS).not.toMatch(/alter table public\.appointments/);
    expect(STATEMENTS).not.toMatch(/reminder_24h_sent_at|reminder_2h_sent_at/);
  });

  it("never touches the 0098 claim/record RPCs", () => {
    expect(STATEMENTS).not.toMatch(/claim_email_send|record_email_result/);
  });
});

describe("0186 — safety: nothing structural, nothing destructive", () => {
  it("no RLS or policy change", () => {
    expect(STATEMENTS).not.toMatch(/\brow level security\b/i);
    expect(STATEMENTS).not.toMatch(/\b(create|alter|drop)\s+policy\b/i);
  });

  it("no enum change, no index, no constraint, no trigger", () => {
    expect(STATEMENTS).not.toMatch(/create\s+type|alter\s+type/i);
    expect(STATEMENTS).not.toMatch(/create\s+(unique\s+)?index/i);
    expect(STATEMENTS).not.toMatch(/add\s+constraint|\bcheck\s*\(/i);
    expect(STATEMENTS).not.toMatch(/create\s+(or\s+replace\s+)?trigger/i);
  });

  it("no destructive DDL and no row mutation", () => {
    expect(STATEMENTS).not.toMatch(/drop\s+(table|column|view|index|constraint)/i);
    expect(STATEMENTS).not.toMatch(/\btruncate\b/i);
    expect(STATEMENTS).not.toMatch(/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i);
  });

  it("its executable surface is only begin / lock_timeout / add column / comment / commit", () => {
    const statements = STATEMENTS.split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    for (const s of statements) {
      expect(s).toMatch(
        /^(begin|set local lock_timeout = ''|alter table public\.studios add column if not exists send_intake_reminders boolean not null default true|comment on column public\.studios\.send_intake_reminders is ''|commit)$/,
      );
    }
    expect(statements).toHaveLength(5);
  });
});
