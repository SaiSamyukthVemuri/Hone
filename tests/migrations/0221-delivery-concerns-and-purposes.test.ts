import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0221 — DELIVERY-VISIBILITY-04: cancellation and postcare email
// purposes, and owner-reported delivery concerns. SOURCE CONTRACT.
//
// Behaviour (the wider purposes, the concern's snapshot and write-once rules,
// one open concern per key, owner-only report and read, support-only close,
// privileges, isolation) is proved in tests/db/delivery-concerns.db.test.ts.
// This file pins grants by name, no top-level DML, the pending migrations it
// builds on left byte-identical, and nowhere to keep free text or an address.
// ===========================================================================

const VERSION = "0221";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIGRATIONS, f), "utf8");
const SQL = read("0221_delivery_concerns_and_purposes.sql");
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sha = (f: string) => createHash("sha256").update(read(f), "utf8").digest("hex");

describe("0221 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this — see
    // CLAUDE.md §2. It reached this file from 0215's test.
    expect(isRepoMax(VERSION)).toBe(false); // handed off to 0222 on this branch
    const above = versionsAbove(VERSION);
    expect(above.length, "nothing sits above 0221").toBeGreaterThan(0);
    expect(above.every((v) => Number(v) > Number(VERSION))).toBe(true);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("leaves the pending delivery migrations it builds on byte-identical", () => {
    expect(sha("0212_email_delivery_events.sql")).toBe("cc2abfa3059157b841c1c1c095a84045410121be13d96ff93e34f8332f81d6d1");
    expect(sha("0215_delivery_incidents.sql")).toBe("09b01315e5159a1786a0bcabf0c5a3a8abffe62790123099b887c3d29de5e9d2");
  });
});

describe("0221 is one transaction and writes no rows", () => {
  it("opens with begin + lock_timeout and closes with commit", () => {
    expect(TOP_LEVEL.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(TOP_LEVEL.trim().endsWith("commit;")).toBe(true);
  });

  it("has no top-level DML", () => {
    expect(TOP_LEVEL).not.toMatch(/\binsert\s+into\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bupdate\s+public\./i);
    expect(TOP_LEVEL).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("widens the email ledger by exactly two purposes and alters nothing else that exists", () => {
    const altered = new Set([...TOP_LEVEL.matchAll(/alter table (public\.[a-z_]+)/g)].map((m) => m[1]));
    expect(altered).toEqual(new Set(["public.email_outbound_messages", "public.delivery_concerns"]));
    expect(TOP_LEVEL).toMatch(/drop constraint email_outbound_messages_purpose_ck;/);
    const added = TOP_LEVEL.match(/add constraint email_outbound_messages_purpose_ck check \(purpose in \(([^)]*)\)\)/);
    expect(added![1]!.split(",").map((v) => v.trim().replace(/'/g, "")).sort()).toEqual(
      [
        "appointment_cancellation",
        "appointment_confirmation",
        "appointment_postcare",
        "appointment_reminder_24h",
        "appointment_reminder_2h",
      ].sort(),
    );
  });
});

describe("0221 privilege closure", () => {
  const OWNER = ["report_delivery_concern(uuid, uuid, text, text)", "owner_delivery_concerns(uuid)"];
  const SERVICE = [
    "support_delivery_concerns(boolean)",
    "close_delivery_concern(uuid, text)",
    "begin_appointment_email_message(uuid, uuid, text)",
  ];

  it("revokes every command from all four roles by name, then grants each to exactly its role", () => {
    for (const fn of [...OWNER, ...SERVICE]) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(CODE, `${fn} not revoked from ${role}`).toMatch(
          new RegExp(`revoke execute on function public\\.${escape(fn)} from ${role};`),
        );
      }
    }
    for (const fn of OWNER) expect(CODE).toMatch(new RegExp(`grant execute on function public\\.${escape(fn)} to authenticated;`));
    for (const fn of SERVICE) expect(CODE).toMatch(new RegExp(`grant execute on function public\\.${escape(fn)} to service_role;`));
    expect(CODE).not.toMatch(/grant[^;]*\bto\s+(anon|public)\b/i);
  });

  it("the owner commands require a user who owns the studio", () => {
    for (const fn of ["report_delivery_concern", "owner_delivery_concerns"]) {
      const start = CODE.indexOf(`create or replace function public.${fn}(`);
      const body = CODE.slice(start, CODE.indexOf("$$;", start));
      expect(body).toMatch(/auth\.uid\(\) is null/);
      expect(body).toMatch(/not public\.is_studio_owner\(p_studio_id\)/);
    }
  });

  it("closes the table to every role, with RLS on and no policy", () => {
    expect(CODE).toMatch(/revoke all on public\.delivery_concerns\s+from public, anon, authenticated, service_role;/);
    expect(CODE).toMatch(/alter table public\.delivery_concerns enable row level security;/);
    expect(CODE).not.toMatch(/create policy/i);
  });
});

describe("0221 privacy and evidence", () => {
  const table = (() => {
    const start = CODE.indexOf("create table if not exists public.delivery_concerns (");
    return CODE.slice(start, CODE.indexOf("\n);", start));
  })();

  it("declares no free text, address or client identity", () => {
    expect(table).not.toMatch(/\b(note|comment|message_text|body|client_id|client_name|email_address|phone|recipient)\b/i);
  });

  it("keeps the reporter as evidence, not a foreign key", () => {
    expect(table).toMatch(/reported_by_practitioner_id uuid not null,/);
    expect(table).not.toMatch(/reported_by_practitioner_id[^,]*references/);
  });
});
