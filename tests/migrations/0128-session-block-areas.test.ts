import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Static proof of migration 0128 — session_block_areas (multi-area + per-area
// laterality). Behavioural proof (studio-derive, RLS, duplicate prevention,
// cascade, legacy fallback) is in tests/db/session-block-areas.db.test.ts.
// Carries the repo migration-max tripwire.

const MIG_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILES = readdirSync(MIG_DIR);
const FILE = FILES.find((f) => f.startsWith("0128_"));
const SQL = FILE ? readFileSync(path.join(MIG_DIR, FILE), "utf8") : "";

describe("0128 — file + repo-max tripwire", () => {
  it("is the single 0128 migration with a purpose-encoding filename", () => {
    expect(FILE).toMatch(/^0128_session_block_areas\.sql$/);
  });
  it("advances the repo migration max to 0128 (0125-0127 precede it; nothing 0129+)", () => {
    const nums = FILES.map((f) => /^(\d{4})_.*\.sql$/.exec(f))
      .filter(Boolean)
      .map((m) => (m as RegExpExecArray)[1])
      .sort();
    expect(nums[nums.length - 1]).toBe("0128");
    for (const n of ["0125", "0126", "0127"]) {
      expect(FILES.some((f) => f.startsWith(`${n}_`))).toBe(true);
    }
    expect(FILES.filter((f) => /^01(29|[3-9]\d)_/.test(f))).toEqual([]);
  });
  it("does NOT modify migrations 0125-0127", () => {
    // This migration file only creates the new child table + its own objects.
    expect(SQL).not.toMatch(/client_clinical_notes|calendar_sync|author_insert/i);
  });
});

describe("0128 — table shape + constraints", () => {
  it("creates public.session_block_areas with the reviewed columns", () => {
    expect(SQL).toMatch(/create table if not exists public\.session_block_areas/);
    for (const col of ["id", "session_block_id", "studio_id", "area", "laterality", "display_order", "created_at"]) {
      expect(SQL).toMatch(new RegExp(`\\n\\s+${col}\\b`));
    }
  });
  it("laterality is a five-value CHECK", () => {
    expect(SQL).toMatch(/laterality\s+text not null\s*\n?\s*check \(laterality in \('left', 'right', 'bilateral', 'midline', 'not_applicable'\)\)/);
  });
  it("area is non-empty + length-bounded", () => {
    expect(SQL).toMatch(/session_block_areas_area_nonempty\s*\n?\s*check \(length\(btrim\(area\)\) > 0 and length\(area\) <= 60\)/);
  });
  it("cascades from the parent session_block", () => {
    expect(SQL).toMatch(/session_block_id\s+uuid not null references public\.session_blocks \(id\) on delete cascade/);
  });
  it("prevents a duplicate (area, laterality) pair within one block", () => {
    expect(SQL).toMatch(/session_block_areas_uniq unique \(session_block_id, area, laterality\)/);
  });
  it("indexes deterministic order + studio scope", () => {
    expect(SQL).toMatch(/session_block_areas_block_order_idx[\s\S]{0,80}\(session_block_id, display_order, created_at, id\)/);
    expect(SQL).toMatch(/session_block_areas_studio_idx[\s\S]{0,60}\(studio_id\)/);
  });
});

describe("0128 — studio-derive trigger + RLS + grants", () => {
  it("derives studio_id from the parent block (anti-spoof), pinned search_path", () => {
    expect(SQL).toMatch(/function public\.session_block_areas_derive_studio\(\)/);
    expect(SQL).toMatch(/select studio_id into v_studio\s*\n?\s*from public\.session_blocks where id = new\.session_block_id/);
    expect(SQL).toMatch(/new\.studio_id := v_studio/);
    expect(SQL).toMatch(/before insert or update of session_block_id on public\.session_block_areas/);
    expect(SQL).toMatch(/set search_path = pg_catalog, pg_temp/);
  });
  it("RLS is enabled with a member-scoped ALL policy", () => {
    expect(SQL).toMatch(/alter table public\.session_block_areas enable row level security/);
    expect(SQL).toMatch(/for all to authenticated\s*\n?\s*using \(public\.is_studio_member\(studio_id\)\)\s*\n?\s*with check \(public\.is_studio_member\(studio_id\)\)/);
  });
  it("grants authenticated CRUD; revokes anon; no portal/public", () => {
    expect(SQL).toMatch(/grant select, insert, update, delete on public\.session_block_areas to authenticated/);
    expect(SQL).toMatch(/revoke all on public\.session_block_areas from anon/);
    expect(SQL).not.toMatch(/to (portal|public_booking|web_anon)/i);
  });
  it("is additive: no backfill, no legacy-column change", () => {
    expect(SQL).not.toMatch(/insert into public\.session_block_areas[\s\S]{0,120}select/i);
    expect(SQL).not.toMatch(/alter table public\.session_blocks/i);
    expect(SQL).not.toMatch(/update public\.session_blocks/i);
  });
});
