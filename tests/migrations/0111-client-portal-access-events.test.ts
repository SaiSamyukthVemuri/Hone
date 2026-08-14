import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0111_client_portal_access_events.sql";
const SQL = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");

describe("0111: number", () => {
  it("is migration 0111 (repo-max tripwire now lives in the newest migration test, 0112)", () => {
    expect(FILE).toMatch(/^0111_/);
  });
});

describe("0111: client_portal_access_events table", () => {
  it("creates the table with the safe id/scope/event columns", () => {
    expect(SQL).toMatch(/create table if not exists public\.client_portal_access_events/);
    expect(SQL).toMatch(/studio_id uuid not null/);
    expect(SQL).toMatch(/client_id uuid not null/);
    expect(SQL).toMatch(/practitioner_id uuid/);
    expect(SQL).toMatch(/event_type text not null/);
    expect(SQL).toMatch(/metadata jsonb not null default '\{\}'::jsonb/);
  });
  it("constrains event_type + channel to an allowlist", () => {
    expect(SQL).toMatch(/portal_link_sent/);
    expect(SQL).toMatch(/portal_link_rate_limited/);
    expect(SQL).toMatch(/portal_magic_link_consumed/);
    expect(SQL).toMatch(/channel is null or channel in/);
  });
  it("enforces same-studio tenant isolation via a composite FK to clients", () => {
    expect(SQL).toMatch(
      /foreign key \(studio_id, client_id\)\s*\n?\s*references public\.clients \(studio_id, id\) on delete cascade/,
    );
  });
  it("has NO column for any secret/PII (token, url, ip, email, clinical, payment)", () => {
    // Guard the COLUMN DECLARATIONS (name followed by a type), not comments or
    // the event_type allowlist values (which legitimately contain 'magic_link').
    expect(SQL).not.toMatch(
      /\n\s*\w*(token|email|ip_hash|ip_address|user_agent|url|card|stripe|payment|intake|clinical|diagnosis)\w*\s+(uuid|text|jsonb|inet|bytea|boolean|timestamptz)/i,
    );
  });
  it("RLS: enabled, SELECT-only for studio members, NO insert/update/delete policy", () => {
    expect(SQL).toMatch(/enable row level security/);
    expect(SQL).toMatch(/for select to authenticated\s*\n?\s*using \(public\.is_studio_member\(studio_id\)\)/);
    expect(SQL).not.toMatch(/for insert|for update|for delete|for all/i);
    // append-only: write grants stripped from normal roles
    expect(SQL).toMatch(/revoke insert, update, delete, truncate/);
  });
  it("is additive only: no drop column, no data backfill", () => {
    expect(SQL).not.toMatch(/drop column|drop table/i);
    expect(SQL).not.toMatch(/update public\.\w+ set/i);
  });
});
