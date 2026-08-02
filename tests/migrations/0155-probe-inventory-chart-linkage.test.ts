import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0155_")) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");

describe("0155 — probe inventory chart linkage (additive, same-studio FK, no backfill)", () => {
  it("is present, 0154 precedes it, nothing 0156+ yet", () => {
    expect(FILE).toMatch(/^0155_.*\.sql$/);
    const files = readdirSync(MIG_DIR);
    expect(files.some((f) => f.startsWith("0154_"))).toBe(true);
    expect(files.filter((f) => /^01(6[6-9]|[7-9]\d)_/.test(f))).toEqual([]);
  });

  it("A. adds a NULLABLE probe_key to record_keeping_sterile_items with a length CHECK (no NOT NULL, no default, no backfill)", () => {
    expect(SQL).toMatch(
      /alter table public\.record_keeping_sterile_items\s+add column if not exists probe_key text\s*;/,
    );
    expect(SQL).toMatch(
      /check \(probe_key is null or char_length\(probe_key\) <= \d+\)/,
    );
    expect(SQL).not.toMatch(/probe_key text[^;]*not null/i);
    expect(SQL).not.toMatch(/set default/i);
  });

  it("B1. adds the composite UNIQUE (studio_id, id) FK target on the inventory table", () => {
    expect(SQL).toMatch(
      /add constraint record_keeping_sterile_items_studio_id_uniq unique \(studio_id, id\)/,
    );
  });

  it("B2. adds a NULLABLE probe_inventory_item_id uuid to session_blocks (no default, no NOT NULL)", () => {
    expect(SQL).toMatch(
      /alter table public\.session_blocks\s+add column if not exists probe_inventory_item_id uuid\s*;/,
    );
    expect(SQL).not.toMatch(/probe_inventory_item_id uuid[^;]*not null/i);
  });

  it("B3. adds the same-studio composite FK with ON DELETE SET NULL (never CASCADE)", () => {
    const fk = SQL.slice(
      SQL.indexOf("session_blocks_probe_inventory_same_studio_fk"),
    );
    expect(SQL).toMatch(
      /foreign key \(studio_id, probe_inventory_item_id\)\s+references public\.record_keeping_sterile_items \(studio_id, id\)/,
    );
    expect(SQL).toMatch(/on delete set null \(probe_inventory_item_id\)/);
    // The clinical charting row must NEVER be cascade-deleted by an inventory change.
    expect(fk.slice(0, 400)).not.toMatch(/on delete cascade/i);
  });

  it("C. teaches BOTH 0129 RPCs the new column (create or replace, same signatures)", () => {
    expect(SQL).toMatch(/create or replace function public\.create_session_block_with_areas/);
    expect(SQL).toMatch(/create or replace function public\.update_session_block_with_areas/);
    // probe_inventory_item_id appears in both the INSERT column list and the UPDATE SET.
    expect(SQL).toMatch(/probe_lot_confirmed, probe_inventory_item_id,/); // insert list
    expect(SQL).toMatch(/probe_inventory_item_id = r\.probe_inventory_item_id/); // update set
    // Signatures unchanged: studio_id/session_id still sourced from parameters.
    expect(SQL).toMatch(/p_studio_id, p_session_id, v_sort, r\.block_name/);
  });

  it("performs NO backfill and rewrites NO existing rows", () => {
    expect(SQL).not.toMatch(/update public\.record_keeping_sterile_items\s+set/i);
    expect(SQL).not.toMatch(/update public\.session_blocks\s+set (?!.*from p_block)/i);
    expect(SQL).not.toMatch(/set probe_key =/i);
    expect(SQL).not.toMatch(/set probe_inventory_item_id = \(/i);
    expect(SQL).not.toMatch(/insert into public\.record_keeping_sterile_items/i);
  });

  it("does NOT weaken RLS or touch policies", () => {
    expect(SQL).not.toMatch(/create policy|drop policy|alter policy/i);
    expect(SQL).not.toMatch(/disable row level security/i);
    expect(SQL).not.toMatch(/for delete/i);
  });

  it("keeps the dormant probe_lots / electrolysis_entries.probe_lot_id boundary — never touched in DDL", () => {
    // The header comment names them to document the boundary; the executable
    // SQL must never reference them.
    const code = SQL.split("\n")
      .filter((l) => !/^\s*--/.test(l))
      .join("\n");
    expect(code).not.toMatch(/probe_lots/);
    expect(code).not.toMatch(/probe_lot_id/);
  });

  it("(#24) touches NO payment / appointment / booking / consent / messaging surface", () => {
    const code = SQL.split("\n")
      .filter((l) => !/^\s*--/.test(l))
      .join("\n");
    for (const forbidden of [
      /stripe/i,
      /payment/i,
      /\bcharge/i,
      /appointment/i,
      /\bbooking/i,
      /reservation/i,
      /\bconsent/i,
      /\bemail/i,
      /\bsms\b/i,
      /twilio/i,
      /auth\.users/i,
    ]) {
      expect(code).not.toMatch(forbidden);
    }
    // Only the two intended tables + their atomic RPCs are altered.
    expect(SQL).toMatch(/alter table public\.record_keeping_sterile_items/i);
    expect(SQL).toMatch(/alter table public\.session_blocks/i);
  });
});

// Rollout contract guard: this change is MIGRATION-FIRST (DB-first). The app
// reads/writes probe_key + probe_inventory_item_id, so the migration must
// precede the app deploy. This guard FAILS if the rollout documentation (the
// migration header or the runbook) ever again claims app-first / deploy-first
// is safe, or that the code is "inert until the migration".
describe("0155 rollout contract is documented as MIGRATION-FIRST (no app-first claim)", () => {
  const ROLLOUT = readFileSync(
    join(process.cwd(), "docs/runbooks/0155-probe-inventory-linkage-rollout.md"),
    "utf8",
  );
  // Affirmative "app-first is safe" style claims. Written NOT to match the
  // required NEGATIONS ("app-first is NOT safe"): the "safe" alternatives allow
  // an optional intensifier adverb but never "not"/"never", so a negated claim
  // never matches. The self-check test below proves both directions.
  const FORBIDDEN = [
    /app[-\s]?first\s+(deployment\s+)?(is\s+)?(perfectly\s+|totally\s+|completely\s+|entirely\s+|absolutely\s+)?safe/i,
    /app[-\s]?first\s+(is\s+)?fine/i,
    /app[-\s]?first\s+poses\s+no\s+risk/i,
    /deploy[-\s]?first\s+(is\s+)?safe/i,
    /safe\s+to\s+(deploy|ship|merge|release)\s+(the\s+)?app(lication)?\s+(first|before)/i,
    /inert\s+until\s+(the\s+)?migration/i,
  ];
  const matchesForbidden = (text: string) => FORBIDDEN.some((re) => re.test(text));

  for (const [label, text] of [
    ["rollout runbook", ROLLOUT],
    ["migration header", SQL],
  ] as const) {
    it(`${label} never claims app-first / deploy-first is safe`, () => {
      for (const bad of FORBIDDEN) expect(text).not.toMatch(bad);
    });
  }

  it("the forbidden-claim guard actually catches affirmatives AND spares the required negation (not tautological)", () => {
    // Affirmative app-first-safe claims MUST be caught.
    for (const affirmative of [
      "Deploying app-first is safe.",
      "app first is perfectly safe",
      "app-first deployment is safe",
      "app-first poses no risk",
      "deploy-first is safe",
      "It is safe to ship the app before the migration.",
      "The code is inert until the migration is applied.",
    ]) {
      expect(matchesForbidden(affirmative)).toBe(true);
    }
    // The required NEGATIONS (and the actual doc text) MUST be spared.
    for (const negation of [
      "App-first is NOT safe.",
      "app-first is NOT\nsafe for this change.",
      "## Why DB-first (NOT app-first)",
      "DB-first IS safe: the RPCs accept old payloads.",
    ]) {
      expect(matchesForbidden(negation)).toBe(false);
    }
  });

  it("the runbook states the DB-first order explicitly (migration before merge)", () => {
    expect(ROLLOUT).toMatch(/MIGRATION-FIRST|DB-first/i);
    expect(ROLLOUT).toMatch(/app-first is NOT\s+safe/i);
    // The migration is applied BEFORE the application PR merges.
    expect(ROLLOUT).toMatch(/apply migration 0155\s+to production BEFORE merging/i);
    // And it must NOT be applied as part of merging the app PR.
    expect(ROLLOUT).toMatch(/do not apply 0155 to production or any remote/i);
  });

  it("the migration header documents the DB-first requirement", () => {
    expect(SQL).toMatch(/MIGRATION-FIRST \(DB-first\)/i);
    expect(SQL).toMatch(/app-first is NOT safe/i);
  });
});
