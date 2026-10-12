import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";
import { TOLL_FREE_AREA_CODES } from "@/lib/sms/nanp";

// Migration 0217 — SMS-SENDER-REG-01 (#824): US registration evidence for a
// studio sender. SOURCE CONTRACT. Behaviour is proved in
// tests/db/studio-sms-sender-registrations.db.test.ts; this pins what that
// cannot see: frozen neighbours, no existing object altered, no rows written,
// privileges revoked by name, one command, service_role only.

const VERSION = "0217";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIGRATIONS, f), "utf8");
const SQL = read("0217_studio_sms_sender_registrations.sql");
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");
const SIG = "public.record_studio_sms_sender_registration(uuid, uuid, text, text, text, text)";

describe("0217 in the sequence", () => {
  it("is the repository maximum on this branch, allocated once", () => {
    expect(isRepoMax(VERSION)).toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
    expect(countVersion(VERSION)).toBe(1);
  });

  it("leaves the applied migrations it relies on byte-identical", () => {
    const sha = (f: string) => createHash("sha256").update(read(f), "utf8").digest("hex");
    expect(sha("0210_sms_waitlist_join_acknowledgement.sql")).toBe(
      "b1d33743235644447da41a17778e890c05c14deda6c299303cc5febdceea7157",
    );
  });
});

describe("blast radius", () => {
  it("one transaction with a lock timeout", () => {
    expect(TOP_LEVEL.trim()).toMatch(/^begin;\s+set local lock_timeout = '5s';/);
    expect(TOP_LEVEL.trim()).toMatch(/commit;$/);
  });

  it("creates one table and two functions, and alters, drops or writes nothing that exists", () => {
    expect([...TOP_LEVEL.matchAll(/create table (public\.\w+)/g)].map((m) => m[1])).toEqual([
      "public.studio_sms_sender_registrations",
    ]);
    expect([...CODE.matchAll(/create or replace function (public\.\w+)\(/g)].map((m) => m[1])).toEqual([
      "public.record_studio_sms_sender_registration",
      "public.get_live_studio_sms_sender_registration_state",
    ]);
    expect(TOP_LEVEL).not.toMatch(/^\s*(drop|alter\s+(?!table public\.studio_sms_sender_registrations\b))/im);
    expect(TOP_LEVEL).not.toMatch(/^\s*(insert|update|delete)\b/im);
    expect(TOP_LEVEL).not.toMatch(/\bon\s+(table\s+)?public\.studio_sms_senders\b/i);
  });

  it("the command writes to the LIVE sender it resolves; the expected id is only ever compared", () => {
    const body = CODE.slice(CODE.indexOf("create or replace function public.record_studio_sms_sender_registration("));
    const fn = body.slice(0, body.indexOf("$$;", body.indexOf("as $$") + 5));
    // The row written is v_live[1], resolved here; p_expected_sender_id appears
    // only in the null check and the comparison.
    expect(fn).toMatch(/values\s+\(p_studio_id, v_live\[1\], v_phones\[1\], v_kind/);
    expect(fn.match(/p_expected_sender_id/g)).toHaveLength(3);
    expect(CODE).toMatch(/where s\.studio_id = p_studio_id\s+and s\.status <> 'released'\s+for share/);
    expect(CODE).toMatch(/security definer\s+set search_path = pg_catalog, pg_temp/);
  });
});

describe("privileges", () => {
  it("the table: revoked from every role by name; owner columns without the reference; service_role select only", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(TOP_LEVEL).toContain(`revoke all on table public.studio_sms_sender_registrations from ${role};`);
    }
    expect(TOP_LEVEL).toMatch(/grant select \(id, studio_id, sender_id, phone_number, kind, status, missing_information, recorded_at, updated_at\)\s+on public\.studio_sms_sender_registrations to authenticated;/);
    expect(TOP_LEVEL).toContain("grant select on table public.studio_sms_sender_registrations to service_role;");
    expect(TOP_LEVEL.match(/grant [^;]*\bon (table )?public\.studio_sms_sender_registrations\b[^;]*;/g)).toHaveLength(2);
  });

  it("the owner policy is select-only and studio-owner scoped", () => {
    expect(CODE).toMatch(/for select to authenticated\s+using \(public\.is_studio_owner\(studio_sms_sender_registrations\.studio_id\)\)/);
    expect(CODE.match(/create policy/g)).toHaveLength(1);
  });

  it("both functions are revoked by name and granted to service_role only", () => {
    for (const sig of [SIG, "public.get_live_studio_sms_sender_registration_state(uuid)"]) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(TOP_LEVEL).toContain(`revoke execute on function ${sig} from ${role};`);
      }
    }
    expect([...TOP_LEVEL.matchAll(/grant execute on function [^;]* to (\w+);/g)].map((m) => m[1])).toEqual(["service_role", "service_role"]);
  });

  it("the operator's snapshot is one statement over the LIVE sender(s) and exactly their rows", () => {
    expect(CODE).toMatch(/with live as \(\s+select s\.id, s\.studio_id, s\.status, s\.phone_number, s\.messaging_service_sid, s\.created_at\s+from public\.studio_sms_senders s\s+where s\.studio_id = p_studio_id\s+and s\.status <> 'released'/);
    // ... and only the evidence for the number each sender holds NOW.
    expect(CODE).toMatch(/join live l on l\.id = r\.sender_id and l\.phone_number = r\.phone_number/);
  });

  it("the writer is compare-and-set on the expected sender, with the sender row locked", () => {
    expect(CODE).toMatch(/for share\) l;/);
    expect(CODE).toMatch(/if v_live\[1\] <> p_expected_sender_id then\s+return query select 'sender_changed'/);
  });

  it("evidence is bound to the number (Codex P2 4244484021): no number refuses, a different number is a changed sender", () => {
    expect(CODE).toMatch(/if v_phones\[1\] is null then\s+return query select 'sender_has_no_number'/);
    expect(CODE).toMatch(/if v_phones\[1\] <> p_expected_phone then\s+return query select 'sender_changed'/);
    expect(CODE).toMatch(/phone_number\s+text\s+not null,/);
    expect(CODE).toMatch(/unique \(sender_id, phone_number, kind\)/);
  });

  it("the kind is derived from the number, never taken from the caller (Codex P2 4244484022)", () => {
    expect(CODE).not.toMatch(/p_kind/);
    // The toll-free prefixes in SQL (the table check and the command) are exactly lib/sms/nanp.ts's.
    const lists = [...CODE.matchAll(/'\^\\\+1\(([0-9|]+)\)'/g)].map((m) => m[1].split("|").sort());
    expect(lists).toHaveLength(2);
    for (const l of lists) expect(l).toEqual([...TOLL_FREE_AREA_CODES].sort());
  });
});
