import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  countVersion,
  fileForVersion,
  isRepoMax,
  migrationState,
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
  it("is the current repository maximum, exactly once, with nothing above it", () => {
    expect(isRepoMax(VERSION)).toBe(true);
    expect(countVersion(VERSION)).toBe(1);
    expect(versionsAbove(VERSION)).toEqual([]);
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

// ===========================================================================
// CURRENT HOSTED STATE — 0186 OWNS IT NOW
// ===========================================================================
//
// Inherited from 0185's file at the apply hand-off. Whichever migration is the
// applied head owns these facts; a superseded migration's file must not keep
// deciding them, or it has to be rewritten on every future apply.
//
// Deliberately small. This block records WHAT PRODUCTION HAS RUN and nothing
// else: it does not police the wording of the record's prose, and it makes no
// claim about email, SMS or cron, none of which is needed to establish hosted
// migration state.

function canonicalRecord(): {
  hosted_migration_max: string;
  /** NULLABLE — null right now, because 0186's apply date/time was not captured. */
  hosted_applied_at: string | null;
  hosted_applied_at_precision: string;
  hosted_note: string;
} {
  return JSON.parse(
    readFileSync(path.join(ROOT, "docs/production/migration-state.json"), "utf8"),
  );
}

describe("0186 — current hosted state", () => {
  it("is the APPLIED production head, with nothing pending", () => {
    const state = migrationState();
    expect(state.hosted_migration_max).toBe(VERSION);
    expect(state.repo_migration_max).toBe(VERSION);
    expect(state.repo_equals_hosted).toBe(true);
    expect(state.pending_migrations).toEqual([]);
    expect(state.next_free_migration).toBe("0187");
  });

  it("the apply date/time was NOT CAPTURED, and is represented truthfully", () => {
    // Null, not the nearest plausible date. The verification date is a separate
    // fact and an upper bound; it is never the apply date.
    const rec = canonicalRecord();
    expect(rec.hosted_applied_at).toBeNull();
    expect(migrationState().hosted_applied_at).toBeNull();
    expect(rec.hosted_applied_at_precision).toBe(
      "The exact apply date/time for 0186 was not captured. " +
        "0186 was verified applied on 2026-08-24.",
    );
  });

  it("the canonical record is 0186's, and carries its production checksum", () => {
    const rec = canonicalRecord();
    expect(rec.hosted_migration_max).toBe(VERSION);
    const digest = createHash("sha256").update(SQL, "utf8").digest("hex");
    expect(digest).toBe(
      "4041b38653198976233e5bf1ea41b68b349a587ed2c1fa43c251d9c6c629e66e",
    );
    expect(rec.hosted_note).toContain(digest);
    expect(rec.hosted_note).toContain(`${FILE} APPLIED to production`);
  });

  it("carries the earlier apply records forward, unedited", () => {
    // A new head must not truncate the chain. The 0185, 0184 and 0183 records
    // and their frozen checksums stay exactly where they were.
    const note = canonicalRecord().hosted_note;
    for (const [label, sha] of [
      ["0185", "663a5d826d4c9e610c3bf7ec599dea577772ba521326488add77153f39a14ffc"],
      ["0184", "aa110edadd459e0f11062e3904ea7ad54a54a75c31d9342b762a533ecc07694c"],
      ["0183", "a7b8926832747319024d7c89213688b68fb363d09e88317e3bba6dbb17c6fbeb"],
      ["0171", "f4e8535093721c6fb9c677925a3e4a8f202e3f2ad56b6d6208da608f5d2a62e6"],
    ] as const) {
      expect(note, `the carried chain lost its ${label} checksum`).toContain(sha);
    }
    expect(note).toContain(
      "SUPERSEDES the 0185 record as the CURRENT hosted-state record",
    );
  });
});
