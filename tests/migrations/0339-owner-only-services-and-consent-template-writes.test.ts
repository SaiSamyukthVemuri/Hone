import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 0339: services and consent_form_templates writes are owner-only. Rollback file and application-writer census.
// Behaviour is proved against a real database in tests/db/owner-only-catalog-writes.db.test.ts.

const root = join(__dirname, "..", "..");
const NAME = "0339_owner_only_services_and_consent_template_writes";
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const DOWN = exec(readFileSync(join(root, `supabase/rollbacks/${NAME}.down.sql`), "utf8"));
const creates = (sql: string) => sql.match(/create policy[^;]+;/g) ?? [];

// [table, member insert, member update, owner insert, owner update]
const TABLES = [
  ["services", "services_member_insert", "services_member_update", "services_owner_insert", "services_owner_update"],
  [
    "consent_form_templates",
    "consent_form_templates_studio_member_insert",
    "consent_form_templates_studio_member_update",
    "consent_form_templates_studio_owner_insert",
    "consent_form_templates_studio_owner_update",
  ],
] as const;

describe("0339: rollback", () => {
  it.each(TABLES)("%s: the down restores the two original member policies", (table, mIns, mUpd, oIns, oUpd) => {
    const mine = creates(DOWN).filter((p) => p.includes(` on public.${table} `));
    expect(mine.length).toBe(2);
    expect(mine.find((p) => p.includes(`"${mIns}"`))).toMatch(/for insert to authenticated\s+with check \(public\.is_studio_member\(studio_id\)\);/);
    expect(mine.find((p) => p.includes(`"${mUpd}"`))).toMatch(
      /for update to authenticated\s+using \(public\.is_studio_member\(studio_id\)\)\s+with check \(public\.is_studio_member\(studio_id\)\);/,
    );
    expect(DOWN).toContain(`drop policy if exists "${oIns}" on public.${table};`);
    expect(DOWN).toContain(`drop policy if exists "${oUpd}" on public.${table};`);
  });

  it("the down creates exactly four policies and touches nothing else", () => {
    expect(creates(DOWN).length).toBe(4);
    expect(DOWN).not.toMatch(/\b(grant|revoke)\b|create (or replace )?function|alter table|\b(insert into|update public|delete from)\b/);
  });
});

describe("0339: every application writer of the two tables is already owner-gated", () => {
  // The policy change must not take anything from a path the app offers a non-owner today.
  const writersOf = (table: string) => {
    const out = execSync(`grep -rlE 'from\\("${table}"\\)' app lib || true`, { cwd: root, encoding: "utf8" });
    return out.split("\n").filter(Boolean).filter((f) => {
      const src = readFileSync(join(root, f), "utf8");
      return new RegExp(`from\\("${table}"\\)[\\s\\S]{0,120}?\\.(insert|update|upsert|delete)\\(`).test(src);
    });
  };
  const exported = (file: string) => readFileSync(join(root, file), "utf8").split(/\nexport async function /).slice(1);

  it("services: one writer file, and every exported action calls assertOwner before it opens a Supabase client", () => {
    expect(writersOf("services")).toEqual(["app/(app)/settings/services/actions.ts"]);
    const bodies = exported("app/(app)/settings/services/actions.ts");
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      const name = b.slice(0, b.indexOf("("));
      const gate = b.indexOf("await assertOwner()");
      expect(gate, name).toBeGreaterThan(-1);
      expect(b.indexOf("createClient("), name).toBeGreaterThan(gate);
    }
  });

  it("consent_form_templates: one writer file, and every exported action checks role and active before the service-role client", () => {
    expect(writersOf("consent_form_templates")).toEqual(["app/(app)/settings/consent/actions.ts"]);
    const bodies = exported("app/(app)/settings/consent/actions.ts");
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      const name = b.slice(0, b.indexOf("("));
      const gate = b.indexOf(`practitioner.role !== "owner" || !practitioner.active`);
      expect(gate, name).toBeGreaterThan(-1);
      expect(b.indexOf("createAdminClient("), name).toBeGreaterThan(gate);
    }
  });
});
