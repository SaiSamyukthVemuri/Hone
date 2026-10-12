import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

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
const SIG = "public.record_studio_sms_sender_registration(uuid, text, text, text, text)";

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

  it("creates one table and one function, and alters, drops or writes nothing that exists", () => {
    expect([...TOP_LEVEL.matchAll(/create table (public\.\w+)/g)].map((m) => m[1])).toEqual([
      "public.studio_sms_sender_registrations",
    ]);
    expect([...CODE.matchAll(/create or replace function (public\.\w+)\(/g)].map((m) => m[1])).toEqual([
      "public.record_studio_sms_sender_registration",
    ]);
    expect(TOP_LEVEL).not.toMatch(/^\s*(drop|alter\s+(?!table public\.studio_sms_sender_registrations\b))/im);
    expect(TOP_LEVEL).not.toMatch(/^\s*(insert|update|delete)\b/im);
    expect(TOP_LEVEL).not.toMatch(/\bon\s+(table\s+)?public\.studio_sms_senders\b/i);
  });

  it("the command resolves the LIVE sender itself and never takes a sender id", () => {
    const signature = SQL.slice(SQL.indexOf("create or replace function"), SQL.indexOf(") returns table"));
    expect(signature).not.toMatch(/p_sender/);
    expect(CODE).toMatch(/where s\.studio_id = p_studio_id\s+and s\.status <> 'released'/);
    expect(CODE).toMatch(/security definer\s+set search_path = pg_catalog, pg_temp/);
  });
});

describe("privileges", () => {
  it("the table: revoked from every role by name; owner columns without the reference; service_role select only", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(TOP_LEVEL).toContain(`revoke all on table public.studio_sms_sender_registrations from ${role};`);
    }
    expect(TOP_LEVEL).toMatch(/grant select \(id, studio_id, sender_id, kind, status, missing_information, recorded_at, updated_at\)\s+on public\.studio_sms_sender_registrations to authenticated;/);
    expect(TOP_LEVEL).toContain("grant select on table public.studio_sms_sender_registrations to service_role;");
    expect(TOP_LEVEL.match(/grant [^;]*studio_sms_sender_registrations[^;]*;/g)).toHaveLength(2);
  });

  it("the owner policy is select-only and studio-owner scoped", () => {
    expect(CODE).toMatch(/for select to authenticated\s+using \(public\.is_studio_owner\(studio_sms_sender_registrations\.studio_id\)\)/);
    expect(CODE.match(/create policy/g)).toHaveLength(1);
  });

  it("the command is revoked by name and granted to service_role only", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(TOP_LEVEL).toContain(`revoke execute on function ${SIG} from ${role};`);
    }
    expect([...TOP_LEVEL.matchAll(/grant execute on function [^;]* to (\w+);/g)].map((m) => m[1])).toEqual(["service_role"]);
  });
});
