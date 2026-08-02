import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

// Static (SQL-text) proof of migration 0127 — the fix for the
// client_clinical_notes author-INSERT RLS shadowing defect from 0126. The
// behavioural proof (RLS now rejects a cross-studio / other-practitioner /
// inactive-practitioner author at the policy layer) is in
// tests/db/client-clinical-notes.db.test.ts. This carries the repo migration-max
// tripwire and pins 0126 byte-for-byte so the applied migration is never edited.

const MIG_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILES = readdirSync(MIG_DIR);
const FILE = FILES.find((f) => f.startsWith("0127_"));
const SQL = FILE ? readFileSync(path.join(MIG_DIR, FILE), "utf8") : "";

// The subquery body between `from public.practitioners p` and the end of the
// EXISTS(...) — where the 0126 tautology lived. Comments stripped so the "no
// unqualified studio_id" checks test SQL, not prose.
function stripComments(s: string): string {
  return s.replace(/--.*$/gm, "");
}
const CODE = stripComments(SQL);

describe("0127 — file + repo-max tripwire", () => {
  it("is the single 0127 migration with a purpose-encoding filename", () => {
    expect(FILE).toBeTruthy();
    expect(FILE).toMatch(/^0127_fix_client_clinical_notes_author_insert_policy\.sql$/);
  });

  it("is present; the repo-max tripwire now lives in the 0131 test; 0126 + 0125 precede it", () => {
    // The absolute repo-max pin lives in the 0131 test (now 0134 =
    // practitioner-capacity foundation). Nothing above 0135 may exist yet.
    expect(FILES.some((f) => f.startsWith("0127_"))).toBe(true);
    expect(FILES.some((f) => f.startsWith("0126_"))).toBe(true);
    expect(FILES.some((f) => f.startsWith("0125_"))).toBe(true);
    const higher = FILES.filter((f) => /^01(6[6-9]|[7-9]\d)_/.test(f)); // 0155 now present (card-change dedupe); trip on 0156+
    expect(higher).toEqual([]);
  });

  it("migration 0126 remains byte-for-byte unchanged (pinned SHA-256)", () => {
    const f0126 = FILES.find((f) => f.startsWith("0126_"));
    expect(f0126).toBe("0126_client_clinical_notes.sql");
    const sha = createHash("sha256")
      .update(readFileSync(path.join(MIG_DIR, f0126 as string)))
      .digest("hex");
    expect(sha).toBe(
      "6cd91229e65f8d1e71cf40a9ca644bf483b61eedc44acba29ff6c3b6ad0c74ec",
    );
  });
});

describe("0127 — scope: only the author-INSERT policy is replaced", () => {
  it("drops then recreates exactly the author_insert policy", () => {
    expect(SQL).toMatch(
      /drop policy if exists "client_clinical_notes_author_insert" on public\.client_clinical_notes;/,
    );
    expect(SQL).toMatch(
      /create policy "client_clinical_notes_author_insert"\s*\n?\s*on public\.client_clinical_notes for insert to authenticated/,
    );
  });

  it("touches no other 0126 object (no table/index/trigger/function/other-policy/grant/backfill)", () => {
    expect(CODE).not.toMatch(/create table|drop table|alter table/i);
    expect(CODE).not.toMatch(/create index|drop index/i);
    expect(CODE).not.toMatch(/create (or replace )?function|create trigger|drop trigger/i);
    expect(CODE).not.toMatch(/member_select/i); // the SELECT policy is left intact
    expect(CODE).not.toMatch(/\bgrant\b|\brevoke\b/i);
    expect(CODE).not.toMatch(/insert into|update public\.|delete from/i); // no backfill/mutation
  });
});

describe("0127 — the corrected policy is fully qualified (no shadowing)", () => {
  it("compares practitioners.studio_id explicitly to client_clinical_notes.studio_id", () => {
    expect(CODE).toMatch(/p\.studio_id\s*=\s*client_clinical_notes\.studio_id/);
  });

  it("contains NO tautology p.studio_id = p.studio_id", () => {
    expect(CODE).not.toMatch(/p\.studio_id\s*=\s*p\.studio_id/);
  });

  it("preserves the author = caller + active + studio-member checks", () => {
    expect(CODE).toMatch(/p\.id\s*=\s*client_clinical_notes\.practitioner_id/);
    expect(CODE).toMatch(/p\.user_id\s*=\s*\(select auth\.uid\(\)\)/);
    expect(CODE).toMatch(/\bp\.active\b/);
    expect(CODE).toMatch(/public\.is_studio_member\(client_clinical_notes\.studio_id\)/);
  });

  it("has NO unqualified studio_id token anywhere in the SQL body", () => {
    // Every studio_id must be qualified by `.` (client_clinical_notes. or p.).
    expect(CODE).not.toMatch(/(?<![.\w])studio_id/);
  });
});
