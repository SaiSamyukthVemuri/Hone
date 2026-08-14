import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #190 (clinical memory moat). Migration 0082 adds structured
// client-response columns to session_blocks and next_session_note to
// sessions. These tests pin the additive, backwards-compatible shape:
// everything nullable or defaulted, CHECK-constrained vocabularies,
// no RLS or policy change, no destructive statement.

const MIGRATION = readFileSync(
  path.resolve(__dirname, "../../supabase/migrations/0082_clinical_memory.sql"),
  "utf8",
);

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
}
const SQL = codeOnly(MIGRATION);

describe("0082: session_blocks response columns", () => {
  it("adds the five response columns idempotently", () => {
    expect(SQL).toMatch(/add column if not exists tolerance_rating smallint/);
    expect(SQL).toMatch(/add column if not exists reaction_type text/);
    expect(SQL).toMatch(/add column if not exists reaction_notes text/);
    expect(SQL).toMatch(
      /add column if not exists caution_for_next_session boolean not null default false/,
    );
    expect(SQL).toMatch(/add column if not exists caution_note text/);
  });

  it("tolerance_rating CHECK allows null or 1..5", () => {
    expect(SQL).toMatch(
      /add constraint session_blocks_tolerance_rating_check\s*\n?\s*check \(tolerance_rating is null or tolerance_rating between 1 and 5\)/,
    );
  });

  it("reaction_type CHECK allows null or the seven-value vocabulary", () => {
    const block = SQL.slice(
      SQL.indexOf("session_blocks_reaction_type_check"),
      SQL.indexOf("comment on column public.session_blocks.tolerance_rating"),
    );
    expect(block).toMatch(/reaction_type is null/);
    for (const v of [
      "'none'",
      "'mild_redness'",
      "'moderate_redness'",
      "'swelling'",
      "'sensitivity'",
      "'irritation'",
      "'other'",
    ]) {
      expect(block).toContain(v);
    }
  });

  it("CHECKs are DROP+ADD so the migration is re-runnable", () => {
    expect(SQL).toMatch(
      /drop constraint if exists session_blocks_tolerance_rating_check/,
    );
    expect(SQL).toMatch(
      /drop constraint if exists session_blocks_reaction_type_check/,
    );
  });
});

describe("0082: sessions.next_session_note", () => {
  it("adds the nullable note column idempotently", () => {
    expect(SQL).toMatch(
      /alter table public\.sessions\s*\n?\s*add column if not exists next_session_note text;/,
    );
  });
});

describe("0082: safety posture", () => {
  it("changes only session_blocks and sessions", () => {
    const altered = SQL.match(/alter table public\.(\w+)/g) ?? [];
    const tables = new Set(altered.map((a) => a.replace("alter table public.", "")));
    expect([...tables].sort()).toEqual(["session_blocks", "sessions"]);
  });

  it("no RLS, policy, or grant change", () => {
    expect(SQL).not.toMatch(/policy|row level security|grant|revoke/i);
  });

  it("no destructive statement (old rows preserved)", () => {
    expect(SQL).not.toMatch(/drop table|drop column|delete from|truncate|update /i);
  });

  it("no payment / Stripe surface", () => {
    expect(SQL).not.toMatch(/stripe|payment_charge|manual_fee/i);
  });

  it("reaction vocabulary matches lib/sessions/clinical-response.ts", () => {
    const lib = readFileSync(
      path.resolve(__dirname, "../../lib/sessions/clinical-response.ts"),
      "utf8",
    );
    // Charting unification added REACTION_CHIP_LABELS / NOTABLE_REACTION_LABELS to
    // this module, so a whole-file scan for quoted snake_case tokens now also picks
    // up NOTABLE_REACTION_LABELS' members. Scope the extraction to the canonical
    // REACTION_TYPES enum array, the SINGLE source the 0082 CHECK mirrors, so we
    // still verify exactly those 7 values map into the migration's constraint.
    const enumBlock = lib.slice(
      lib.indexOf("export const REACTION_TYPES = ["),
      lib.indexOf("] as const;"),
    );
    const libValues = [...enumBlock.matchAll(/^\s+"([a-z_]+)",$/gm)].map(
      (m) => m[1],
    );
    for (const v of libValues) {
      expect(SQL).toContain(`'${v}'`);
    }
    // The migration enum is UNCHANGED: still exactly these 7 canonical values.
    expect(libValues).toEqual([
      "none",
      "mild_redness",
      "moderate_redness",
      "swelling",
      "sensitivity",
      "irritation",
      "other",
    ]);
    expect(libValues.length).toBe(7);
  });
});
