import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion } from "./helpers/migration-state";

// 0339: services and consent_form_templates writes are owner-only (HON-44 gaps H1, H2). STATIC contract only.
// Behaviour is proved against a real database in tests/db/owner-only-catalog-writes.db.test.ts.

const root = join(__dirname, "..", "..");
const NAME = "0339_owner_only_services_and_consent_template_writes";
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const E = exec(readFileSync(join(root, `supabase/migrations/${NAME}.sql`), "utf8"));
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

describe("0339: shape", () => {
  it("consumes exactly one number", () => {
    expect(countVersion("0339")).toBe(1);
  });

  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(E.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(E.trim().endsWith("commit;")).toBe(true);
  });

  it("creates exactly four policies, all owner-only, and nothing else", () => {
    expect(creates(E).length).toBe(4);
    expect(E).not.toMatch(/\b(grant|revoke)\b/);
    expect(E).not.toMatch(/create (or replace )?function|alter table|comment on|\b(insert into|update public|delete from)\b/);
    expect(E).not.toMatch(/for (delete|all|select) /);
    expect(E).not.toMatch(/drop policy if exists "[a-z_]*select"/);
  });

  it.each(TABLES)("%s: drops both member write policies and creates the two owner policies", (table, mIns, mUpd, oIns, oUpd) => {
    expect(E).toContain(`drop policy if exists "${mIns}" on public.${table};`);
    expect(E).toContain(`drop policy if exists "${mUpd}" on public.${table};`);
    const mine = creates(E).filter((p) => p.includes(` on public.${table} `));
    expect(mine.length).toBe(2);
    for (const p of mine) {
      expect(p).toMatch(/ for (insert|update) to authenticated/);
      expect(p).toContain("public.is_studio_owner(studio_id)");
      expect(p).not.toContain("is_studio_member");
    }
    expect(mine.find((p) => p.includes(`"${oIns}"`))).toMatch(/for insert to authenticated\s+with check \(public\.is_studio_owner\(studio_id\)\);/);
    // UPDATE checks ownership of the existing row (USING) and of the resulting row (WITH CHECK).
    expect(mine.find((p) => p.includes(`"${oUpd}"`))).toMatch(
      /for update to authenticated\s+using \(public\.is_studio_owner\(studio_id\)\)\s+with check \(public\.is_studio_owner\(studio_id\)\);/,
    );
  });

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
