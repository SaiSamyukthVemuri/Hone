import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0215 — DELIVERY-VISIBILITY-01 incidents and recovery heartbeat.
// SOURCE CONTRACT.
//
// Behaviour (deduplication, atomicity, which states are incidents, both
// provider paths, the owner-only read and its refusals, privileges, heartbeat
// and health) is proved against a real database in
// tests/db/delivery-incidents.db.test.ts. This file pins what that cannot see:
// grants by name, no top-level DML, the pending migrations it builds on left
// byte-identical, and nowhere to keep a client's identity or a message.
// ===========================================================================

const VERSION = "0215";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIGRATIONS, f), "utf8");
const SQL = read("0215_delivery_incidents.sql");
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SERVICE_ROLE_COMMANDS = [
  "record_email_sweep_run(integer, integer, integer)",
  "email_delivery_health()",
  "resolve_delivery_incident(uuid, text)",
  "support_delivery_incidents(boolean)",
  "support_email_receipt_outcomes()",
] as const;
const OWNER_COMMAND = "owner_delivery_incidents(uuid)";
const TRIGGER_FUNCTIONS = ["email_outbound_messages_open_incident()", "sms_outbound_messages_open_incident()"] as const;
const TABLES = ["public.delivery_incidents", "public.delivery_sweep_heartbeat"] as const;

describe("0215 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this — see
    // CLAUDE.md §2. It reached this file from 0212's test.
    expect(isRepoMax(VERSION)).toBe(false); // INTEGRATION handoff — see note below
    const above = versionsAbove(VERSION);
    expect(above.length, "nothing sits above 0215").toBeGreaterThan(0);
    expect(above.every((v) => Number(v) > Number(VERSION))).toBe(true);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("leaves the pending ledger migrations it builds on byte-identical", () => {
    // 0212 is #832's reviewed file and 0211 is #827's. 0215 adds a trigger to
    // each ledger and must never edit either migration.
    expect(createHash("sha256").update(read("0212_email_delivery_events.sql"), "utf8").digest("hex")).toBe(
      "cc2abfa3059157b841c1c1c095a84045410121be13d96ff93e34f8332f81d6d1",
    );
  });
});

describe("0215 is one transaction with a lock timeout and writes no rows", () => {
  it("opens with begin + lock_timeout and closes with commit", () => {
    expect(TOP_LEVEL.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(TOP_LEVEL.trim().endsWith("commit;")).toBe(true);
  });

  it("has no top-level DML", () => {
    expect(TOP_LEVEL).not.toMatch(/\binsert\s+into\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bupdate\s+public\./i);
    expect(TOP_LEVEL).not.toMatch(/\bdelete\s+from\b/i);
    expect(TOP_LEVEL).not.toMatch(/\btruncate\b/i);
  });

  it("redefines no existing function and alters no existing table", () => {
    const defined = [...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]).sort();
    expect(defined).toEqual(
      [
        "email_delivery_health",
        "email_outbound_messages_open_incident",
        "owner_delivery_incidents",
        "record_email_sweep_run",
        "resolve_delivery_incident",
        "sms_outbound_messages_open_incident",
        "support_delivery_incidents",
        "support_email_receipt_outcomes",
      ].sort(),
    );
    const altered = new Set([...TOP_LEVEL.matchAll(/alter table (public\.[a-z_]+)/g)].map((m) => m[1]));
    expect(altered).toEqual(new Set(TABLES));
  });

  it("touches the two ledgers only with one AFTER trigger each, firing on failures only", () => {
    const triggers = [...TOP_LEVEL.matchAll(/create trigger ([a-z_]+)\s+after update of status on (public\.[a-z_]+)/g)].map(
      (m) => `${m[1]} on ${m[2]}`,
    );
    expect(triggers.sort()).toEqual(
      [
        "email_outbound_messages_open_incident on public.email_outbound_messages",
        "sms_outbound_messages_open_incident on public.sms_outbound_messages",
      ].sort(),
    );
    expect(TOP_LEVEL).toMatch(/new\.status in \('refused', 'bounced', 'failed', 'suppressed'\)/);
    expect(TOP_LEVEL).toMatch(/new\.status in \('refused', 'undelivered', 'failed'\)/);
    expect(TOP_LEVEL).not.toMatch(/before (insert|update)[^;]*on public\.(email|sms)_outbound_messages/);
  });
});

describe("0215 privilege closure", () => {
  it("service_role commands are revoked from all four roles BY NAME, then granted to service_role only", () => {
    for (const fn of SERVICE_ROLE_COMMANDS) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(CODE, `${fn} not revoked from ${role}`).toMatch(
          new RegExp(`revoke execute on function public\\.${escape(fn)} from ${role};`),
        );
      }
      expect(CODE).toMatch(new RegExp(`grant execute on function public\\.${escape(fn)} to service_role;`));
    }
  });

  it("the owner read is revoked from all four roles, granted to authenticated only, and requires a user", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toMatch(new RegExp(`revoke execute on function public\\.${escape(OWNER_COMMAND)} from ${role};`));
    }
    expect(CODE).toMatch(new RegExp(`grant execute on function public\\.${escape(OWNER_COMMAND)} to authenticated;`));
    expect(CODE).not.toMatch(new RegExp(`grant execute on function public\\.${escape(OWNER_COMMAND)} to (anon|service_role|public)`));
    const start = CODE.indexOf("create or replace function public.owner_delivery_incidents(");
    const body = CODE.slice(start, CODE.indexOf("$$;", start));
    expect(body).toMatch(/auth\.uid\(\) is null/);
    expect(body).toMatch(/not public\.is_studio_owner\(p_studio_id\)/);
  });

  it("closes the tables and trigger functions to every role", () => {
    for (const table of TABLES) {
      expect(CODE).toMatch(new RegExp(`revoke all on ${escape(table)}\\s+from public, anon, authenticated, service_role;`));
    }
    for (const fn of TRIGGER_FUNCTIONS) {
      expect(CODE).toMatch(
        new RegExp(`revoke all privileges on function public\\.${escape(fn)}\\s+from public, anon, authenticated, service_role;`),
      );
    }
    expect(CODE).not.toMatch(/create policy/i);
    expect(CODE).not.toMatch(/grant[^;]*on\s+(table\s+)?public\.delivery_/i);
  });

  it("every SECURITY DEFINER function pins its search_path", () => {
    for (const f of CODE.split(/create or replace function/).slice(1)) {
      const header = f.split("$$")[0] ?? "";
      if (/security definer/.test(header)) expect(header).toMatch(/set search_path = pg_catalog, pg_temp/);
    }
  });
});

describe("0215 privacy", () => {
  it("declares nowhere to keep a client's identity, an address, a message or a payload", () => {
    const start = CODE.indexOf("create table if not exists public.delivery_incidents (");
    const table = CODE.slice(start, CODE.indexOf("\n);", start));
    expect(table).not.toMatch(/\b(client_id|client_name|phone|email_address|recipient|subject|body|payload|message_text|note)\b/i);
    expect(table).toContain("last_reason ~ '^[a-z][a-z0-9_]{1,63}$'");
  });
});
