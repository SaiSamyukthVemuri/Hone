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
// ===========================================================================
// 0186 — APPLIED, AND THE HOSTED MAXIMUM HAS MOVED ON
// ===========================================================================
//
// This file briefly owned the CURRENT hosted-state block, inherited from 0185
// at the previous hand-off and built to be handed on in turn: whichever
// migration is the applied head owns those facts, or a superseded migration's
// file has to be rewritten on every future apply.
//
// 0187 was applied on 2026-08-24, so that ownership moved to
// tests/migrations/0187-appointment-settlement.test.ts — together with the
// carried-chain digest, the exactly-one-current-record law and both negative
// controls, which now guard the 0187 head and the 0186 record it carries.
//
// What stays here is 0186's OWN permanent evidence, which no later apply can
// change.

function canonicalRecord(): {
  hosted_migration_max: string;
  hosted_applied_at: string | null;
  hosted_applied_at_precision: string;
  hosted_note: string;
} {
  return JSON.parse(
    readFileSync(path.join(ROOT, "docs/production/migration-state.json"), "utf8"),
  );
}

/** 0186's own record, as it read while 0186 was the head. */
const OWN_RECORD_OPENING = "0186_intake_reminder_24h_2h.sql APPLIED to production";

describe("0186 — applied, and handed the hosted maximum over", () => {
  it("IS applied to production, and is no longer the head", () => {
    // The two facts that stay true forever: 0186 ran, so it must never appear
    // as pending again; and the head has moved past it.
    const state = migrationState();
    expect(state.pending_migrations).not.toContain(VERSION);
    expect(Number(state.hosted_migration_max)).toBeGreaterThan(186);
  });

  it("carries 0186's production checksum, matching the file on disk", () => {
    const digest = createHash("sha256").update(SQL, "utf8").digest("hex");
    expect(digest).toBe(
      "4041b38653198976233e5bf1ea41b68b349a587ed2c1fa43c251d9c6c629e66e",
    );
    expect(canonicalRecord().hosted_note).toContain(digest);
  });

  it("0186's OWN 'apply date/time NOT CAPTURED' fact survives verbatim", () => {
    // THE ONE THING A LATER APPLY COULD QUIETLY LAUNDER. 0186's apply instant
    // was never captured, and that absence is itself the evidence. Now that the
    // top-level `hosted_applied_at` / `hosted_applied_at_precision` fields
    // describe 0187's apply, 0186's own precision statement lives ONLY inside
    // the carried note — so it is asserted from the note, never from the live
    // fields, which would silently start checking somebody else's apply.
    const note = canonicalRecord().hosted_note;
    expect(note).toContain(OWN_RECORD_OPENING);
    expect(note).toContain("THE EXACT APPLY DATE/TIME WAS NOT CAPTURED");
    expect(note).toContain("0186 was VERIFIED APPLIED on 2026-08-24");
    expect(note).toContain(
      "SUPERSEDES the 0185 record as the CURRENT hosted-state record",
    );
  });

  it("0186's record sits BELOW the head, not at it", () => {
    // Stated by ordering alone, so this file needs no second definition of
    // where the head record stops.
    const note = canonicalRecord().hosted_note;
    expect(note.indexOf(OWN_RECORD_OPENING)).toBeGreaterThan(0);
  });

  it("THE CURRENT-RECORD CLAIM IS NO LONGER 0186'S, by construction", () => {
    // Proof the retirement is real rather than an excuse to stop checking.
    const rec = canonicalRecord();
    expect(Number(rec.hosted_migration_max)).toBeGreaterThan(186);
    expect(rec.hosted_migration_max).not.toBe(VERSION);
    // 0186's precision sentence is no longer the live one; it has become
    // history inside the note.
    expect(rec.hosted_applied_at_precision).not.toBe(
      "The exact apply date/time for 0186 was not captured. " +
        "0186 was verified applied on 2026-08-24.",
    );
  });
});
