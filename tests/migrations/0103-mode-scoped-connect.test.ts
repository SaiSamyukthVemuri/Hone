import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Migration 0103: mode-scoped Stripe Connect provisioning. Fixes the
// production live-enablement blocker ("studio ... is already bound to mode f,
// refusing to provision mode t") by allowing one studio_payment_settings row
// per (studio, mode) and mode-scoping the five settings RPCs. Source-grep the
// shape; the behavioral proof runs on the real migrated DB in
// tests/db/mode-scoped-connect-provisioning.db.test.ts.

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0103_mode_scoped_stripe_connect_provisioning.sql";
const SOURCE = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
// Comments stripped so prose describing the OLD refusal can't trip greps
// that must target real DDL/PLpgSQL.
const CODE = SOURCE.replace(/--.*$/gm, "");

describe("0103: migration number + scope", () => {
  it("is numbered 0103 (immediately after 0102)", () => {
    const nums = readdirSync(MIGRATIONS_DIR)
      .map((f) => /^(\d{4})_/.exec(f)?.[1])
      .filter(Boolean)
      .map((n) => Number(n));
    // 0103 exists and 0102 precedes it; the global-max tripwire lives in the
    // newest migration's test, so this does not re-break when later
    // migrations land.
    expect(nums).toContain(103);
    expect(nums).toContain(102);
    expect(FILE).toMatch(/^0103_/);
  });

  it("touches ONLY studio_payment_settings + its five RPCs (no payment tables, no policies, no env)", () => {
    expect(CODE).not.toMatch(/create policy|drop policy|alter policy/i);
    expect(CODE).not.toMatch(/STRIPE_ALLOW_LIVE_MODE/);
    expect(CODE).not.toMatch(
      /alter table public\.(?!studio_payment_settings)/i,
    );
    // Never touches the charge/refund/webhook payment tables.
    expect(CODE).not.toMatch(
      /(insert into|update|delete from|alter table)\s+public\.(payment_charge_attempts|manual_fee_charge_attempts|stripe_events|client_payment_methods)\b/i,
    );
  });
});

describe("0103: schema — one settings row per (studio, mode)", () => {
  it("adds the surrogate id PK and swaps the PK off studio_id (guarded, re-runnable)", () => {
    expect(CODE).toMatch(/add column if not exists id uuid not null default gen_random_uuid\(\)/);
    expect(CODE).toMatch(/drop constraint studio_payment_settings_pkey/);
    expect(CODE).toMatch(/add constraint studio_payment_settings_pkey primary key \(id\)/);
    // The swap is guarded on the CURRENT PK being (studio_id) so re-running is safe.
    expect(CODE).toMatch(/contype = 'p'/);
    expect(CODE).toMatch(/array\['studio_id'\]/);
  });

  it("adds UNIQUE NULLS NOT DISTINCT (studio_id, stripe_livemode)", () => {
    expect(CODE).toMatch(
      /add constraint studio_payment_settings_studio_mode_uniq\s*\n?\s*unique nulls not distinct \(studio_id, stripe_livemode\)/,
    );
  });

  it("rescopes the provisioning-attempts active-uniqueness to (studio_id, stripe_livemode)", () => {
    // Adversarial-review blocker: the 0032 per-STUDIO partial unique would
    // 23505 a live claim for any studio with a succeeded test attempt.
    expect(CODE).toMatch(/drop index if exists public\.stripe_account_provisioning_active_uniq/);
    expect(CODE).toMatch(
      /create unique index stripe_account_provisioning_active_uniq\s*\n?\s*on public\.stripe_account_provisioning_attempts \(studio_id, stripe_livemode\)\s*\n?\s*nulls not distinct\s*\n?\s*where status in \('pending', 'processing', 'succeeded'\)/,
    );
  });

  it("drops the two DEAD one-row-assumption card-required RPCs (0091 precedent)", () => {
    expect(CODE).toMatch(/drop function if exists public\.start_card_required_booking_session\(/);
    expect(CODE).toMatch(/drop function if exists public\.create_or_claim_charge_attempt\(/);
  });

  it("preserves the downstream FK target and the account/mode pair CHECK (no drops)", () => {
    expect(CODE).not.toMatch(/drop constraint\s+(if exists\s+)?studio_payment_settings_account_mode_unique/);
    expect(CODE).not.toMatch(/drop constraint\s+(if exists\s+)?studio_payment_settings_account_mode_pair_check/);
    // No destructive statements against existing rows. (UPDATEs inside the
    // replaced RPC bodies are the RPCs' normal write paths, not a backfill —
    // the migration itself runs no standalone UPDATE/DELETE.)
    expect(CODE).not.toMatch(/delete from public\.studio_payment_settings/i);
    expect(CODE).not.toMatch(/drop column/i);
    expect(CODE).not.toMatch(/truncate/i);
  });
});

describe("0103: RPCs — mode-scoped", () => {
  it("create_or_claim: the cross-mode refusal is GONE; lookups are mode-scoped", () => {
    // The exact production failure string must no longer be raisable.
    expect(CODE).not.toMatch(/already bound to mode/);
    expect(CODE).not.toMatch(/cannot be returned for mode/);
    const fn = CODE.slice(
      CODE.indexOf("create or replace function public.create_or_claim_stripe_account_provisioning"),
      CODE.indexOf("create or replace function public.complete_stripe_account_provisioning"),
    );
    expect(fn).toMatch(/sps\.stripe_livemode = p_stripe_livemode/);
    expect(fn).toMatch(/spa\.stripe_livemode = p_stripe_livemode/);
  });

  it("complete: settings lock + upsert are per (studio_id, stripe_livemode)", () => {
    const fn = CODE.slice(
      CODE.indexOf("create or replace function public.complete_stripe_account_provisioning"),
      CODE.indexOf("create or replace function public.sync_studio_account_status"),
    );
    expect(fn).toMatch(/and sps\.stripe_livemode = p_stripe_livemode/);
    expect(fn).toMatch(/on conflict on constraint studio_payment_settings_studio_mode_uniq/);
    expect(fn).not.toMatch(/on conflict \(studio_id\)/);
    // Refuse-to-swap posture preserved.
    expect(fn).toMatch(/refusing to complete provisioning/);
    expect(fn).toMatch(/where public\.studio_payment_settings\.stripe_account_id is null/);
    // No errcode drift: the null/blank input guard keeps 0032's 22023
    // (invalid_parameter_value), not P0002 (adversarial-review fix).
    expect(fn).toMatch(
      /must be supplied \(non-blank\)'\s*\n?\s*using errcode = '22023'/,
    );
  });

  it("sync: locks + updates the current-mode row only, null guards hoisted", () => {
    const fn = CODE.slice(
      CODE.indexOf("create or replace function public.sync_studio_account_status"),
      CODE.indexOf("drop function if exists public.get_studio_payment_settings_display"),
    );
    // The UPDATE is mode-scoped.
    expect(fn).toMatch(
      /update public\.studio_payment_settings sps[\s\S]*?where sps\.studio_id = p_studio_id\s*\n?\s*and sps\.stripe_livemode = p_stripe_livemode/,
    );
    // Null guards run BEFORE the row lookup (a null mode must never match the placeholder).
    const nullGuard = fn.indexOf("p_stripe_livemode is null");
    const lookup = fn.indexOf("select * into v_existing");
    expect(nullGuard).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(nullGuard);
    // Account-mismatch hard refusal preserved.
    expect(fn).toMatch(/stripe_account_id mismatch/);
  });

  it("display: old 1-arg overload dropped; new (uuid, boolean) is mode-scoped + owner-gated", () => {
    expect(CODE).toMatch(/drop function if exists public\.get_studio_payment_settings_display\(uuid\)/);
    const fn = CODE.slice(
      CODE.indexOf("create or replace function public.get_studio_payment_settings_display"),
      CODE.indexOf("create or replace function public.set_studio_require_card_on_file"),
    );
    expect(fn).toMatch(/p_stripe_livemode boolean/);
    expect(fn).toMatch(/is_studio_owner\(p_studio_id\)/);
    expect(fn).toMatch(/and sps\.stripe_livemode = p_stripe_livemode/);
    // Option A: require_card_on_file served from the null-mode placeholder.
    expect(fn).toMatch(/ph\.stripe_livemode is null/);
    // Grants restated for the NEW signature.
    expect(CODE).toMatch(/grant execute on function public\.get_studio_payment_settings_display\(uuid, boolean\)\s*\n?\s*to authenticated/);
  });

  it("set_studio_require_card_on_file: Option A null-mode placeholder upsert", () => {
    const fn = CODE.slice(
      CODE.indexOf("create or replace function public.set_studio_require_card_on_file"),
    );
    expect(fn).toMatch(/on conflict on constraint studio_payment_settings_studio_mode_uniq/);
    expect(fn).not.toMatch(/on conflict \(studio_id\)/);
    // Enable-guard still requires a connected + enabled + charges mode row.
    expect(fn).toMatch(/stripe_account_status = 'enabled'/);
    expect(fn).toMatch(/stripe_charges_enabled/);
    // Owner check + service_role-only grant preserved.
    expect(fn).toMatch(/only the studio owner can change require_card_on_file/);
    expect(fn).toMatch(/grant execute on function public\.set_studio_require_card_on_file\(uuid, uuid, boolean\)\s*\n?\s*to service_role/);
  });

  it("service_role-only grants preserved on the provisioning trio", () => {
    for (const sig of [
      "create_or_claim_stripe_account_provisioning\\(uuid, boolean\\)",
      "complete_stripe_account_provisioning\\(uuid, uuid, text, boolean\\)",
      "sync_studio_account_status\\(uuid, text, boolean, text, boolean, boolean, timestamptz\\)",
    ]) {
      expect(CODE).toMatch(
        new RegExp(`revoke execute on function public\\.${sig}\\s*\\n?\\s*from public, anon, authenticated`),
      );
      expect(CODE).toMatch(
        new RegExp(`grant execute on function public\\.${sig}\\s*\\n?\\s*to service_role`),
      );
    }
  });
});
