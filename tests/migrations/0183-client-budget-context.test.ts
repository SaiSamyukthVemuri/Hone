import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  countVersion,
  fileForVersion,
  isRepoMax,
  migrationState,
  versionsAbove,
} from "./helpers/migration-state";
import { CLIENT_BUDGET_LEVELS } from "@/lib/budget/levels";

// 0183 — client_budget_context.
//
// Source contract for a purely ADDITIVE migration: one new table, its
// constraints, indexes, triggers, RLS and grants. The load-bearing properties
// are (a) one row per client STRUCTURALLY, (b) studio_id is never
// caller-authored, (c) no client-facing role can reach the table, and
// (d) nothing in this file touches treatment_plans.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0183";
const SQL = readFileSync(
  path.join(ROOT, "supabase/migrations", fileForVersion(VERSION)),
  "utf8",
);
// Comments in this migration deliberately discuss what it does NOT do
// ("does NOT drop treatment_plans.budget_notes"), so every negative assertion
// below runs against executable SQL only.
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

describe("0183: file and numbering", () => {
  it("is the repository maximum and carries the version exactly once", () => {
    expect(isRepoMax(VERSION)).toBe(true);
    expect(countVersion(VERSION)).toBe(1);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("is NOT yet applied to production — hosted state is declared, not derived", () => {
    // Written to go RED the moment the rollout runs, so the apply cannot be
    // recorded without updating docs/production/migration-state.json in the
    // same change. A file on disk says nothing about what production has
    // applied; this reads the DECLARED record.
    const state = migrationState();
    expect(state.hosted_migration_max).toBe("0182");
    expect(state.pending_migrations).toContain(VERSION);
    expect(state.repo_equals_hosted).toBe(false);
  });

  it("never reintroduces 0158, which is permanently skipped", () => {
    expect(countVersion("0158")).toBe(0);
  });

  it("opens its own transaction with a bounded lock timeout", () => {
    // `supabase db push` does not wrap a file in a transaction, so a bare
    // SET LOCAL would emit 25P01 and never arm.
    expect(CODE).toMatch(/^begin;/m);
    expect(CODE).toMatch(/^commit;/m);
    const beginIdx = CODE.indexOf("begin;");
    const lockIdx = CODE.indexOf("set local lock_timeout");
    expect(lockIdx).toBeGreaterThan(beginIdx);
    expect(CODE).toMatch(/set local lock_timeout = '5s';/);
  });

  it("is re-runnable", () => {
    expect(CODE).toContain("create table if not exists public.client_budget_context");
    expect(CODE).toMatch(/drop policy if exists/);
    expect(CODE).toMatch(/drop trigger if exists/);
    expect(CODE).toMatch(/drop constraint if exists/);
  });
});

describe("0183: one row per client, structurally", () => {
  it("makes client_id the PRIMARY KEY — not a unique index bolted on later", () => {
    expect(CODE).toMatch(/client_id uuid primary key,/);
  });

  it("carries the composite tenant-consistency FK to clients (id, studio_id)", () => {
    // The same pattern as client_clinical_notes (0126) / appointments (0151).
    // It makes a row whose studio disagrees with its client's studio
    // structurally unrepresentable, which RLS alone cannot achieve for a
    // practitioner holding memberships in BOTH studios.
    expect(CODE).toMatch(
      /foreign key \(client_id, studio_id\)\s*\n\s*references public\.clients \(id, studio_id\) on delete cascade/,
    );
  });

  it("has no surrogate id column that could permit a second row", () => {
    expect(CODE).not.toMatch(/^\s*id uuid primary key/m);
    expect(CODE).not.toMatch(/gen_random_uuid\(\)/);
  });

  it("cascades from the parent client and studio", () => {
    // The client side cascades through the composite FK asserted above.
    expect(CODE).toContain(
      "references public.clients (id, studio_id) on delete cascade",
    );
    expect(CODE).toContain("references public.studios(id) on delete cascade");
  });

  it("keeps the practitioner stamp nullable via on delete set null", () => {
    expect(CODE).toMatch(
      /updated_by_practitioner_id uuid\s*\n\s*references public\.practitioners\(id\) on delete set null/,
    );
  });
});

describe("0183: the level vocabulary matches the application exactly", () => {
  it("constrains budget_level to the same three values as lib/budget/levels.ts", () => {
    const check = CODE.slice(
      CODE.indexOf("client_budget_context_level_check"),
    );
    for (const level of CLIENT_BUDGET_LEVELS) {
      expect(check).toContain(`'${level}'`);
    }
    // And nothing else: extract the quoted values from the IN list.
    const inList = /budget_level in \(([^)]*)\)/.exec(check);
    expect(inList).not.toBeNull();
    const values = [...(inList?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map(
      (m) => m[1],
    );
    expect(values.sort()).toEqual([...CLIENT_BUDGET_LEVELS].sort());
  });

  it("permits NULL — 'no broad level recorded' is a legitimate state", () => {
    expect(CODE).toMatch(/budget_level is null\s*\n?\s*or budget_level in/);
    // The column itself must not be NOT NULL.
    expect(CODE).not.toMatch(/budget_level text not null/);
  });

  it("never invented an 'unlimited' level", () => {
    expect(CODE).not.toMatch(/'unlimited'/);
  });

  it("bounds the free text at the client_personal_notes ceiling", () => {
    expect(CODE).toContain("check (length(budget_notes) <= 20000)");
    expect(CODE).toContain("budget_notes text not null default ''");
  });

  it("does NOT couple the level to the notes", () => {
    // Either may exist without the other; a CHECK requiring one when the
    // other is present would make the UI's independent controls unusable.
    expect(CODE).not.toMatch(/budget_level is not null and .*budget_notes/);
    expect(CODE).not.toMatch(/budget_notes <> '' and .*budget_level/);
  });
});

describe("0183: studio_id is derived, never caller-authored", () => {
  it("fires the trigger on EVERY insert and update, not just on client_id", () => {
    expect(CODE).toMatch(
      /create trigger client_budget_context_set_studio_id\s*\n\s*before insert or update\s*\n/,
    );
    // `update of client_id` would leave a studio_id-only UPDATE unguarded.
    expect(CODE).not.toMatch(/before insert or update of client_id/);
  });

  it("the trigger reads studio_id from the parent clients row", () => {
    const fn = CODE.slice(
      CODE.indexOf("function public.client_budget_context_set_studio_id()"),
    );
    expect(fn).toMatch(
      /select studio_id into new\.studio_id\s*\n\s*from public\.clients\s*\n\s*where id = new\.client_id;/,
    );
    // An unknown client is an exception, not a silent NULL.
    expect(fn).toContain("raise exception");
  });

  it("pins the trigger function's search_path", () => {
    const fn = CODE.slice(
      CODE.indexOf("function public.client_budget_context_set_studio_id()"),
    );
    expect(fn.slice(0, 300)).toContain("set search_path = pg_catalog, pg_temp");
  });

  it("maintains updated_at by trigger, not by the caller", () => {
    expect(CODE).toMatch(
      /create trigger client_budget_context_set_updated_at\s*\n\s*before update on public\.client_budget_context/,
    );
    expect(CODE).toContain("execute function public.set_updated_at()");
  });
});

describe("0183: RLS and grants", () => {
  it("enables RLS", () => {
    expect(CODE).toContain(
      "alter table public.client_budget_context enable row level security",
    );
  });

  it("gates select, insert and update on studio membership, for authenticated", () => {
    for (const op of ["select", "insert", "update"]) {
      expect(CODE).toMatch(
        new RegExp(`for ${op} to authenticated`),
      );
    }
    expect(CODE).toMatch(/using \(public\.is_studio_member\(studio_id\)\)/);
    expect(CODE).toMatch(/with check \(public\.is_studio_member\(studio_id\)\)/);
  });

  it("the UPDATE policy carries BOTH using and with check", () => {
    const pol = CODE.slice(
      CODE.indexOf('create policy "client_budget_context_member_update"'),
    ).slice(0, 400);
    expect(pol).toContain("using (public.is_studio_member(studio_id))");
    expect(pol).toContain("with check (public.is_studio_member(studio_id))");
  });

  it("has NO delete policy — clearing is an UPDATE, not a row removal", () => {
    expect(CODE).not.toMatch(/for delete/);
  });

  it("revokes from anon AND service_role explicitly BY NAME", () => {
    // Supabase's ALTER DEFAULT PRIVILEGES grants to all three roles at create
    // time. This was missed in 0129 (anon) and again in 0164 (service_role).
    expect(CODE).toContain(
      "revoke all on public.client_budget_context from anon",
    );
    expect(CODE).toContain(
      "revoke all on public.client_budget_context from service_role",
    );
  });

  it("grants authenticated exactly select/insert/update and revokes delete/truncate", () => {
    expect(CODE).toContain(
      "grant select, insert, update on public.client_budget_context to authenticated",
    );
    expect(CODE).toContain(
      "revoke delete, truncate on public.client_budget_context from authenticated",
    );
  });

  it("grants NOTHING to service_role", () => {
    expect(CODE).not.toMatch(/grant [^;]*on public\.client_budget_context to service_role/);
  });
});

describe("0183: additive only — no data loss", () => {
  it("issues no DDL or DML against treatment_plans", () => {
    // The table IS named once, in the COMMENT prose that records why the
    // legacy column was left alone — that reference is the point, so this
    // asserts on statements rather than on the substring.
    const statements = CODE.replace(/'[^']*'/g, "''");
    expect(statements).not.toMatch(/treatment_plans/);
    expect(CODE).not.toMatch(/alter table[^;]*treatment_plans/i);
    expect(CODE).not.toMatch(/(from|into|update)\s+public\.treatment_plans/i);
  });

  it("still says WHY the legacy column was not backfilled", () => {
    expect(SQL).toMatch(/NOT backfilled|NO backfill/);
    expect(SQL).toContain("treatment_plans.budget_notes");
  });

  it("performs no backfill and no row mutation whatsoever", () => {
    expect(CODE).not.toMatch(/\binsert into\b/i);
    expect(CODE).not.toMatch(/\bupdate\s+public\./i);
    expect(CODE).not.toMatch(/\bdelete from\b/i);
  });

  it("drops nothing that holds data", () => {
    expect(CODE).not.toMatch(/drop table/i);
    expect(CODE).not.toMatch(/drop column/i);
    expect(CODE).not.toMatch(/alter table [^\n]*drop (?!constraint)/i);
  });

  it("touches no payment or scheduling object", () => {
    for (const forbidden of [
      "appointments",
      "appointment_payments",
      "payment_charge_attempts",
      "stripe",
      "sessions",
    ]) {
      expect(CODE.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("documents the table and the level column", () => {
    expect(CODE).toContain("comment on table public.client_budget_context is");
    expect(CODE).toContain(
      "comment on column public.client_budget_context.budget_level is",
    );
  });
});
