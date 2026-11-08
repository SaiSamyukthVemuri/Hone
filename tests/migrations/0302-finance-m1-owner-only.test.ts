import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion, isRepoMax } from "./helpers/migration-state";

// 0302, finance DB closure M1. STATIC contract. Behaviour (who can read / write what) is
// proved with real JWTs in tests/db/finance-m1-owner-only.db.test.ts; this file pins what a
// behavioural test cannot see: the migration changes ONLY the three named policies and one
// table comment, restates no privilege, defines no function, writes no row, and that the held
// rollback restores the old policies and the old comment byte for byte.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIG_PATH = "supabase/migrations/0302_finance_m1_owner_only_cards_and_service_writes.sql";
const DOWN_PATH = "supabase/rollbacks/0302_finance_m1_owner_only_cards_and_service_writes.down.sql";
const M0058 = read("supabase/migrations/0058_client_payment_methods.sql");
const M0173 = read("supabase/migrations/0173_appointment_repair_commands.sql");
const MIG = read(MIG_PATH);
const DOWN = read(DOWN_PATH);

const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

describe("0302 migration state", () => {
  it("is the repository maximum and consumes exactly one number", () => {
    expect(isRepoMax("0302")).toBe(true);
    expect(countVersion("0302")).toBe(1);
  });

  it("is byte-identical to the file applied to production (sealed sha256)", () => {
    // 0302 was applied on 2026-11-07 from the sealed file; an applied migration is frozen.
    const sha = createHash("sha256").update(readFileSync(join(ROOT, MIG_PATH))).digest("hex");
    expect(sha).toBe("2db0c9704b7bf1b5bc5a78dbc2d33788bef04700040d3e4dccbe0e4228d706ad");
  });

  it("its rollback is not in the migrations directory", () => {
    expect(existsSync(join(ROOT, DOWN_PATH))).toBe(true);
    expect(MIG_PATH.startsWith("supabase/migrations/")).toBe(true);
    expect(DOWN_PATH.startsWith("supabase/rollbacks/")).toBe(true);
  });
});

describe("0302 shape", () => {
  const body = exec(MIG);

  it("opens its own transaction and arms lock_timeout inside it", () => {
    const begin = body.indexOf("begin;");
    const lock = body.indexOf("set local lock_timeout = '5s';");
    const commit = body.lastIndexOf("commit;");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(lock);
  });

  it("creates exactly the three owner-only policies, each gated by is_studio_owner, and none by is_studio_member", () => {
    const creates = [...body.matchAll(/create policy "([^"]+)"\s+on public\.(\w+) for (\w+) to authenticated/g)].map((m) => [m[1], m[2], m[3]]);
    expect(creates).toEqual([
      ["client_payment_methods_owner_select", "client_payment_methods", "select"],
      ["services_owner_insert", "services", "insert"],
      ["services_owner_update", "services", "update"],
    ]);
    expect(body).not.toMatch(/is_studio_member/);
    expect([...body.matchAll(/is_studio_owner\(studio_id\)/g)]).toHaveLength(4); // select, insert check, update using + check
  });

  it("drops exactly the three member policies it replaces (plus its own names, idempotently)", () => {
    const drops = [...body.matchAll(/drop policy if exists "([^"]+)" on public\.(\w+);/g)].map((m) => m[1]).sort();
    expect(drops).toEqual(
      [
        "client_payment_methods_owner_select",
        "client_payment_methods_studio_member_select",
        "services_member_insert",
        "services_member_update",
        "services_owner_insert",
        "services_owner_update",
      ].sort(),
    );
  });

  it("does not touch services select, a grant, a function, a column, a trigger, a table or a row", () => {
    expect(body).not.toMatch(/services_member_select/);
    expect(body).not.toMatch(/\b(grant|revoke|create\s+(or\s+replace\s+)?function|alter\s+table|alter\s+policy|create\s+table|drop\s+table|insert\s+into|update\s+public|delete\s+from|truncate|create\s+trigger)\b/i);
  });

  it("changes exactly one table comment, and it no longer says members can read", () => {
    const comments = [...body.matchAll(/comment on (\w+) ([\w.]+) is/g)].map((m) => [m[1], m[2]]);
    expect(comments).toEqual([["table", "public.client_payment_methods"]]);
    expect(body).toContain("SELECT is owner-only (is_studio_owner) since 0302");
    expect(body).not.toContain("studio-member SELECT only");
  });

  it("the policies it removes are the ones the chain created (0058 select, 0173 insert and update)", () => {
    expect(norm(M0058)).toContain(norm(`create policy "client_payment_methods_studio_member_select" on public.client_payment_methods for select to authenticated using (public.is_studio_member(studio_id));`));
    expect(norm(M0173)).toContain(norm(`create policy "services_member_insert" on public.services for insert to authenticated with check (public.is_studio_member(studio_id));`));
    expect(norm(M0173)).toContain(
      norm(`create policy "services_member_update" on public.services for update to authenticated using (public.is_studio_member(studio_id)) with check (public.is_studio_member(studio_id));`),
    );
  });
});

describe("0302 held rollback", () => {
  const down = exec(DOWN);

  it("restores the three old policies with the old predicates and drops the owner ones", () => {
    expect(norm(down)).toContain(
      norm(`create policy "client_payment_methods_studio_member_select" on public.client_payment_methods for select to authenticated using (public.is_studio_member(studio_id));`),
    );
    expect(norm(down)).toContain(
      norm(`create policy "services_member_insert" on public.services for insert to authenticated with check (public.is_studio_member(studio_id));`),
    );
    expect(norm(down)).toContain(
      norm(`create policy "services_member_update" on public.services for update to authenticated using (public.is_studio_member(studio_id)) with check (public.is_studio_member(studio_id));`),
    );
    for (const n of ["client_payment_methods_owner_select", "services_owner_insert", "services_owner_update"]) {
      expect(down).toContain(`drop policy if exists "${n}"`);
      expect(down).not.toContain(`create policy "${n}"`);
    }
  });

  it("restores 0058's table comment byte for byte", () => {
    const original = M0058.match(/comment on table public\.client_payment_methods is\s*\n\s*('.*?');/s);
    expect(original).not.toBeNull();
    expect(DOWN).toContain(original![1]);
  });

  it("is a transaction with lock_timeout and carries no privilege or data statement", () => {
    expect(down).toMatch(/begin;[\s\S]*set local lock_timeout = '5s';[\s\S]*commit;/);
    expect(down).not.toMatch(/\b(grant|revoke|insert\s+into|alter\s+table|create\s+function)\b/i);
  });
});
