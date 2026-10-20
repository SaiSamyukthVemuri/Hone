import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0212 — DELIVERY-EVENTS-01 email delivery events. SOURCE CONTRACT.
//
// Behaviour (replay, order, exactly-once processing, crash recovery, tenant
// isolation, provider failure, privilege closure measured by has_*_privilege)
// is proved against a real database in
// tests/db/email-delivery-events.db.test.ts. This file pins what a database
// test cannot see from the inside: the migration grants nothing to a browser
// role BY NAME and re-asserts every revoke Supabase's default privileges
// would otherwise undo. It writes no rows, touches no existing table, command
// or trigger, and declares nowhere to keep an address, a subject or a payload.
// ===========================================================================

const VERSION = "0212";
const FILE = "0212_email_delivery_events.sql";
const SQL = readFileSync(path.join(process.cwd(), "supabase/migrations", FILE), "utf8");
// LINE comments first: a comment must never satisfy a code assertion.
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
// Everything OUTSIDE dollar-quoted bodies: the migration's own top-level
// statements.
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");

const COMMANDS = [
  "begin_appointment_email_message(uuid, uuid, text)",
  "settle_email_message(uuid, text, text, text, text)",
  "record_email_provider_event(text, text, text, uuid, timestamptz, text, text, text, text)",
  "claim_email_provider_events(uuid, integer)",
  "process_email_provider_event(uuid)",
] as const;

const TRIGGER_FUNCTIONS = [
  "email_outbound_messages_server_timestamps()",
  "email_outbound_messages_identity_guard()",
  "email_provider_events_server_defaults()",
  "email_provider_events_identity_guard()",
] as const;

const TABLES = ["public.email_outbound_messages", "public.email_provider_events"] as const;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function bodyOf(fn: string): string {
  const start = CODE.indexOf(`create or replace function public.${fn}(`);
  expect(start, `${fn} is not defined`).toBeGreaterThan(-1);
  return CODE.slice(start, CODE.indexOf("$$;", start));
}

function tableOf(name: string): string {
  const start = CODE.indexOf(`create table if not exists ${name} (`);
  expect(start, `${name} is not created`).toBeGreaterThan(-1);
  return CODE.slice(start, CODE.indexOf("\n);", start));
}

describe("0212 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this — see
    // CLAUDE.md §2. It reached this file from 0210's test.
    expect(isRepoMax(VERSION), "0212 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION), "something was added above 0212").toEqual([]);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });
});

describe("0212 is one transaction with a lock timeout", () => {
  it("opens with begin + lock_timeout and closes with commit", () => {
    const statements = TOP_LEVEL.trim();
    expect(statements).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(statements.endsWith("commit;")).toBe(true);
  });
});

describe("0212 privilege closure", () => {
  it("every command is revoked from all four roles BY NAME, then granted to service_role only", () => {
    for (const fn of COMMANDS) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(CODE, `${fn} is not revoked from ${role}`).toMatch(
          new RegExp(`revoke execute on function public\\.${escape(fn)} from ${role};`),
        );
      }
      expect(CODE).toMatch(new RegExp(`grant execute on function public\\.${escape(fn)} to service_role;`));
    }
    expect(CODE).not.toMatch(/grant[^;]*\bto\s+(anon|authenticated|public)\b/i);
  });

  it("both tables are revoked from every role, granted to none, with RLS on and no policy", () => {
    for (const table of TABLES) {
      expect(CODE).toMatch(
        new RegExp(`revoke all on ${escape(table)}\\s+from public, anon, authenticated, service_role;`),
      );
      expect(CODE).not.toMatch(new RegExp(`grant[^;]*on\\s+(table\\s+)?${escape(table)}\\b`, "i"));
      expect(CODE).toMatch(new RegExp(`alter table ${escape(table)} enable row level security;`));
    }
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

  it("every SECURITY DEFINER function is a listed command and pins its search_path", () => {
    const definers = CODE.split(/create or replace function/)
      .slice(1)
      .filter((f) => /security definer/.test(f.split("$$")[0] ?? ""));
    expect(definers).toHaveLength(COMMANDS.length);
    for (const header of definers.map((f) => f.split("$$")[0] ?? "")) {
      expect(header).toMatch(/set search_path = pg_catalog, pg_temp/);
    }
  });
});

describe("0212 writes no rows and touches nothing that already exists", () => {
  it("has no top-level DML", () => {
    expect(TOP_LEVEL).not.toMatch(/\binsert\s+into\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bupdate\s+public\./i);
    expect(TOP_LEVEL).not.toMatch(/\bdelete\s+from\b/i);
    expect(TOP_LEVEL).not.toMatch(/\btruncate\b/i);
  });

  it("redefines no existing command: the email claim pairs and the SMS ledger stay as they are", () => {
    for (const fn of [
      "claim_email_send",
      "record_email_result",
      "record_email_attempt",
      "begin_appointment_sms_message",
      "settle_sms_message",
      "record_sms_delivery_status",
      "claim_sms_send",
    ]) {
      expect(CODE, fn).not.toMatch(new RegExp(`function public\\.${fn}\\b`));
    }
  });

  it("alters only its own tables and adds triggers only to them", () => {
    const altered = [...TOP_LEVEL.matchAll(/alter table (public\.[a-z_]+)/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(TABLES));
    const triggerTargets = [...TOP_LEVEL.matchAll(/create trigger [a-z_]+\s+[^;]*?\bon (public\.[a-z_]+)/g)].map(
      (m) => m[1],
    );
    // Anti-vacuity: the parser does find this migration's own four triggers.
    expect(triggerTargets).toHaveLength(4);
    expect(new Set(triggerTargets)).toEqual(new Set(TABLES));
    expect(TOP_LEVEL).not.toMatch(/\bon public\.(appointments|studios|ops_alerts|sms_outbound_messages)\b/);
  });
});

describe("0212 privacy: nowhere to keep an address, a subject or a payload", () => {
  it("declares no address, subject, body, header, tag or payload column", () => {
    for (const table of TABLES) {
      expect(tableOf(table)).not.toMatch(
        /\b(recipient|to_address|from_address|email_address|subject|body|html|text_body|headers|tags|payload|raw|message_text)\b/i,
      );
    }
  });

  it("stores provider reasons as slugs, never free text", () => {
    const slug = "'^[a-z][a-z0-9_]{1,63}$'";
    for (const column of ["bounce_type", "bounce_subtype", "failure_reason", "suppression_type"]) {
      expect(tableOf("public.email_provider_events")).toContain(`${column} ~ ${slug}`);
    }
    for (const column of ["provider_error", "provider_reason"]) {
      expect(tableOf("public.email_outbound_messages")).toContain(`${column} ~ ${slug}`);
    }
  });
});

describe("0212 attribution comes from the ledger, never from the payload", () => {
  it("gives receipts no studio column: a receipt reaches a studio only through the row it was applied to", () => {
    const receipts = tableOf("public.email_provider_events");
    expect(receipts).not.toMatch(/\bstudio_id\b/);
    expect(receipts).toMatch(
      /email_message_id\s+uuid references public\.email_outbound_messages\(id\) on delete cascade/,
    );
    expect(receipts).toMatch(/\(processing_state in \('applied', 'stale'\)\) = \(email_message_id is not null\)/);
  });

  it("keeps the reported tag as evidence, not as a foreign key", () => {
    expect(tableOf("public.email_provider_events")).toMatch(/hone_message_id\s+uuid,/);
  });

  it("ties a ledger row to its appointment and studio together", () => {
    expect(tableOf("public.email_outbound_messages")).toMatch(
      /foreign key \(appointment_id, studio_id\)\s+references public\.appointments \(id, studio_id\) on delete cascade/,
    );
  });
});

describe("0212 processing is exactly once", () => {
  const body = bodyOf("process_email_provider_event");

  it("locks the receipt, refuses one that is not pending, then locks the ledger row", () => {
    const receiptLock = body.indexOf("from public.email_provider_events e\n   where e.id = p_event_id\n     for update;");
    const pending = body.indexOf("if v_evt.processing_state <> 'pending' then");
    const ledgerLock = body.indexOf("from public.email_outbound_messages m");
    expect(receiptLock).toBeGreaterThan(-1);
    expect(pending).toBeGreaterThan(receiptLock);
    expect(ledgerLock).toBeGreaterThan(pending);
  });

  it("claims count an attempt before it is made, and give up after a bounded number", () => {
    const claim = bodyOf("claim_email_provider_events");
    expect(claim).toMatch(/c_max_attempts constant integer\s+:= 5;/);
    expect(claim).toMatch(/processing_attempts\s+= e\.processing_attempts \+ 1/);
    expect(claim).toMatch(/processing_result\s+= 'processing_exhausted'/);
    expect(claim.match(/for update skip locked/g)).toHaveLength(2);
  });
});
