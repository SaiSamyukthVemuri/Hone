import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// HON-48 Q7 / 0271 source contract. Behaviour is proved by tests/db/schedule-signal-*.db.test.ts
// (against a real database; the policy half needs Realtime, see that file).

const FILE = "0271_schedule_change_signal.sql";
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");

describe("0271 schedule change signal: shape", () => {
  it("holds its one OPS reservation, in one transaction with a lock timeout", () => {
    expect(countVersion("0271")).toBe(1);
    expect(fileForVersion("0271")).toBe(FILE);
    expect(code.trim()).toMatch(/^begin;/);
    expect(code.trim()).toMatch(/commit;$/);
    expect(code).toContain("set local lock_timeout = '5s'");
  });

  it("changes no table, column, index or data", () => {
    expect(code).not.toMatch(/\b(?:alter|create|drop) table\b|\badd column\b|\bcreate (?:unique )?index\b|\binsert into\b|\bupdate public\.|\bdelete from\b/i);
  });

  it("both functions are security definer with a pinned search_path, and every grant is revoked by name", () => {
    expect([...code.matchAll(/security definer\s+set search_path = pg_catalog, pg_temp/g)]).toHaveLength(2);
    for (const fn of ["public.schedule_signal_send(uuid)", "public.emit_schedule_signal()"]) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(code, `${fn} ${role}`).toContain(`revoke all on function ${fn} from ${role};`);
      }
    }
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(code).toContain(`revoke all on sequence public.schedule_signal_failures_seq from ${role};`);
    }
    expect(code).not.toMatch(/\bgrant\b/i);
  });
});

describe("0271: statement-level triggers, one signal per studio per statement", () => {
  it("has 12 triggers, every one FOR EACH STATEMENT with transition tables and none per row", () => {
    const triggers = [...code.matchAll(/create trigger [\s\S]*?execute function [^;]*;/g)].map((m) => m[0]);
    expect(triggers).toHaveLength(12);
    for (const t of triggers) {
      expect(t).toContain("for each statement");
      expect(t).not.toContain("for each row");
      expect(t).toMatch(/referencing (?:new table as new_rows|old table as old_rows(?: new table as new_rows)?)/);
    }
    expect(code).not.toMatch(/for each row/);
  });

  it("insert reads new_rows, delete reads old_rows, update compares the listed columns", () => {
    expect(code).toMatch(/after insert on public\.appointments\s+referencing new table as new_rows/);
    expect(code).toMatch(/after delete on public\.appointments\s+referencing old table as old_rows/);
    expect(code).toMatch(/after update on public\.appointments\s+referencing old table as old_rows new table as new_rows/);
    expect(code).toContain("select distinct studio_id from new_rows");
    expect(code).toContain("select distinct studio_id from old_rows");
    expect(code).toMatch(/is distinct from/);
  });

  it("does not list arrived_at (0268 is held); bookkeeping columns are never listed", () => {
    expect(code).not.toContain("arrived_at");
    expect(code).not.toContain("checked_in_at");
    expect(code).not.toMatch(/'[a-z_0-9]*(?:_sent_at|_send_attempts|_claimed_at|sync_version|updated_at)'/);
  });
});

describe("0271: the payload and the failure path", () => {
  it("sends an empty payload on the per-studio topic with private => true spelled out, and nothing else", () => {
    const sends = [...code.matchAll(/perform realtime\.send\(([\s\S]*?)\);/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("payload => '{}'::pg_catalog.jsonb");
    expect(sends[0]).toContain("event => 'changed'");
    expect(sends[0]).toContain("topic => 'schedule:' || p_studio::pg_catalog.text");
    // Explicit and named: a public channel on the same topic name must never receive it.
    expect(sends[0]).toMatch(/private => true$/);
    expect(code).not.toMatch(/private => false/);
  });

  it("fails open with a counted warning, and returns quietly when send() does not exist", () => {
    expect(code).toMatch(/exception when others then[\s\S]*?nextval\('public\.schedule_signal_failures_seq'\)[\s\S]*?raise warning/);
    // Even the failure report is wrapped, so reporting can never fail the write either.
    expect(code).toMatch(/exception when others then\s+begin[\s\S]*?nextval[\s\S]*?exception when others then\s+null;\s+end;/);
    // The only raise exception is the owner-can-insert precheck, inside the handled block.
    expect([...code.matchAll(/raise exception/gi)]).toHaveLength(1);
    expect(code).toMatch(/has_table_privilege\('realtime\.messages', 'insert'\)[\s\S]*?rolbypassrls[\s\S]*?raise exception[\s\S]*?perform realtime\.send/);
    expect(code).toContain("to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null");
  });
});

describe("0271: who may listen", () => {
  it("is guarded for a stack without Realtime: NOTICE and skip, never an error", () => {
    expect(code).toContain("to_regclass('realtime.messages') is null");
    expect(code).toContain("to_regprocedure('realtime.topic()') is null");
    expect([...code.matchAll(/raise notice/g)].length).toBeGreaterThanOrEqual(2);
  });

  it("creates a SELECT-only permissive policy for authenticated, gated by topic shape and membership", () => {
    expect([...code.matchAll(/create policy/g)]).toHaveLength(2);
    expect(code).toContain("create policy schedule_signal_member_read");
    expect(code).toContain("for select");
    expect(code).toContain("to authenticated");
    expect(code).toContain("realtime.messages.extension = 'broadcast'");
    expect(code).toContain("'^schedule:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'");
    expect(code).toContain("public.is_studio_member(substr((select realtime.topic()), 10)::uuid)");
    expect(code).toMatch(/else false/);
    // The only other policy is the RESTRICTIVE client-insert deny, pinned below.
    expect(code).not.toMatch(/for (?:update|delete|all)\b/);
    expect(code).not.toMatch(/to (?:public|service_role)/);
  });

  it("adds a RESTRICTIVE insert deny for anon and authenticated (defence in depth), and never DROPs a policy", () => {
    expect(code).toMatch(
      /create policy schedule_signal_no_client_insert\s+on realtime\.messages\s+as restrictive\s+for insert\s+to anon, authenticated\s+with check \(false\)/,
    );
    // A plain CREATE only: DROP POLICY on realtime.messages is not provably allowed for the migration role.
    expect(code).not.toMatch(/drop\s+policy/i);
  });

  it("touches realtime only through two plain create policy statements: no owner change, no grant, no role switch, no non-SELECT policy", () => {
    // The policy is created by the migration role through Supabase's supported path for
    // realtime.messages (supautils policy_grants), not by taking ownership of the table.
    expect(code.match(/create policy/gi) ?? []).toHaveLength(2);
    expect(code).toMatch(/create policy schedule_signal_member_read\s+on realtime\.messages\s+for select\s+to authenticated/);
    expect(code).not.toMatch(/(?:disable|force)\s+row\s+level\s+security/i);
    expect(code).not.toMatch(/alter\s+(?:table|function|schema)\s+realtime\b/i);
    expect(code).not.toMatch(/\bowner\s+to\b/i);
    expect(code).not.toMatch(/\bgrant\b[^;]*realtime/i);
    expect(code).not.toMatch(/\bset\s+(?:local\s+|session\s+)?role\b|\bset\s+session\s+authorization\b/i);
    expect(code).not.toMatch(/\balter\s+policy\b/i);
  });
});
