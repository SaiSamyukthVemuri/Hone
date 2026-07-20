import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Static proof of migration 0130 — revoke the residual anon EXECUTE grant on the
// two multi-area charting RPCs created by 0129 (least-privilege hardening).
// Behavioural proof (anon denied, authenticated allowed, cross-studio denied,
// bodies/search_path unchanged) is in tests/db/session-block-areas.db.test.ts.
// Carries the repo migration-max tripwire.

const MIG_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILES = readdirSync(MIG_DIR);
const FILE = FILES.find((f) => f.startsWith("0130_"));
const SQL = FILE ? readFileSync(path.join(MIG_DIR, FILE), "utf8") : "";
// Executable SQL only (strip `--` comment lines) — the header comment legitimately
// mentions words like "search_path"/"GRANT" while explaining the fix.
const STATEMENTS = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

// The reviewed, byte-for-byte SHA of migration 0129 — 0130 must not touch it.
const EXPECTED_0129_SHA =
  "5ae4a4ea6037f49ed8f6bedb0291e950f1f94f9f99e9482b5077687b3f0c2334";

describe("0130 — file + repo-max tripwire", () => {
  it("is the single 0130 migration (revoke anon EXECUTE on the charting RPCs)", () => {
    expect(FILE).toMatch(/^0130_revoke_anon_calendar_charting_rpc_execute\.sql$/);
  });

  it("is present; the repo-max tripwire now lives in the 0131 test (0126-0129 precede)", () => {
    // The absolute repo-max pin lives in the 0131 test (now 0134 =
    // practitioner-capacity foundation). 0130 is present; nothing above 0134
    // may exist yet.
    expect(FILES.some((f) => f.startsWith("0130_"))).toBe(true);
    for (const n of ["0126", "0127", "0128", "0129"]) {
      expect(FILES.some((f) => f.startsWith(`${n}_`))).toBe(true);
    }
    expect(FILES.filter((f) => /^01(3[5-9]|[4-9]\d)_/.test(f))).toEqual([]);
  });

  it("migration 0129 is byte-for-byte unchanged", () => {
    const f = FILES.find((x) => x.startsWith("0129_"));
    const sha = createHash("sha256")
      .update(readFileSync(path.join(MIG_DIR, f as string)))
      .digest("hex");
    expect(sha).toBe(EXPECTED_0129_SHA);
  });
});

describe("0130 — narrowly scoped: revoke anon EXECUTE only", () => {
  it("revokes EXECUTE from anon on BOTH exact function signatures", () => {
    expect(SQL).toMatch(
      /revoke execute\s*\n?\s*on function public\.create_session_block_with_areas\(uuid, uuid, jsonb, jsonb\)\s*\n?\s*from anon;/,
    );
    expect(SQL).toMatch(
      /revoke execute\s*\n?\s*on function public\.update_session_block_with_areas\([\s\S]*?uuid,[\s\S]*?jsonb,[\s\S]*?timestamptz\s*\n?\s*\)\s*\n?\s*from anon;/,
    );
    // Exactly two revokes (create + update); no third statement of substance.
    expect((SQL.match(/revoke execute/g) ?? []).length).toBe(2);
    expect((SQL.match(/from anon;/g) ?? []).length).toBe(2);
  });

  it("does NOT broaden any grant — no GRANT, no PUBLIC/anon grant (executable SQL)", () => {
    expect(STATEMENTS).not.toMatch(/\bgrant\b/i);
    expect(STATEMENTS).not.toMatch(/to anon/i);
    expect(STATEMENTS).not.toMatch(/to public/i);
  });

  it("touches no function body, table, RLS, trigger, constraint or data (executable SQL)", () => {
    expect(STATEMENTS).not.toMatch(/create or replace function/i);
    expect(STATEMENTS).not.toMatch(/alter function/i);
    expect(STATEMENTS).not.toMatch(/create table|alter table|drop table/i);
    expect(STATEMENTS).not.toMatch(/create policy|alter policy|drop policy/i);
    expect(STATEMENTS).not.toMatch(/create trigger|drop trigger/i);
    expect(STATEMENTS).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b|\btruncate\b/i);
    expect(STATEMENTS).not.toMatch(/security definer|search_path/i);
    // Executable SQL never references the areas table (only the two functions).
    expect(STATEMENTS).not.toMatch(/session_block_areas/i);
  });

  it("documents the root cause + non-exploitability + intended final posture", () => {
    expect(SQL).toMatch(/default privileges/i);
    expect(SQL).toMatch(/is_studio_member/i);
    expect(SQL).toMatch(/least-privilege|least privilege/i);
  });
});
