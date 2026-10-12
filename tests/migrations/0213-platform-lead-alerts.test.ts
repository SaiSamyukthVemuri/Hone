import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0213 — LEAD-ALERT-01 (#826): the operator alert for a new Hone
// demo request or early-access signup. SOURCE CONTRACT.
//
// Behaviour is proved against a real database in
// tests/db/platform-lead-alerts.db.test.ts and
// tests/db/platform-lead-alert-actions.db.test.ts. This file pins what those
// cannot see:
// - the frozen migrations it sits on (0209, 0210) and the lead tables it
//   writes to (0004, 0006) are byte-identical;
// - it adds one table and eight functions, and touches no existing object:
//   the anonymous insert policies stay, so the deployed forms keep working
//   until the application that uses the commands is deployed;
// - no row is written at top level: no backfill, so no catch-up alert;
// - no column, parameter or default can hold a recipient address;
// - every grantee is revoked by name, and only service_role is granted.
// ===========================================================================

const VERSION = "0213";
const FILE = "0213_platform_lead_alerts.sql";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIGRATIONS, f), "utf8");
const SQL = read(FILE);
// LINE comments first: a comment must never satisfy a code assertion.
const stripComments = (sql: string) => sql.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const CODE = stripComments(SQL);
// Everything OUTSIDE dollar-quoted bodies: the migration's own top-level statements.
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");
const normalise = (sql: string) => stripComments(sql).replace(/\s+/g, " ").trim();

const COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["record_platform_demo_request", "text, text, text, text, text, text, text, text"],
  ["record_platform_early_access_signup", "text"],
  ["claim_platform_lead_alert", "uuid, integer"],
  ["settle_platform_lead_alert", "uuid, uuid, text, text, text, text"],
  ["expire_platform_lead_alerts", ""],
  ["record_platform_lead_alerts_unconfigured", "text, uuid"],
  ["requeue_platform_lead_alert", "uuid"],
];
const GUARD = "platform_lead_alerts_guard";

/** One function's full definition, from its create statement to its closing $$;. */
function definition(fn: string): string {
  const start = SQL.indexOf(`create or replace function public.${fn}(`);
  expect(start, `no ${fn} definition`).toBeGreaterThan(-1);
  const end = SQL.indexOf("$$;", start);
  return SQL.slice(start, end + "$$;".length);
}

describe("0213 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this — see
    // CLAUDE.md §2. It reached this file from 0212's test when the lanes were
    // stacked 0211 -> 0212 -> 0213.
    expect(isRepoMax(VERSION), "0213 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION), "something was added above 0213").toEqual([]);
  });

  it("is allocated exactly once, directly above 0211 and 0212", () => {
    expect(countVersion(VERSION)).toBe(1);
    expect(countVersion("0211")).toBe(1);
    expect(countVersion("0212")).toBe(1);
  });
});

describe("0213 leaves every applied migration it relies on untouched", () => {
  const APPLIED: ReadonlyArray<readonly [string, string]> = [
    ["0004_waitlist.sql", "7f834cc31ac8135c9cd899db9efa07cd70338f90d26594b76391e90d20bcd149"],
    ["0006_demo_requests.sql", "03991df392de0f87a0b78e770201b25db96486bbea8e740771d24f0f2922a681"],
    ["0209_public_slot_candidate_buffer_window.sql", "9fa04999b974d70d838ba27800a22338b1f08fd7977f553dec38fba034e3f877"],
    ["0210_sms_waitlist_join_acknowledgement.sql", "b1d33743235644447da41a17778e890c05c14deda6c299303cc5febdceea7157"],
    // STACKED BELOW 0213, carried byte-identical to their own PR heads:
    // #827 (481e60c6) and #832 (b5d50e78, itself on #827). A change there must be
    // re-merged here.
    ["0211_client_sms_permission_guard.sql", "33232496322727b2db67e33f15a38bd6281898d112d4d6b4d3b25534766578c3"],
    ["0212_email_delivery_events.sql", "cc2abfa3059157b841c1c1c095a84045410121be13d96ff93e34f8332f81d6d1"],
  ];
  for (const [file, sha] of APPLIED) {
    it(`${file} is byte-identical to the applied file`, () => {
      expect(createHash("sha256").update(read(file), "utf8").digest("hex")).toBe(sha);
    });
  }

  it("opens with begin + lock_timeout and closes with commit", () => {
    expect(TOP_LEVEL.trim()).toMatch(/^begin;\s+set local lock_timeout = '5s';/);
    expect(TOP_LEVEL.trim()).toMatch(/commit;$/);
  });

  it("creates one table and defines exactly eight functions, all new", () => {
    expect([...TOP_LEVEL.matchAll(/create table (public\.\w+)/g)].map((m) => m[1])).toEqual([
      "public.platform_lead_alerts",
    ]);
    const defined = [...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
    expect(defined.sort()).toEqual([...COMMANDS.map(([f]) => f), GUARD].sort());
  });

  it("alters, drops or re-grants nothing that exists: the anonymous insert policies on the lead tables stay", () => {
    expect(TOP_LEVEL).not.toMatch(/^\s*(drop|alter\s+(?!table public\.platform_lead_alerts\b))/im);
    expect(TOP_LEVEL).not.toMatch(/\b(create|drop|alter)\s+policy\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bon\s+(table\s+)?public\.(demo_requests|waitlist)\b/i);
  });

  it("writes no row at top level: no backfill, so no catch-up alert for an existing lead", () => {
    expect(TOP_LEVEL).not.toMatch(/^\s*(insert|update|delete)\b/im);
  });
});

describe("the alert table", () => {
  const table = SQL.slice(
    SQL.indexOf("create table public.platform_lead_alerts ("),
    SQL.indexOf("alter table public.platform_lead_alerts enable row level security;"),
  );

  it("holds no recipient and no prospect detail: ids, state and codes only", () => {
    const columns = [...stripComments(table).matchAll(/^\s{2}([a-z_]+)\s+(uuid|text|timestamptz|integer)\b/gm)].map((m) => m[1]);
    expect(columns).toEqual([
      "id", "lead_kind", "demo_request_id", "waitlist_id", "event_at", "status",
      "attempt_count", "next_attempt_at", "claim_token", "claimed_at", "lease_expires_at",
      "send_generation", "idempotency_key", "retry_requested_at", "provider_message_id",
      "accepted_at", "failed_at", "last_error_code", "last_error_at", "last_provider_error",
      "created_at", "updated_at",
    ]);
    expect(columns.join(" ")).not.toMatch(/recipient|email|address|name|notes|phone/);
  });

  it("one alert per lead, each lead a foreign key that takes its alert with it", () => {
    expect(normalise(table)).toContain("demo_request_id uuid unique references public.demo_requests (id) on delete cascade");
    expect(normalise(table)).toContain("waitlist_id uuid unique references public.waitlist (id) on delete cascade");
  });

  it("the idempotency key is DERIVED from the alert and its generation, never written", () => {
    expect(normalise(table)).toContain(
      "idempotency_key text generated always as ('lead-alert/' || id::text || '/' || send_generation::text) stored",
    );
  });

  it("row level security is on and there is no policy", () => {
    expect(TOP_LEVEL).toMatch(/alter table public\.platform_lead_alerts enable row level security;/);
    expect(CODE).not.toMatch(/create policy/i);
  });
});

describe("the commands", () => {
  it("every command is SECURITY DEFINER with a pinned search path and qualified names", () => {
    for (const [fn] of COMMANDS) {
      const def = normalise(definition(fn));
      expect(def, fn).toContain("security definer");
      expect(def, fn).toContain("set search_path = pg_catalog, pg_temp");
      expect(def, fn).toContain("set lock_timeout = '5s'");
      // Every table it names is schema-qualified. "for update of" and "is
      // distinct from" are not relation clauses; locals (v_) and parameters
      // (p_) are not relations.
      const relations = [...def.matchAll(/(?<!for |distinct )\b(from|join|into|update)\s+([a-z_.]+)/g)]
        .map((m) => m[2])
        .filter((r) => !/^(v_|p_)/.test(r) && r !== "a");
      expect(relations.filter((r) => !r.startsWith("public.")), fn).toEqual([]);
      // Not vacuous: every command names at least one real table.
      expect(relations.length, fn).toBeGreaterThan(0);
    }
  });

  it("the two record commands write the lead and its alert in one function, and nothing else", () => {
    const demo = normalise(definition("record_platform_demo_request"));
    expect(demo).toMatch(/insert into public\.demo_requests \(name, email, practice_name, location, practice_type, practitioner_count, current_tool, notes\)/);
    expect(demo).toMatch(/insert into public\.platform_lead_alerts \(lead_kind, demo_request_id, event_at, next_attempt_at\)/);
    const early = normalise(definition("record_platform_early_access_signup"));
    expect(early).toMatch(/insert into public\.waitlist \(email\) values \(p_email\) on conflict \(email\) do nothing/);
    // A duplicate returns before any alert is written.
    expect(early.indexOf("'duplicate'")).toBeLessThan(early.indexOf("insert into public.platform_lead_alerts"));
  });

  it("only the claim, the settle, the expiry, the blocker record and the retry write alerts, and none of them writes a lead", () => {
    for (const fn of ["claim_platform_lead_alert", "settle_platform_lead_alert", "expire_platform_lead_alerts", "record_platform_lead_alerts_unconfigured", "requeue_platform_lead_alert"]) {
      const def = normalise(definition(fn));
      expect(def, fn).not.toMatch(/(insert into|update|delete from) public\.(demo_requests|waitlist)\b/);
      expect(def, fn).toMatch(/update public\.platform_lead_alerts a/);
    }
  });

  it("the claim skips what another worker holds, and fences by the claim token", () => {
    expect(normalise(definition("claim_platform_lead_alert"))).toContain("for update of a skip locked");
    expect(normalise(definition("settle_platform_lead_alert"))).toContain(
      "if v_alert.status <> 'sending' or v_alert.claim_token is distinct from p_claim_token then return 'stale_claim';",
    );
  });

  it("no command takes or returns an address to send to", () => {
    for (const [fn] of COMMANDS) {
      const signature = definition(fn).split(/\b(language|as \$\$)/)[0];
      expect(signature, fn).not.toMatch(/recipient|p_to\b|destination/);
    }
  });
});

describe("privileges and blast radius", () => {
  it("revokes every grantee BY NAME, then grants each command to service_role only", () => {
    for (const [fn, args] of COMMANDS) {
      const sig = `public.${fn}(${args})`;
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(TOP_LEVEL, `${fn} from ${role}`).toContain(`revoke execute on function ${sig} from ${role};`);
      }
      const grants = [...TOP_LEVEL.matchAll(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to (\\w+);`, "g"))].map((m) => m[1]);
      expect(grants, fn).toEqual(["service_role"]);
    }
  });

  it("the table: everything revoked by name, SELECT to service_role and nothing else", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(TOP_LEVEL).toContain(`revoke all on table public.platform_lead_alerts from ${role};`);
    }
    const grants = [...TOP_LEVEL.matchAll(/grant ([a-z, ]+) on table public\.platform_lead_alerts to (\w+);/g)].map((m) => `${m[1]} -> ${m[2]}`);
    expect(grants).toEqual(["select -> service_role"]);
  });

  it("the guard function is revoked from everyone and granted to no one", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(TOP_LEVEL).toContain(`revoke all privileges on function public.${GUARD}() from ${role};`);
    }
    expect(TOP_LEVEL).not.toMatch(new RegExp(`grant [^;]*${GUARD}`));
  });
});
