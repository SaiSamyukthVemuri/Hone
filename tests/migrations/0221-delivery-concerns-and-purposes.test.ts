import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion } from "./helpers/migration-state";

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
  // No repo-max claim here (CLAUDE.md §2): "nothing above 0221" is a fact
  // about one branch, and it turns red for whichever lane lands above it
  // (0227 on the composed chain). The central tripwire covers it.

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

describe("0221 grants EXACTLY the intended roles, and nothing else", () => {
  // Every GRANT statement in the file -- any privilege, any object, every role
  // of a comma list -- as "privilege | object -> role". A stray grant beside
  // the intended one (to anon, a second role, \`grant all\`, a schema-wide
  // grant) changes this list, so the assertion is exact, not "contains".
  const grants = (code: string): string[] => {
    // Both comment forms are stripped first, so a commented-out grant neither
    // counts nor hides one. Then statement by statement (split on ";"), so a
    // grant on the same line as another statement is still seen.
    const bare = code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
    const out: string[] = [];
    for (const stmt of bare.split(";")) {
      const m = /^\s*grant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)\s*$/i.exec(stmt);
      if (!m) continue;
      const obj = m[2]!.replace(/\s+/g, " ").trim().replace(/^function /i, "");
      for (const role of m[3]!.split(",")) out.push(`${m[1]!.replace(/\s+/g, " ").trim().toLowerCase()} | ${obj} -> ${role.trim().toLowerCase()}`);
    }
    return out.sort();
  };

  it("matches the intended grant list exactly", () => {
    expect(grants(SQL)).toEqual([
      "execute | public.begin_appointment_email_message(uuid, uuid, text) -> service_role",
      "execute | public.close_delivery_concern(uuid, text) -> service_role",
      "execute | public.owner_delivery_concerns(uuid) -> authenticated",
      "execute | public.report_delivery_concern(uuid, uuid, text, text) -> authenticated",
      "execute | public.support_delivery_concerns(boolean) -> service_role",
    ]);
  });
});
