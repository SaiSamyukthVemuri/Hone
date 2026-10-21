import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0214 — PAY-CCY-02 (#824): per-studio payment country and currency.
// SOURCE CONTRACT.
//
// Behaviour is proved against a real database in
// tests/db/studio-payment-jurisdiction.db.test.ts. This file pins what that
// cannot see: the frozen migrations it sits on are byte-identical, the file
// wraps itself, every new function is revoked by name and granted to
// service_role only, no browser role is granted anything, the only top-level
// DML is absent and unverified studios remain unknown, and the dormant / legacy CAD-only ledgers are
// untouched.
// ===========================================================================

const VERSION = "0214";
const FILE = "0214_studio_payment_jurisdiction.sql";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIGRATIONS, f), "utf8");
const SQL = read(FILE);
// LINE comments first: a comment must never satisfy a code assertion.
const stripComments = (sql: string) => sql.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const CODE = stripComments(SQL);
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const COMMANDS = [
  "set_studio_payment_jurisdiction(uuid, text, text, text, text, boolean, text)",
  "record_stripe_account_jurisdiction(uuid, text, boolean, text, text)",
];
const TRIGGER_FNS = [
  "payment_charge_attempts_jurisdiction_guard",
  "payment_charge_attempts_money_immutable",
  "appointment_settlements_currency_from_jurisdiction",
  "stripe_account_provisioning_payment_country",
];

describe("0214 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this (CLAUDE.md §2).
    expect(isRepoMax(VERSION), "0214 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("leaves the applied, frozen 0209 and 0210 byte-identical", () => {
    expect(sha256(read("0209_public_slot_candidate_buffer_window.sql"))).toBe(
      "9fa04999b974d70d838ba27800a22338b1f08fd7977f553dec38fba034e3f877",
    );
    expect(sha256(read("0210_sms_waitlist_join_acknowledgement.sql"))).toBe(
      "b1d33743235644447da41a17778e890c05c14deda6c299303cc5febdceea7157",
    );
  });
});

describe("0214 is one bounded transaction", () => {
  it("opens and closes its own transaction with a lock timeout inside it", () => {
    const begin = CODE.indexOf("begin;");
    expect(begin).toBeGreaterThan(-1);
    expect(CODE.indexOf("set local lock_timeout")).toBeGreaterThan(begin);
    expect(CODE.trim().endsWith("commit;")).toBe(true);
  });

  it("does not backfill or create a default jurisdiction", () => {
    expect(TOP_LEVEL).not.toMatch(/^\s*(insert|update|delete|truncate)\b/gim);
    expect(CODE).not.toContain("studios_payment_jurisdiction_default");
    expect(CODE).not.toMatch(/legacy_backfill|studio_created/);
  });

  it("requires explicit verified evidence and serializes first initialization", () => {
    expect(CODE).toContain("p_verification_reference text default null");
    expect(CODE).toContain("'verification_required'::text");
    expect(CODE).toContain("where st.id = p_studio_id for update");
    expect(CODE).toContain("v_initial := not found");
    expect(CODE).toContain("verification_reference = v_reference");
    expect(CODE).toContain("case when v_initial then 'initialized' else 'changed' end");
    expect(CODE).toContain("v_actor, v_reason, v_ack, v_reference");
  });

  it("does not touch the legacy and dormant CAD-only ledgers", () => {
    for (const t of [
      "manual_fee_charge_attempts",
      "stripe_charge_attempts",
      "appointment_payments",
      "pending_booking_payment_sessions",
    ]) {
      expect(TOP_LEVEL).not.toMatch(new RegExp(`alter table public\\.${t}\\b`));
    }
    // The 0103 provisioning/status RPCs are not redefined.
    expect(CODE).not.toMatch(/function public\.(create_or_claim_stripe_account_provisioning|complete_stripe_account_provisioning|sync_studio_account_status)\(/);
  });

  it("widens exactly the two live ledgers' currency to cad and usd, nothing else", () => {
    const widened = [...TOP_LEVEL.matchAll(/add constraint (\w+_currency_check)\s+check \(currency in \(([^)]*)\)\)/g)];
    expect(widened.map((m) => m[1]).sort()).toEqual([
      "appointment_settlements_currency_check",
      "payment_charge_attempts_currency_check",
    ]);
    for (const m of widened) expect(m[2].replace(/\s/g, "")).toBe("'cad','usd'");
  });

  it("only the CA/cad and US/usd pairs exist", () => {
    expect(CODE).toMatch(
      /\(payment_country = 'CA' and payment_currency = 'cad'\)\s+or \(payment_country = 'US' and payment_currency = 'usd'\)/,
    );
  });
});

describe("0214 privileges", () => {
  it.each(COMMANDS)("%s is revoked by name from all four roles, then granted to service_role only", (sig) => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(TOP_LEVEL).toContain(`revoke execute on function public.${sig} from ${role};`);
    }
    const grants = TOP_LEVEL.match(new RegExp(`grant execute on function public\\.${sig.replace(/[()]/g, "\\$&")} to (\\w+)`, "g")) ?? [];
    expect(grants).toEqual([`grant execute on function public.${sig} to service_role`]);
  });

  it.each(TRIGGER_FNS)("trigger function %s holds no grant", (fn) => {
    expect(TOP_LEVEL).toMatch(new RegExp(`revoke all privileges on function public\\.${fn}\\(\\)\\s+from public, anon, authenticated, service_role;`));
  });

  it("grants no browser role anything, and service_role SELECT only on the new tables", () => {
    expect(TOP_LEVEL).not.toMatch(/grant [^;]* to (anon|authenticated)/);
    const tableGrants = TOP_LEVEL.match(/grant [a-z, ]+ on public\.studio_payment_\w+ to \w+/g) ?? [];
    expect(tableGrants.sort()).toEqual([
      "grant select on public.studio_payment_jurisdiction_changes to service_role",
      "grant select on public.studio_payment_jurisdictions to service_role",
    ]);
    expect(TOP_LEVEL).not.toMatch(/create policy/);
  });

  it("every security definer function pins its search_path", () => {
    const definers = CODE.match(/security definer\s+set search_path = pg_catalog, pg_temp/g) ?? [];
    expect(definers.length).toBe((CODE.match(/security definer/g) ?? []).length);
  });
});
