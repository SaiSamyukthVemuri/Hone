import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// 0233 — HON-46: the clinical-records audit is ACTOR-BOUND (Codex P1
// 4304545551). Source contract; the behaviour is proven against a real
// database in tests/db/clinical-records-audit-command.db.test.ts.

const VERSION = "0233";
const FILE = path.join(process.cwd(), "supabase/migrations/0233_clinical_records_audit_command.sql");
const SQL = readFileSync(FILE, "utf8");
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");

describe("0233 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this — see
    // CLAUDE.md §2. It reached this file from 0211's test.
    expect(isRepoMax(VERSION), "0233 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION), "something was added above 0233").toEqual([]);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });
});

describe("0233 is recorded as PENDING, consistently (Codex P2 4304674129)", () => {
  it("the ledger's current block lists 0233 under Pending migrations, never 'none'", () => {
    const ledger = readFileSync(path.join(process.cwd(), "docs/production/migration-ledger.md"), "utf8");
    const current = ledger.slice(ledger.indexOf("## Current state"));
    const row = current.match(/\|\s*\*\*Pending migrations\*\*\s*\|([^\n]*)\|/);
    expect(row, "the current block has no Pending migrations row").toBeTruthy();
    expect(row?.[1]).toContain("`0233`");
    expect(row?.[1]).toMatch(/PENDING, NOT APPLIED/);
    expect(row?.[1]).not.toMatch(/\*\*none\*\*/);
  });
});

describe("0233 is one bounded transaction", () => {
  it("opens its own transaction and arms lock_timeout INSIDE it", () => {
    expect(CODE).toMatch(/^\s*begin;/m);
    expect(CODE).toMatch(/set local lock_timeout = '5s';/);
    expect(CODE.indexOf("begin;")).toBeLessThan(CODE.indexOf("set local lock_timeout"));
    expect(CODE.trimEnd()).toMatch(/commit;$/);
  });
});

describe("0233: the command derives studio and actor, and allow-lists what it writes", () => {
  it("is SECURITY DEFINER with a pinned search_path, and refuses a null auth.uid()", () => {
    expect(CODE).toMatch(/function public\.record_clinical_records_audit\([\s\S]*?security definer\s+set search_path = pg_catalog, pg_temp/);
    expect(CODE).toMatch(/if v_uid is null then\s+raise exception 'not authenticated' using errcode = '42501';/);
  });
  it("takes the studio from the CLIENT and the actor from auth.uid() as the active owner", () => {
    expect(CODE).toContain("select c.studio_id into v_studio from public.clients c where c.id = p_client_id;");
    expect(CODE).toMatch(/and p\.user_id = v_uid\s+and p\.active = true\s+and p\.role = 'owner';/);
    // Neither is a parameter.
    expect(CODE).not.toMatch(/p_studio_id|p_actor_id/);
  });
  it("allow-lists the two actions and the metadata keys", () => {
    expect(CODE).toContain("p_action not in ('clinical_records_previewed', 'clinical_records_printed')");
    expect(CODE).toContain("v_key not in ('scope', 'day', 'from', 'to', 'session_id', 'preview_audit_id')");
  });
});

describe("0233: direct member inserts are narrowed", () => {
  it("replaces the 0001 policy: own actor only, never clinical_records_*", () => {
    expect(CODE).toContain('drop policy if exists "audit_logs: members insert" on public.audit_logs;');
    expect(CODE).toMatch(
      /create policy "audit_logs: members insert" on public\.audit_logs\s+for insert to authenticated\s+with check \(\s*public\.is_studio_member\(studio_id\)\s+and public\.audit_actor_is_caller\(actor_id, studio_id\)\s+and action not like 'clinical_records\\_%'\s*\);/,
    );
  });
});

describe("0233: EXECUTE is revoked from every default-granted role by name", () => {
  for (const sig of [
    "public.record_clinical_records_audit(uuid, text, jsonb, uuid)",
    "public.audit_actor_is_caller(uuid, uuid)",
  ]) {
    it(sig, () => {
      for (const role of ["public", "anon", "service_role"]) {
        expect(CODE, `${sig} from ${role}`).toContain(`revoke execute on function ${sig} from ${role};`);
      }
      expect(CODE).toContain(`grant execute on function ${sig} to authenticated;`);
    });
  }
});
