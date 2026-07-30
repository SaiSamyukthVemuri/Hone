import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Migration 0160 — a treatment record belongs to ONE client and ONE encounter.
//
// Closes same-studio wrong-client / wrong-record re-parenting: RLS correctly refuses
// a cross-STUDIO move, but within a studio the member policies are
// `using (is_studio_member(studio_id)) with check (is_studio_member(studio_id))` and
// that predicate still holds after the parent changes, so a raw PostgREST PATCH
// could move a session onto another client's chart. Depends on 0159.
//
// Carries the repo migration-max tripwire (moved here from the 0159 test).

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0160_")) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");
const CODE = SQL.split("\n")
  .filter((l) => !/^\s*--/.test(l))
  .join("\n");
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, "\n<<body elided>>\n");

function fn(name: string): string {
  const start = CODE.indexOf(`create or replace function public.${name}(`);
  expect(start, `public.${name} is defined`).toBeGreaterThan(-1);
  const open = CODE.indexOf("$$", start);
  return CODE.slice(start, CODE.indexOf("$$", open + 2) + 2);
}

describe("0160 — immutable clinical lineage (repo migration-max tripwire)", () => {
  it("is present, 0159 precedes it, exactly one 0160, and it is the repo max", () => {
    expect(FILE).toMatch(/^0160_.*\.sql$/);
    const files = readdirSync(MIG_DIR);
    expect(files.some((f) => f.startsWith("0159_"))).toBe(true);
    expect(files.filter((f) => /^0160_/.test(f))).toHaveLength(1);
    expect(files.filter((f) => /^01(6[1-9]|[7-9]\d)_/.test(f))).toEqual([]);
    const nums = files
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .map((f) => parseInt(f.slice(0, 4), 10))
      .sort((a, b) => a - b);
    expect(nums[nums.length - 1]).toBe(160);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it("states its dependency on 0159 explicitly", () => {
    expect(SQL).toMatch(/DEPENDS ON: migration 0159/i);
  });
});

describe("0160 — the guards", () => {
  it("the strict guard compares OLD vs NEW only, and needs no elevated rights", () => {
    const body = fn("guard_immutable_clinical_lineage");
    expect(body).toMatch(/security invoker/);
    expect(body).toMatch(/set search_path = ''/);
    expect(body).toMatch(/v_old is distinct from v_new/);
    // Driven by TG_ARGV so each table names its own immutable columns.
    expect(body).toMatch(/foreach v_col in array tg_argv/);
    // It reads no table — the less authority a guard holds, the less to abuse.
    expect(body).not.toMatch(/\bfrom public\./);
  });

  it("the CLEARABLE guard exists and tolerates a transition to NULL", () => {
    // electrolysis_entries(session_id, block_id) -> session_blocks is ON DELETE SET
    // NULL (block_id). A blunt guard would reject that cascade and make block
    // deletion impossible — the trap 0093 already navigated for treatment_images.
    const body = fn("guard_clearable_clinical_lineage");
    expect(body).toMatch(/v_old is distinct from v_new and v_new is not null/);
    expect(SQL).toMatch(/ON DELETE SET NULL/);
    expect(SQL).toMatch(/0093/);
  });

  it("pins exactly the lineage columns, per table, on UPDATE only", () => {
    const expected: Array<[string, string, string[]]> = [
      ["sessions_immutable_lineage", "sessions", ["client_id", "studio_id"]],
      ["session_blocks_immutable_lineage", "session_blocks", ["session_id", "studio_id"]],
      ["electrolysis_entries_immutable_lineage", "electrolysis_entries", ["session_id"]],
      ["laser_entries_immutable_lineage", "laser_entries", ["session_id"]],
    ];
    for (const [trg, tbl, cols] of expected) {
      expect(CODE, trg).toMatch(new RegExp(`drop trigger if exists ${trg} on public\\.${tbl};`));
      expect(CODE, trg).toMatch(
        new RegExp(
          `create trigger ${trg}\\s+before update of ${cols.join(", ")} on public\\.${tbl}\\s+for each row execute function public\\.guard_immutable_clinical_lineage\\(${cols
            .map((c) => `'${c}'`)
            .join(", ")}\\);`,
        ),
      );
      // UPDATE only: INSERT is where lineage is legitimately established.
      expect(CODE, trg).not.toMatch(new RegExp(`create trigger ${trg}\\s+before insert`));
    }
    expect(CODE).toMatch(
      /create trigger electrolysis_entries_clearable_lineage\s+before update of block_id on public\.electrolysis_entries\s+for each row execute function public\.guard_clearable_clinical_lineage\('block_id'\);/,
    );
  });

  it("deliberately does NOT re-guard treatment_images — 0093 already does it, better", () => {
    expect(CODE).not.toMatch(/create trigger treatment_images_immutable_lineage/);
    expect(CODE).not.toMatch(/on public\.treatment_images/);
    expect(SQL).toMatch(/treatment_images_enforce_integrity/);
    expect(SQL).toMatch(/DELIBERATELY NOT COVERED HERE/);
  });
});

describe("0160 — it does not re-freeze ordinary charting", () => {
  it("pins no clinical-content column anywhere", () => {
    // The whole point of the product decision is that treatment records stay
    // editable. Only lineage is immutable — never a clinical value.
    for (const col of [
      "session_notes",
      "next_session_note",
      "energy_level",
      "minutes_performed",
      "hairs_treated",
      "observation_chips",
      "primary_area",
      "laterality",
      "numbing_status",
      "record_status",
      "deleted_at",
      "practitioner_id",
      "started_at",
      "price_paid_cents",
    ]) {
      expect(CODE, col).not.toMatch(new RegExp(`'${col}'`));
    }
  });

  it("adds nothing from the retired signed-record system", () => {
    for (const gone of [
      "clinical_record_snapshots",
      "build_session_snapshot",
      "finalize_session",
      "correct_finalized_session",
      "content_hash",
      "snapshot",
    ]) {
      expect(CODE, gone).not.toMatch(new RegExp(gone, "i"));
    }
    // Word-bounded: "re-assigned" legitimately contains the letters of "signed".
    expect(CODE).not.toMatch(/\bsigned\b/i);
  });

  it("touches no grant, no policy and no RLS posture", () => {
    expect(CODE).not.toMatch(/\bgrant\b/i);
    expect(CODE).not.toMatch(/\brevoke\b/i);
    expect(CODE).not.toMatch(/\bcreate policy\b/i);
    expect(CODE).not.toMatch(/\brow level security\b/i);
  });
});

describe("0160 — ZERO data operations, nothing destructive", () => {
  it("runs no DML at apply time and drops nothing it must keep", () => {
    expect(TOP_LEVEL).not.toMatch(/\binsert into\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bupdate public\./i);
    expect(TOP_LEVEL).not.toMatch(/\bdelete from\b/i);
    expect(TOP_LEVEL).not.toMatch(/\btruncate\b/i);
    expect(CODE).not.toMatch(/\bdrop (table|column|function|index)\b/i);
    expect(CODE).not.toMatch(/\balter table\b/i);
    expect(CODE).not.toMatch(/\bbackfill\b/i);
  });

  it("bounds the apply and explains the correct remedy for a mis-filed record", () => {
    expect(CODE).toMatch(/^set local lock_timeout = '5s';$/m);
    // The guard pushes people toward soft-delete + re-chart, which keeps an
    // attributable trail instead of silently rewriting history in place. Say so in
    // the error the practitioner would actually see.
    expect(fn("guard_immutable_clinical_lineage")).toMatch(/File it on the correct client instead/);
    expect(SQL).toMatch(/soft-delet/i);
  });

  it("records that it needs no application change, and why", () => {
    expect(SQL).toMatch(/NEEDS NO APPLICATION CHANGE/i);
    expect(SQL).toMatch(/26/); // the verified call-site count
    expect(SQL).toMatch(/INSERT only/i);
  });
});
