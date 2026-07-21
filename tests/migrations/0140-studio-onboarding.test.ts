import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Source/structural contract for migration 0140 (first-time studio onboarding
// experience). Complements the behavioural DB/RLS suite
// (tests/db/studio-onboarding.db.test.ts) by pinning the additive/default-OFF
// and access-control properties that must hold in the SQL itself.

const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations");
const FILES = readdirSync(MIGRATIONS_DIR);
const FILE = FILES.find((f) => f.startsWith("0140_"));
const SQL = FILE ? readFileSync(join(MIGRATIONS_DIR, FILE), "utf8") : "";
// Comment-stripped copy so doc-comments can't satisfy or trip a grep.
const CODE = SQL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");

describe("0140 — file present", () => {
  it("exists with a purpose-encoding filename", () => {
    expect(FILE).toBe("0140_studio_onboarding.sql");
    expect(SQL.length).toBeGreaterThan(1000);
  });

  it("installs as ONE transaction", () => {
    expect(CODE).toMatch(/^\s*begin;/im);
    expect(CODE.trimEnd().endsWith("commit;")).toBe(true);
  });
});

describe("0140 — Gate 1: onboarding-v2 flag is additive + default OFF + operator-controlled", () => {
  it("adds the flag as additive, default false (byte-for-byte OFF contract)", () => {
    expect(CODE).toMatch(
      /add column if not exists onboarding_v2_enabled boolean not null default false/i,
    );
    // No UPDATE that would flip existing rows on.
    expect(CODE).not.toMatch(/update public\.studios[\s\S]*?set onboarding_v2_enabled\s*=\s*true/i);
  });

  it("installs a BEFORE UPDATE guard that rejects flag changes by browser roles", () => {
    expect(CODE).toMatch(/create or replace function public\.guard_onboarding_flag_activation/i);
    expect(CODE).toMatch(/before update of onboarding_v2_enabled\s+on public\.studios/i);
    expect(CODE).toMatch(/current_user in \('anon', 'authenticated'\)/i);
    expect(CODE).toMatch(/is distinct from old\.onboarding_v2_enabled/i);
    expect(CODE).toMatch(/42501/); // insufficient_privilege
  });

  it("the guard is SECURITY INVOKER (must see the real caller, not the owner)", () => {
    const fn = CODE.match(
      /create or replace function public\.guard_onboarding_flag_activation[\s\S]*?\$\$;/i,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn).not.toMatch(/security definer/i);
    expect(fn).toMatch(/set search_path = pg_catalog, pg_temp/i);
  });
});

describe("0140 — Gate 2: studio_onboarding table shape + honest state", () => {
  it("is keyed one-row-per-studio and CASCADE-torn-down", () => {
    expect(CODE).toMatch(
      /create table if not exists public\.studio_onboarding[\s\S]*?studio_id\s+uuid primary key[\s\S]*?references public\.studios\(id\) on delete cascade/i,
    );
  });

  it("constrains status, welcome_email_status and welcome_email_variant to closed sets", () => {
    expect(CODE).toMatch(/status\s+text not null default 'not_started'[\s\S]*?check \(status in \('not_started', 'in_progress', 'completed', 'skipped'\)\)/i);
    expect(CODE).toMatch(/welcome_email_status\s+text not null default 'not_sent'[\s\S]*?check \(welcome_email_status in \('not_sent', 'sent', 'failed'\)\)/i);
    expect(CODE).toMatch(/welcome_email_variant[\s\S]*?check \(welcome_email_variant in \('new_owner', 'existing_account'\)\)/i);
  });

  it("carries the resume pointer + celebrate-once + completed/skipped stamps", () => {
    for (const col of [
      "current_step",
      "completed_steps",
      "skipped_steps",
      "dismissed_at",
      "completed_at",
      "celebrated_at",
      "welcome_email_last_sent_at",
    ]) {
      expect(CODE, col).toContain(col);
    }
  });

  it("keeps updated_at honest via a BEFORE UPDATE trigger", () => {
    expect(CODE).toMatch(/create or replace function public\.set_studio_onboarding_updated_at/i);
    expect(CODE).toMatch(/before update on public\.studio_onboarding/i);
    expect(CODE).toMatch(/new\.updated_at := now\(\)/i);
  });
});

describe("0140 — Gate 3: RLS is member-read / owner-write, no browser delete", () => {
  it("enables RLS", () => {
    expect(CODE).toMatch(/alter table public\.studio_onboarding enable row level security/i);
  });

  it("members read; only the owner inserts/updates their own row", () => {
    expect(CODE).toMatch(/create policy "studio_onboarding_member_select"[\s\S]*?for select[\s\S]*?is_studio_member\(studio_id\)/i);
    expect(CODE).toMatch(/create policy "studio_onboarding_owner_insert"[\s\S]*?for insert[\s\S]*?is_studio_owner\(studio_id\)/i);
    expect(CODE).toMatch(/create policy "studio_onboarding_owner_update"[\s\S]*?for update[\s\S]*?is_studio_owner\(studio_id\)/i);
    // No member-wide or anon write policy.
    expect(CODE).not.toMatch(/create policy "studio_onboarding[^"]*"[\s\S]*?for (all|delete)/i);
  });

  it("revokes delete/truncate from authenticated and everything from anon", () => {
    expect(CODE).toMatch(/revoke delete, truncate on public\.studio_onboarding from authenticated/i);
    expect(CODE).toMatch(/revoke all on public\.studio_onboarding from anon/i);
  });
});

describe("0140 — Gate 4: trigger functions are execute-locked", () => {
  it("revokes execute from public + anon + authenticated for both trigger fns", () => {
    expect(CODE).toMatch(/revoke execute on function %s from public/i);
    expect(CODE).toMatch(/revoke execute on function %s from anon/i);
    expect(CODE).toMatch(/revoke execute on function %s from authenticated/i);
    expect(CODE).toContain("public.guard_onboarding_flag_activation()");
    expect(CODE).toContain("public.set_studio_onboarding_updated_at()");
  });
});
