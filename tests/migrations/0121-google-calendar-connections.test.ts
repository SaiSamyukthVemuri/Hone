import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Google Calendar: Phase A, migration 0121 (connection foundation). Static SQL
// pins: additive + dormant, default-OFF flags, same-studio composite FKs, the
// one-connection / one-owner uniques, and the browser-inaccessible secret table.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0121_google_calendar_connection_foundation.sql"),
  "utf8",
);

describe("0121: studio feature flags (all default OFF)", () => {
  it("adds the four Google Calendar flags, all NOT NULL DEFAULT false", () => {
    for (const flag of [
      "google_calendar_connection_enabled",
      "google_calendar_outbound_sync_enabled",
      "google_calendar_inbound_busy_enabled",
      "google_calendar_two_way_updates_enabled",
    ]) {
      expect(SQL).toMatch(
        new RegExp(`add column if not exists ${flag}\\s+boolean not null default false`),
      );
    }
  });

  it("is additive on studios (add column if not exists), never dropping/altering existing columns", () => {
    expect(SQL).toMatch(/alter table public\.studios\s+add column if not exists/);
    expect(SQL).not.toMatch(/drop column/i);
    expect(SQL).not.toMatch(/drop table/i);
  });
});

describe("0121: calendar_connections", () => {
  it("is created with the required non-secret columns incl. is_studio_calendar_owner", () => {
    expect(SQL).toMatch(/create table if not exists public\.calendar_connections/);
    for (const col of [
      "studio_id",
      "practitioner_id",
      "provider",
      "google_account_id",
      "google_account_email",
      "write_calendar_id",
      "connection_status",
      "granted_scopes",
      "token_expires_at",
      "last_successful_auth_at",
      "is_studio_calendar_owner",
    ]) {
      expect(SQL).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it("uses ONE owner-designation boolean (is_studio_calendar_owner), not a second is_write_target", () => {
    expect(SQL).toMatch(/is_studio_calendar_owner\s+boolean not null default false/);
    expect(SQL).not.toMatch(/is_write_target/);
  });

  it("constrains connection_status to a known set", () => {
    expect(SQL).toMatch(
      /connection_status[\s\S]{0,120}check \(connection_status in\s*\n?\s*\('disconnected','connected','reconnect_required','revoked','error'\)\)/,
    );
  });

  it("enforces same-studio via a composite FK to practitioners(id, studio_id)", () => {
    expect(SQL).toMatch(
      /foreign key \(practitioner_id, studio_id\)\s*\n?\s*references public\.practitioners \(id, studio_id\)/,
    );
  });

  it("allows one connection per practitioner + a companion (id, studio_id) unique for children", () => {
    expect(SQL).toMatch(/unique \(practitioner_id\)/);
    expect(SQL).toMatch(/unique \(id, studio_id\)/);
  });

  it("enforces at most one active studio calendar owner per studio (partial unique)", () => {
    expect(SQL).toMatch(
      /create unique index if not exists calendar_connections_one_owner_per_studio\s*\n?\s*on public\.calendar_connections \(studio_id\)\s*\n?\s*where is_studio_calendar_owner/,
    );
  });

  it("enables RLS and grants members SELECT of NON-SECRET metadata only (no write policy)", () => {
    expect(SQL).toMatch(/alter table public\.calendar_connections enable row level security/);
    expect(SQL).toMatch(
      /create policy calendar_connections_member_select[\s\S]{0,160}using \(public\.is_studio_member\(studio_id\)\)/,
    );
    // No authenticated write policy on this table (service-role only).
    expect(SQL).not.toMatch(/on public\.calendar_connections\s+for (insert|update|delete)/);
  });
});

describe("0121: calendar_connection_secrets (browser-inaccessible ciphertext)", () => {
  it("holds the encrypted refresh token + key version, and NOT token expiry", () => {
    expect(SQL).toMatch(/create table if not exists public\.calendar_connection_secrets/);
    expect(SQL).toMatch(/encrypted_refresh_token\s+text/);
    expect(SQL).toMatch(/encryption_key_version\s+integer not null/);
    // Token expiry is operational metadata on calendar_connections, NOT here.
    const secretBlock =
      SQL.slice(SQL.indexOf("create table if not exists public.calendar_connection_secrets")) || "";
    expect(secretBlock).not.toMatch(/access_token_expires_at/);
    expect(secretBlock).not.toMatch(/token_expires_at/);
  });

  it("has RLS on + NO browser policy + explicit REVOKE (default-deny)", () => {
    expect(SQL).toMatch(/alter table public\.calendar_connection_secrets enable row level security/);
    expect(SQL).toMatch(/revoke all on public\.calendar_connection_secrets from anon/);
    expect(SQL).toMatch(/revoke all on public\.calendar_connection_secrets from authenticated/);
    expect(SQL).toMatch(/revoke all on public\.calendar_connection_secrets from public/);
    expect(SQL).toMatch(/grant [\w, ]*on public\.calendar_connection_secrets to service_role/);
    // No SELECT/INSERT/UPDATE/DELETE policy for browser roles on the secret table.
    expect(SQL).not.toMatch(/create policy[\s\S]{0,120}on public\.calendar_connection_secrets/);
  });

  it("blocks cross-studio attachment via a same-studio composite FK", () => {
    expect(SQL).toMatch(
      /foreign key \(connection_id, studio_id\)\s*\n?\s*references public\.calendar_connections \(id, studio_id\)/,
    );
  });
});

describe("0121: no event-sync tables (Phase A scope)", () => {
  it("does NOT create any later-phase sync tables", () => {
    for (const table of [
      "calendar_event_links",
      "external_calendar_busy_events",
      "calendar_outbox",
      "calendar_sync_outbox",
      "google_push_notifications",
    ]) {
      expect(SQL).not.toMatch(new RegExp(`create table[^;]*${table}`));
    }
  });
});
