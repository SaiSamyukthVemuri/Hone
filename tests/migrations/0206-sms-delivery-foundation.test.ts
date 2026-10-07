import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0206 — SMS-00 delivery foundation. SOURCE CONTRACT.
//
// The behaviour (claims, settles, forward-only statuses, the once-per-
// invitation rule, the re-arm trigger through the real move command, privilege
// closure measured by has_*_privilege) is proved against a real database in
// tests/db/sms-delivery-foundation.db.test.ts. This file pins what a database
// test cannot see from the inside: that the migration grants nothing to a
// browser role BY NAME, re-asserts every revoke Supabase's default privileges
// would otherwise undo, writes no rows outside its own commands, and re-arms
// exactly the start-keyed reminder slots.
// ===========================================================================

const VERSION = "0206";
const FILE = "0206_sms_delivery_foundation.sql";
const SQL = readFileSync(path.join(process.cwd(), "supabase/migrations", FILE), "utf8");
// LINE comments first: a comment must never satisfy a code assertion.
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
// Everything OUTSIDE dollar-quoted bodies: the migration's own top-level
// statements.
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");

const COMMANDS = [
  "begin_appointment_sms_message(uuid, uuid, text)",
  "claim_waitlist_invitation_sms(uuid, uuid)",
  "settle_sms_message(uuid, text, text, integer, text)",
  "record_sms_delivery_status(uuid, text, text, integer)",
] as const;

const TRIGGER_FUNCTIONS = [
  "sms_outbound_messages_server_timestamps()",
  "sms_outbound_messages_identity_guard()",
  "appointments_rearm_reminders_on_start_change()",
] as const;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("0206 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this — see
    // CLAUDE.md §2. 0205 handed the claim over when this file was authored.
    expect(isRepoMax(VERSION), "0206 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION), "something was added above 0206").toEqual([]);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });
});

describe("0206 is one transaction with a lock timeout", () => {
  it("opens with begin + lock_timeout and closes with commit", () => {
    const statements = TOP_LEVEL.trim();
    expect(statements.startsWith("begin;")).toBe(true);
    expect(statements).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(statements.endsWith("commit;")).toBe(true);
  });
});

describe("0206 privilege closure", () => {
  it("every command is revoked from all four roles BY NAME, then granted to service_role only", () => {
    for (const fn of COMMANDS) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(
          CODE,
          `${fn} is not revoked from ${role}`,
        ).toMatch(new RegExp(`revoke execute on function public\\.${escape(fn)} from ${role};`));
      }
      expect(CODE).toMatch(
        new RegExp(`grant execute on function public\\.${escape(fn)} to service_role;`),
      );
    }
    // No grant names a browser role anywhere in the file.
    expect(CODE).not.toMatch(/grant[^;]*\bto\s+(anon|authenticated|public)\b/i);
  });

  it("the ledger table is revoked from every role and granted to none", () => {
    expect(CODE).toMatch(
      /revoke all on public\.sms_outbound_messages\s+from public, anon, authenticated, service_role;/,
    );
    expect(CODE).not.toMatch(/grant[^;]*on\s+(table\s+)?public\.sms_outbound_messages/i);
    expect(CODE).toMatch(/alter table public\.sms_outbound_messages enable row level security;/);
    expect(CODE).not.toMatch(/create policy/i);
  });

  it("every trigger function is closed to every role", () => {
    for (const fn of TRIGGER_FUNCTIONS) {
      expect(CODE).toMatch(
        new RegExp(
          `revoke all privileges on function public\\.${escape(fn)}\\s+from public, anon, authenticated, service_role;`,
        ),
      );
    }
  });

  it("every SECURITY DEFINER function pins its search_path", () => {
    const definers = CODE.split(/create or replace function/).slice(1).filter((f) =>
      /security definer/.test(f.split("$$")[0] ?? ""),
    );
    expect(definers).toHaveLength(COMMANDS.length);
    for (const header of definers.map((f) => f.split("$$")[0] ?? "")) {
      expect(header).toMatch(/set search_path = pg_catalog, pg_temp/);
    }
  });
});

describe("0206 writes no rows of its own and leaves the 0049 commands alone", () => {
  it("has no top-level DML", () => {
    expect(TOP_LEVEL).not.toMatch(/\binsert\s+into\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bupdate\s+public\./i);
    expect(TOP_LEVEL).not.toMatch(/\bdelete\s+from\b/i);
    expect(TOP_LEVEL).not.toMatch(/\btruncate\b/i);
  });

  it("does not redefine claim_sms_send or record_sms_result", () => {
    expect(CODE).not.toMatch(/function public\.claim_sms_send/);
    expect(CODE).not.toMatch(/function public\.record_sms_result/);
  });

  it("the only existing tables it alters are studios (one column) and appointments (one trigger)", () => {
    const altered = [...TOP_LEVEL.matchAll(/alter table (public\.[a-z_]+)/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(["public.studios", "public.sms_outbound_messages"]));
    expect(TOP_LEVEL).toMatch(
      /alter table public\.studios\s+add column if not exists send_waitlist_invitation_sms boolean not null default false;/,
    );
    const triggersOnExisting = [...TOP_LEVEL.matchAll(/create trigger [a-z_]+\s+[^;]*?\bon (public\.[a-z_]+)/g)]
      .map((m) => m[1])
      .filter((t) => t !== "public.sms_outbound_messages");
    expect(triggersOnExisting).toEqual(["public.appointments"]);
  });
});

describe("0206 re-arms exactly the start-keyed reminder slots", () => {
  const body = (() => {
    const start = CODE.indexOf(
      "create or replace function public.appointments_rearm_reminders_on_start_change()",
    );
    expect(start).toBeGreaterThan(-1);
    const end = CODE.indexOf("$$;", start);
    return CODE.slice(start, end);
  })();

  it("fires before an update of starts_at, on appointments only", () => {
    expect(TOP_LEVEL).toMatch(
      /create trigger appointments_rearm_reminders_trg\s+before update of starts_at on public\.appointments\s+for each row execute function public\.appointments_rearm_reminders_on_start_change\(\);/,
    );
  });

  it("acts only when the start actually changes", () => {
    expect(body).toMatch(/if new\.starts_at is distinct from old\.starts_at then/);
  });

  it("resets the twelve 24h/2h email and SMS reminder columns, and nothing else", () => {
    const assigned = [...body.matchAll(/new\.([a-z0-9_]+)\s*:=/g)].map((m) => m[1]).sort();
    const expected = ["reminder_24h", "reminder_2h", "sms_reminder_24h", "sms_reminder_2h"]
      .flatMap((p) => [`${p}_sent_at`, `${p}_claimed_at`, `${p}_send_attempts`])
      .sort();
    expect(assigned).toEqual(expected);
    // Anti-vacuity: the parser does reach assignments, and confirmation slots
    // (not keyed to the start) are not among them.
    expect(assigned.length).toBe(12);
    expect(assigned.some((c) => c.includes("confirmation"))).toBe(false);
  });
});

describe("0206 privacy: the ledger cannot hold a phone number or a body", () => {
  it("declares no phone, body, recipient or message-text column", () => {
    const table = (() => {
      const start = CODE.indexOf("create table if not exists public.sms_outbound_messages (");
      expect(start).toBeGreaterThan(-1);
      return CODE.slice(start, CODE.indexOf(");", start));
    })();
    expect(table).not.toMatch(/\b(phone|to_number|recipient|body|message_text|content)\b/i);
  });
});
