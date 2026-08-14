import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Google Calendar: Phase A, migration 0122 (OAuth state + PKCE). Static SQL
// pins: hash-only state + nonce, encrypted PKCE verifier + key version, 10-min
// TTL, single-use consumption support, same-studio binding, default-deny RLS.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0122_google_oauth_state.sql"),
  "utf8",
);

describe("0122: google_oauth_states", () => {
  it("stores state and session nonce HASH-ONLY (sha256 hex CHECK)", () => {
    expect(SQL).toMatch(/state_hash\s+text not null[\s\S]{0,60}check \(state_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/);
    expect(SQL).toMatch(
      /session_nonce_hash\s+text not null[\s\S]{0,80}check \(session_nonce_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/,
    );
  });

  it("encrypts the PKCE verifier and records the key version", () => {
    expect(SQL).toMatch(/encrypted_pkce_verifier\s+text not null/);
    expect(SQL).toMatch(/encryption_key_version\s+integer not null/);
  });

  it("binds to user + practitioner + studio, with a same-studio composite FK", () => {
    expect(SQL).toMatch(/user_id\s+uuid not null references auth\.users \(id\) on delete cascade/);
    expect(SQL).toMatch(
      /foreign key \(practitioner_id, studio_id\)\s*\n?\s*references public\.practitioners \(id, studio_id\)/,
    );
  });

  it("has a 10-minute TTL and single-use consumption column", () => {
    expect(SQL).toMatch(/expires_at\s+timestamptz not null default \(now\(\) \+ interval '10 minutes'\)/);
    expect(SQL).toMatch(/consumed_at\s+timestamptz/);
  });

  it("has a unique index on state_hash (one row per state)", () => {
    expect(SQL).toMatch(
      /create unique index if not exists google_oauth_states_state_hash_uniq\s*\n?\s*on public\.google_oauth_states \(state_hash\)/,
    );
  });

  it("is default-deny: RLS on + explicit REVOKE for browser roles, service-role only", () => {
    expect(SQL).toMatch(/alter table public\.google_oauth_states enable row level security/);
    expect(SQL).toMatch(/revoke all on public\.google_oauth_states from anon/);
    expect(SQL).toMatch(/revoke all on public\.google_oauth_states from authenticated/);
    expect(SQL).toMatch(/revoke all on public\.google_oauth_states from public/);
    expect(SQL).toMatch(/grant [\w, ]*on public\.google_oauth_states to service_role/);
    expect(SQL).not.toMatch(/create policy[\s\S]{0,120}on public\.google_oauth_states/);
  });

  it("is additive only (no drops/alters of existing objects)", () => {
    expect(SQL).not.toMatch(/drop table/i);
    expect(SQL).not.toMatch(/drop column/i);
    expect(SQL).not.toMatch(/alter table public\.(appointments|studios|practitioners)/i);
  });
});
