import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0113_admin_action_events.sql";
const SQL = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");

describe("0113 — number (repo-max tripwire)", () => {
  it("is the repo migration max", () => {
    const maxNum = Math.max(
      ...readdirSync(MIGRATIONS_DIR)
        .map((f) => /^(\d{4})_.*\.sql$/.exec(f))
        .filter(Boolean)
        .map((m) => Number((m as RegExpExecArray)[1])),
    );
    expect(maxNum).toBe(113);
    expect(FILE).toMatch(/^0113_/);
  });
});

describe("0113 — admin_action_events table", () => {
  it("creates the table with the who/what/where/when/outcome columns", () => {
    expect(SQL).toMatch(/create table if not exists public\.admin_action_events/);
    expect(SQL).toMatch(/actor_user_id uuid/);
    expect(SQL).toMatch(/actor_email text/);
    expect(SQL).toMatch(/studio_id uuid/);
    expect(SQL).toMatch(/target_type text not null/);
    expect(SQL).toMatch(/action text not null/);
    expect(SQL).toMatch(/metadata jsonb not null default '\{\}'::jsonb/);
  });
  it("constrains outcome to started/succeeded/failed/blocked", () => {
    expect(SQL).toMatch(
      /check \(outcome in \('started', 'succeeded', 'failed', 'blocked'\)\)/,
    );
  });
  it("RLS enabled with NO policies (service-role-only; append-only) + write grants revoked", () => {
    expect(SQL).toMatch(/enable row level security/);
    expect(SQL).not.toMatch(/create policy/i);
    expect(SQL).not.toMatch(/for (select|insert|update|delete|all)/i);
    expect(SQL).toMatch(/revoke insert, update, delete, truncate/);
  });
  it("has NO foreign key (audit durability) and NO column for any secret/PII", () => {
    // durability: no FK on studio_id / actor / target (event survives referenced-row deletion)
    expect(SQL).not.toMatch(/references public\./i);
    // no secret/PII columns
    expect(SQL).not.toMatch(/\n\s*\w*(token|secret|password|api_key|card|cvc|cvv|cookie|jwt|magic|url|authorization)\w*\s+(uuid|text|jsonb|inet|bytea|boolean)/i);
    expect(SQL).not.toMatch(/\n\s*\w*(intake|clinical|diagnosis|treatment_note)\w*\s+\w+/i);
  });
  it("is additive only — no drop, no data backfill", () => {
    expect(SQL).not.toMatch(/drop table|drop column/i);
    expect(SQL).not.toMatch(/update public\.\w+ set|insert into public\.admin_action_events/i);
  });
});
