import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  countVersion,
  isRepoMax,
  migrationState,
  versionsAbove,
} from "./helpers/migration-state";

// 0182 — structured sterile-item discard lifecycle. STATIC contract.
//
// Behaviour is proved against a real database in
// tests/db/sterile-item-discard-lifecycle.db.test.ts (and the current-warning
// filter in tests/db/expiring-sterile-items.db.test.ts). This file pins what a
// behavioural test cannot see: that the migration adds ONE nullable date column
// and NOTHING else — no backfill, no destructive statement, no RLS change, and
// above all no attempt to infer a discard from free text.

const ROOT = join(__dirname, "..", "..");
const FILE = "supabase/migrations/0182_sterile_item_discard_lifecycle.sql";
const SQL = readFileSync(join(ROOT, FILE), "utf8");

// EXECUTABLE SQL ONLY — line comments stripped. The header legitimately
// discusses notes, backfills and deletion in order to state that it does none
// of them, so raw-text negatives would fail on the very prose documenting the
// decision.
const EXEC = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

// EXEC minus the COMMENT ON string literals. `comment on column ... is '...'`
// IS executable SQL, but its payload is documentation, and that documentation
// necessarily uses the words the negatives below forbid ("notes", "discarded")
// in order to state what the migration must never do. Assertions about SQL
// LOGIC run against this; assertions about the documentation run against SQL.
const LOGIC = EXEC.replace(/comment on [\s\S]*?';/gi, "");

describe("0182 — migration state", () => {
  it("is the current repository maximum and consumes exactly one number", () => {
    expect(isRepoMax("0182")).toBe(true);
    expect(versionsAbove("0182")).toEqual([]);
    expect(countVersion("0182")).toBe(1);
  });

  it("never reintroduces 0158, which is permanently skipped", () => {
    expect(countVersion("0158")).toBe(0);
  });

  it("is NOT yet applied to production — hosted state is declared, not derived", () => {
    // A file on disk says nothing about what production has applied. 0182 is
    // repo-only until an authorized apply updates the canonical record.
    const state = migrationState();
    expect(state.hosted_migration_max).toBe("0181");
    expect(state.pending_migrations).toEqual(["0182"]);
    expect(state.repo_equals_hosted).toBe(false);
  });
});

describe("0182 — transaction envelope", () => {
  it("opens its own transaction and arms lock_timeout INSIDE it", () => {
    // `supabase db push` does not wrap a file in a transaction, so a bare
    // SET LOCAL outside one emits 25P01 and never arms.
    const lines = SQL.split("\n").map((l) => l.trim()).filter(Boolean);
    const begin = lines.findIndex((l) => l === "begin;");
    const lock = lines.findIndex((l) => l.startsWith("set local lock_timeout"));
    const commit = lines.findIndex((l) => l === "commit;");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(lock);
  });
});

describe("0182 — the column", () => {
  it("adds date_discarded as a NULLABLE date, idempotently", () => {
    expect(EXEC).toMatch(
      /alter table public\.record_keeping_sterile_items\s+add column if not exists date_discarded date;/,
    );
  });

  it("mirrors the record_keeping_disinfectants precedent: no default, no check", () => {
    // The sibling column (0085) is `date_discarded date` — nullable, no
    // default, no constraint. Two logbooks, one concept, one dialect.
    expect(EXEC).not.toMatch(/date_discarded[^;]*default/i);
    expect(EXEC).not.toMatch(/date_discarded[^;]*not null/i);
    expect(EXEC).not.toMatch(/check\s*\(/i);
  });

  it("documents the semantics on the column itself", () => {
    expect(SQL).toMatch(
      /comment on column public\.record_keeping_sterile_items\.date_discarded is/,
    );
  });

  it("includes a preflight note", () => {
    expect(SQL).toMatch(/PREFLIGHT/);
  });
});

describe("0182 — changes NOTHING else", () => {
  it("touches only record_keeping_sterile_items", () => {
    const alters = EXEC.match(/alter table\s+public\.[a-z_]+/gi) ?? [];
    expect(alters.length).toBeGreaterThan(0);
    for (const a of alters) {
      expect(a.toLowerCase()).toBe(
        "alter table public.record_keeping_sterile_items",
      );
    }
  });

  it("performs NO backfill and NO row mutation — a discard is never inferred", () => {
    // The single most important negative in this file. Deriving date_discarded
    // from `notes` is precisely the failure mode the structured column exists to
    // replace: it would read "do not discard" and "discarded the OTHER box" as
    // compliance assertions. Every existing row must arrive as NULL.
    expect(LOGIC).not.toMatch(/\bupdate\s+public\./i);
    expect(LOGIC).not.toMatch(/\binsert\s+into\b/i);
    expect(LOGIC).not.toMatch(/\bnotes\b/i);
    expect(LOGIC).not.toMatch(/\bilike\b/i);
    expect(LOGIC).not.toMatch(/\blike\b/i);
    expect(LOGIC).not.toMatch(/set\s+date_discarded/i);
  });

  it("the column comment states the semantics AND the no-inference rule", () => {
    // The documentation half of the pair above: the rule is recorded in the
    // database itself, where the next person to read the schema will find it.
    const comment = EXEC.match(/comment on [\s\S]*?';/i)?.[0] ?? "";
    expect(comment).toMatch(/NULL = no structured discard recorded/i);
    expect(comment).toMatch(/never inferred from notes/i);
    expect(comment).toMatch(
      /current inventory is not historical record existence/i,
    );
  });

  it("introduces NO destructive statement", () => {
    // These are health-inspection logbook records; 0085 deliberately ships no
    // DELETE policy and no delete affordance. Discard is a lifecycle field, and
    // must never become a deletion.
    expect(LOGIC).not.toMatch(/\bdelete\s+from\b/i);
    expect(EXEC).not.toMatch(/\bdrop\s+table\b/i);
    expect(EXEC).not.toMatch(/\bdrop\s+column\b/i);
    expect(EXEC).not.toMatch(/\btruncate\b/i);
  });

  it("changes NO RLS, grant, policy or trigger", () => {
    // The 0085 policies already scope every command by is_studio_member at the
    // ROW level, so a new column inherits tenancy exactly. The 0086 audit
    // trigger is column-generic, so it covers date_discarded without edit.
    expect(EXEC).not.toMatch(/create policy|drop policy|alter policy/i);
    expect(EXEC).not.toMatch(/row level security/i);
    expect(EXEC).not.toMatch(/^\s*grant /im);
    expect(EXEC).not.toMatch(/^\s*revoke /im);
    expect(EXEC).not.toMatch(/create trigger|drop trigger/i);
    expect(EXEC).not.toMatch(/create (or replace )?function/i);
  });

  it("creates no index and no foreign key", () => {
    // Per-studio logbook reads are already studio-indexed and hard-capped; an
    // unused index is write cost for no read benefit. Historical FKs (0155
    // probe_inventory_item_id, 0179 actor) must be left exactly as they are.
    expect(EXEC).not.toMatch(/create index|create unique index/i);
    expect(EXEC).not.toMatch(/references\s+public\./i);
    expect(EXEC).not.toMatch(/add constraint/i);
  });

  it("adds no view or RPC — there is no SQL-side consumer to update", () => {
    expect(EXEC).not.toMatch(/create (or replace )?view/i);
  });
});
