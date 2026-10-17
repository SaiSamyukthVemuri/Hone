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

describe("0233: value shapes, scope key sets and the print's preview reference (HIPAA review F2/F3)", () => {
  it("dates are YYYY-MM-DD and ids are UUIDs", () => {
    expect(CODE).toContain("e.key in ('day', 'from', 'to') and e.value !~ '^\\d{4}-\\d{2}-\\d{2}$'");
    expect(CODE).toContain("e.key in ('session_id', 'preview_audit_id')");
    expect(CODE).toContain("!~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'");
  });
  it("each scope requires exactly its own keys", () => {
    expect(CODE).toMatch(/= 'day'\s+and \(not \(p_metadata \? 'day'\) or p_metadata \?\| array\['from', 'to', 'session_id'\]\)/);
    expect(CODE).toMatch(/= 'range'\s+and \(not \(p_metadata \?& array\['from', 'to'\]\) or p_metadata \?\| array\['day', 'session_id'\]\)/);
    expect(CODE).toMatch(/= 'session'\s+and \(not \(p_metadata \? 'session_id'\) or p_metadata \?\| array\['day', 'from', 'to'\]\)/);
  });
  it("dates are CALENDAR dates, checked by a cast inside an exception block (N2)", () => {
    expect(CODE).toMatch(/begin\s+perform v_text::date;\s+exception when others then\s+raise exception 'metadata % is not a calendar date', v_key using errcode = '22023';/);
  });

  it("the cited preview is of the same scope and within the token's 30 minutes (N1)", () => {
    expect(CODE).toContain("and a.metadata = (v_meta - 'preview_audit_id')");
    // ...where v_meta is the NORMALIZED scope (Codex P1 4304947291), which is
    // also what is stored, so preview and print compare like for like.
    expect(CODE).toContain("v_meta := jsonb_set(v_meta, '{session_id}', to_jsonb(lower(v_meta ->> 'session_id')));");
    expect(CODE).toContain("p_action, 'client', p_client_id, v_meta)");
    expect(CODE).toContain("and a.created_at >= now() - interval '30 minutes'");
  });

  it("a print must cite an existing preview for the SAME client, actor and studio", () => {
    expect(CODE).toContain("p_action = 'clinical_records_printed' and not (p_metadata ? 'preview_audit_id')");
    expect(CODE).toMatch(
      /a\.action = 'clinical_records_previewed'\s+and a\.entity_id = p_client_id\s+and a\.actor_id = v_actor\s+and a\.studio_id = v_studio/,
    );
  });
});

describe("the print-audit claim is worded precisely (HIPAA review F1)", () => {
  it("docs/03 and the print action never say every print is audited", () => {
    const docs = readFileSync(path.join(process.cwd(), "docs/03_SECURITY_AND_PRIVACY.md"), "utf8");
    const action = readFileSync(
      path.join(process.cwd(), "app/(records-export)/clients/[id]/records/export/actions.ts"),
      "utf8",
    );
    expect(docs).toContain("A preview is always audited before any record is read.");
    expect(docs).toContain("The Print button's print is audited.");
    expect(docs).toContain("The browser's own print (Ctrl/Cmd+P) is gated, not audited.");
    expect(action).not.toMatch(/every download is audited/i);
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
