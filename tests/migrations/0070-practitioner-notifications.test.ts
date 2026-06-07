import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #164. Migration 0070 creates public.practitioner_notifications
// + indexes + RLS policies. Pin the textual invariants so a future
// refactor that loosens the FK, drops an index, or weakens an RLS
// clause is caught by `npm test`.

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../supabase/migrations/0070_practitioner_notifications.sql",
);
const SOURCE = readFileSync(MIGRATION_PATH, "utf8");

describe("migration 0070 creates practitioner_notifications", () => {
  it("creates the table with `if not exists`", () => {
    expect(SOURCE).toMatch(
      /create table if not exists public\.practitioner_notifications/,
    );
  });

  it("declares the v1 column set", () => {
    for (const col of [
      "id uuid primary key",
      "studio_id uuid not null references public\\.studios",
      "practitioner_id uuid references public\\.practitioners",
      "event_type text not null",
      "title text not null",
      "body text",
      "appointment_id uuid references public\\.appointments",
      "client_id uuid references public\\.clients",
      "href text",
      "read_at timestamptz",
      "created_at timestamptz not null default now\\(\\)",
    ]) {
      expect(SOURCE).toMatch(new RegExp(col));
    }
  });

  it("uses on delete cascade for the studio FK and set null elsewhere", () => {
    expect(SOURCE).toMatch(
      /references public\.studios\(id\) on delete cascade/,
    );
    expect(SOURCE).toMatch(
      /references public\.practitioners\(id\) on delete set null/,
    );
    expect(SOURCE).toMatch(
      /references public\.appointments\(id\) on delete set null/,
    );
    expect(SOURCE).toMatch(
      /references public\.clients\(id\) on delete set null/,
    );
  });

  it("does NOT add a DB CHECK on event_type (validated in the helper)", () => {
    expect(SOURCE).not.toMatch(/check\s*\([^)]*event_type/i);
  });

  it("creates the three secondary indexes (studio, practitioner partial, unread partial)", () => {
    expect(SOURCE).toMatch(
      /create index if not exists practitioner_notifications_studio_created_idx[\s\S]*on public\.practitioner_notifications \(studio_id, created_at desc\)/,
    );
    expect(SOURCE).toMatch(
      /create index if not exists practitioner_notifications_practitioner_created_idx[\s\S]*on public\.practitioner_notifications \(practitioner_id, created_at desc\)[\s\S]*where practitioner_id is not null/,
    );
    expect(SOURCE).toMatch(
      /create index if not exists practitioner_notifications_unread_idx[\s\S]*on public\.practitioner_notifications \(studio_id, created_at desc\)[\s\S]*where read_at is null/,
    );
  });

  it("enables RLS on the new table", () => {
    expect(SOURCE).toMatch(
      /alter table public\.practitioner_notifications enable row level security/,
    );
  });

  it("creates a SELECT policy gated on is_studio_member", () => {
    expect(SOURCE).toMatch(
      /create policy practitioner_notifications_member_read[\s\S]*for select[\s\S]*to authenticated[\s\S]*using \(public\.is_studio_member\(studio_id\)\)/,
    );
  });

  it("creates an UPDATE policy gated on is_studio_member with USING + WITH CHECK", () => {
    expect(SOURCE).toMatch(
      /create policy practitioner_notifications_member_update[\s\S]*for update[\s\S]*to authenticated[\s\S]*using \(public\.is_studio_member\(studio_id\)\)[\s\S]*with check \(public\.is_studio_member\(studio_id\)\)/,
    );
  });

  it("does NOT create an INSERT policy (writes happen via server-only helper)", () => {
    // The grammar shape that would be a problem: `create policy ... for insert`.
    // The shared SELECT/UPDATE policies use `for select` / `for update`; we
    // assert no `for insert` clause exists in the migration body.
    expect(SOURCE).not.toMatch(/create policy[\s\S]*?for insert/i);
  });

  it("documents the verification SQL the operator should run", () => {
    expect(SOURCE).toMatch(/information_schema\.tables/);
    expect(SOURCE).toMatch(/information_schema\.columns/);
    expect(SOURCE).toMatch(/pg_indexes/);
    expect(SOURCE).toMatch(/pg_class/);
    expect(SOURCE).toMatch(/pg_policies/);
  });
});
