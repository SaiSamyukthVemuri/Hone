import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0206 — SMS-00 delivery foundation. SOURCE CONTRACT.
//
// The behaviour (claims, settles, forward-only statuses, the once-per-
// invitation rule and its row lock, privilege closure measured by
// has_*_privilege) is proved against a real database in
// tests/db/sms-delivery-foundation.db.test.ts. This file pins what a database
// test cannot see from the inside: that the migration grants nothing to a
// browser role BY NAME, re-asserts every revoke Supabase's default privileges
// would otherwise undo, writes no rows outside its own commands, and touches no
// existing table beyond one studios column -- in particular, no trigger on
// appointments and no change to the email or SMS reminder claim pairs.
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
  "claim_reminder_sms_send(uuid, text, timestamptz, timestamptz)",
] as const;

const TRIGGER_FUNCTIONS = [
  "sms_outbound_messages_server_timestamps()",
  "sms_outbound_messages_identity_guard()",
] as const;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("0206 sits correctly in the migration sequence", () => {
  it("is no longer the repository maximum", () => {
    // HANDED OFF, per CLAUDE.md §2: only the CURRENT max may assert
    // `isRepoMax`, and that claim now lives in 0207's own test.
    expect(isRepoMax(VERSION)).toBe(false);
    // DERIVED, NOT PINNED: something sits above it, and everything above it is
    // greater. A literal list would be the forbidden pin in other clothes.
    const above = versionsAbove(VERSION);
    expect(above.length, "nothing sits above this older migration").toBeGreaterThan(0);
    expect(
      above.every((v) => Number(v) > Number(VERSION)),
      "versionsAbove returned a version at or below its own",
    ).toBe(true);
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

  it("does not redefine either reminder claim pair (SMS 0049, email 0080)", () => {
    for (const fn of ["claim_sms_send", "record_sms_result", "claim_email_send", "record_email_result"]) {
      expect(CODE, fn).not.toMatch(new RegExp(`function public\\.${fn}\\b`));
    }
  });

  it("the only existing table it alters is studios, by one column, and it adds no trigger to any existing table", () => {
    const altered = [...TOP_LEVEL.matchAll(/alter table (public\.[a-z_]+)/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(["public.studios", "public.sms_outbound_messages"]));
    expect(TOP_LEVEL).toMatch(
      /alter table public\.studios\s+add column if not exists send_waitlist_invitation_sms boolean not null default false;/,
    );
    const triggerTargets = [...TOP_LEVEL.matchAll(/create trigger [a-z_]+\s+[^;]*?\bon (public\.[a-z_]+)/g)].map(
      (m) => m[1],
    );
    // Anti-vacuity: the parser does find this migration's own triggers.
    expect(triggerTargets.length).toBe(2);
    expect(new Set(triggerTargets)).toEqual(new Set(["public.sms_outbound_messages"]));
    // SMS-03 is the specified follow-up for reminders after a move; nothing in
    // this migration re-arms a reminder slot.
    expect(CODE).not.toMatch(/on public\.appointments/);
  });
});

describe("0206 the invitation claim cannot race a lifecycle command", () => {
  it("holds the invitation row FOR SHARE through the claim", () => {
    const start = CODE.indexOf("create or replace function public.claim_waitlist_invitation_sms(");
    expect(start).toBeGreaterThan(-1);
    const body = CODE.slice(start, CODE.indexOf("$$;", start));
    expect(body).toMatch(
      /from public\.new_client_waitlist_invitations i\s+where i\.id = p_invitation_id\s+and i\.studio_id = p_studio_id\s+for share;/,
    );
  });
});

describe("0206 the reminder claim validates and claims in ONE transaction", () => {
  const body = (() => {
    const start = CODE.indexOf("create or replace function public.claim_reminder_sms_send(");
    expect(start).toBeGreaterThan(-1);
    return CODE.slice(start, CODE.indexOf("$$;", start));
  })();

  it("locks the appointment row before deciding", () => {
    expect(body).toMatch(/from public\.appointments a\s+where a\.id = p_appointment_id\s+for no key update;/);
  });

  it("checks status and window BEFORE calling the unchanged claim_sms_send", () => {
    const status = body.indexOf("if v_status is distinct from 'confirmed' then");
    const window = body.indexOf("if v_starts < p_window_start or v_starts > p_window_end then");
    const claim = body.indexOf("public.claim_sms_send(p_appointment_id, p_sms_type)");
    expect(status).toBeGreaterThan(-1);
    expect(window).toBeGreaterThan(status);
    expect(claim).toBeGreaterThan(window);
  });

  it("accepts only the two reminder types", () => {
    expect(body).toMatch(/p_sms_type not in \('reminder_24h', 'reminder_2h'\)/);
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
