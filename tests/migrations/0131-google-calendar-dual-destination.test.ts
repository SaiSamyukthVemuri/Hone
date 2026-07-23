import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Static proof for migration 0131 (Google Calendar B2.4 dual-destination scope
// contract). It asserts the migration is ADDITIVE + DORMANT, evolves the scope
// seam destination-aware, is fail-closed against the empty-array containment trap,
// and touches no sync flag / worker / event / outbox / link / backfill.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0131_google_calendar_dual_destination.sql"),
  "utf8",
);

describe("0131 — repo migration-max tripwire", () => {
  // INTEGRATION RESOLUTION (RC branch): the integrated release candidate carries
  // the FULL union of both stacks — capacity 0135-0139 (PR B) + 0142-0150 (Part 4)
  // AND onboarding 0140-0141 (PR #459). Unlike either source branch, 0140 IS
  // present here. Neither source side was correct for the combined repo: #460
  // asserted 0140 absent; #459 asserted 0135-0139/0142+ absent. This union asserts
  // the complete 0132-0150 chain and trips only on 0151+.
  it("advances the repo migration max to 0151 (integrated RC + RC hardening: appointment tenant consistency)", () => {
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const nums = files
      .map((f) => /^(\d{4})_.*\.sql$/.exec(f))
      .filter(Boolean)
      .map((m) => (m as RegExpExecArray)[1])
      .sort();
    expect(nums[nums.length - 1]).toBe("0151"); // 0151 = appointment tenant-consistency composite FKs (RC hardening)
    expect(files.some((f) => f.startsWith("0132_"))).toBe(true);
    expect(files.some((f) => f.startsWith("0133_"))).toBe(true);
    expect(files.some((f) => f.startsWith("0134_"))).toBe(true);
    // Capacity PR B stack (0135-0139).
    expect(files.some((f) => f.startsWith("0135_"))).toBe(true);
    expect(files.some((f) => f.startsWith("0136_"))).toBe(true);
    expect(files.some((f) => f.startsWith("0137_"))).toBe(true);
    expect(files.some((f) => f.startsWith("0138_"))).toBe(true);
    expect(files.some((f) => f.startsWith("0139_"))).toBe(true);
    // Onboarding v2 (0140 foundation + 0141 invitation reconciliation) — PRESENT
    // in the integrated RC (this is the union that neither source branch had).
    expect(files.some((f) => f.startsWith("0140_"))).toBe(true);
    expect(files.some((f) => f.startsWith("0141_"))).toBe(true);
    // Capacity Part 4 internal-booking stack (0142-0150).
    expect(files.some((f) => f.startsWith("0142_"))).toBe(true);
    expect(files.some((f) => f.startsWith("0143_"))).toBe(true);
    expect(files.some((f) => f.startsWith("0144_"))).toBe(true);
    expect(files.some((f) => f.startsWith("0145_"))).toBe(true);
    expect(files.some((f) => f.startsWith("0146_"))).toBe(true);
    expect(files.some((f) => f.startsWith("0147_"))).toBe(true);
    expect(files.some((f) => f.startsWith("0148_"))).toBe(true);
    expect(files.some((f) => f.startsWith("0149_"))).toBe(true);
    expect(files.some((f) => f.startsWith("0150_"))).toBe(true);
    // RC hardening: appointment tenant-consistency composite FKs.
    expect(files.some((f) => f.startsWith("0151_"))).toBe(true);
    // Nothing 0152+ yet. Bump this tripwire consciously when adding migrations.
    expect(files.filter((f) => /^01(5[2-9]|[6-9]\d)_/.test(f))).toEqual([]);
  });
});

describe("0131 — additive + dormant", () => {
  it("only ADDs nullable columns to calendar_connections (no destructive DDL)", () => {
    expect(SQL).toMatch(/add column if not exists destination_mode text/);
    expect(SQL).toMatch(/add column if not exists selected_calendar_display_name text/);
    expect(SQL).toMatch(/add column if not exists destination_configured_at timestamptz/);
    expect(SQL).toMatch(/add column if not exists destination_ownership_validated_at timestamptz/);
    expect(SQL).toMatch(/add column if not exists app_created_calendar_id text/);
    // No dropping of a data column / table.
    expect(SQL).not.toMatch(/drop\s+table/i);
    expect(SQL).not.toMatch(/drop\s+column/i);
    expect(SQL).not.toMatch(/truncate/i);
  });

  it("performs NO destination backfill / DML on existing rows", () => {
    // Only constraint drops (idempotent) + column adds + function replaces.
    expect(SQL).not.toMatch(/update\s+public\.calendar_connections\s+set/i);
    expect(SQL).not.toMatch(/insert\s+into\s+public\.calendar_connections/i);
  });

  it("changes NO sync flag / worker control / outbox / link / appointment", () => {
    // The readiness predicate READS the studio outbound flag (allowed); the
    // migration must not ENABLE/change any flag, the worker control, or any queue.
    expect(SQL).not.toMatch(/_sync_enabled\s*=\s*true/i);
    expect(SQL).not.toMatch(/update\s+public\.studios\s+set/i);
    expect(SQL).not.toMatch(/worker_enabled\s*=\s*true/i);
    expect(SQL).not.toMatch(/update\s+public\.calendar_sync_control/i);
    expect(SQL).not.toMatch(/insert\s+into\s+public\.calendar_sync_outbox/i);
    expect(SQL).not.toMatch(/insert\s+into\s+public\.calendar_event_links/i);
    expect(SQL).not.toMatch(/update\s+public\.appointments/i);
  });
});

describe("0131 — destination constraints", () => {
  it("constrains destination_mode to the two known modes or NULL", () => {
    expect(SQL).toMatch(/destination_mode is null[\s\S]*?in \('dedicated_app_created', 'existing_owned'\)/);
  });
  it("keeps provenance mode-consistent and mutually exclusive (NULL-safe / fail-closed)", () => {
    expect(SQL).toMatch(/app_created_calendar_id is null[\s\S]*?coalesce\(destination_mode, ''\) = 'dedicated_app_created'/);
    expect(SQL).toMatch(/destination_ownership_validated_at is null[\s\S]*?coalesce\(destination_mode, ''\) = 'existing_owned'/);
    expect(SQL).toMatch(/not \(app_created_calendar_id is not null[\s\S]*?destination_ownership_validated_at is not null\)/);
  });
  it("requires a write target once configured", () => {
    expect(SQL).toMatch(/destination_configured_at is null or write_calendar_id is not null/);
  });
});

describe("0131 — destination-aware scope contract", () => {
  it("adds the 1-arg destination-aware function with exact maps", () => {
    expect(SQL).toMatch(/calendar_required_event_scopes\(p_destination_mode text\)/);
    expect(SQL).toMatch(/when 'dedicated_app_created' then[\s\S]*?calendar\.app\.created/);
    expect(SQL).toMatch(/when 'existing_owned' then[\s\S]*?calendar\.events\.owned/);
  });
  it("returns NULL (never an empty array) for invalid/unset modes", () => {
    expect(SQL).toMatch(/else null::text\[\]/);
    expect(SQL).not.toMatch(/else\s+array\[\]::text\[\]/);
  });
  it("the legacy 0-arg function returns NULL, never the old universal scope or an empty array", () => {
    // 0-arg body: select null::text[]
    expect(SQL).toMatch(/calendar_required_event_scopes\(\)\s*[\s\S]*?select null::text\[\]/);
    // It must NOT still return the universal owned scope from the 0-arg body.
    const zeroArgBlock = SQL.slice(SQL.indexOf("calendar_required_event_scopes()\nreturns"));
    expect(zeroArgBlock).not.toMatch(/calendar_required_event_scopes\(\)\s*returns text\[\][\s\S]*?array\['https/);
  });
  it("both scope functions are service-role only (revoked from browser roles)", () => {
    expect(SQL).toMatch(/revoke all on function public\.calendar_required_event_scopes\(text\) from public, anon, authenticated/);
    expect(SQL).toMatch(/grant execute on function public\.calendar_required_event_scopes\(text\) to service_role/);
  });
});

describe("0131 — readiness predicate is destination-aware + empty-array fail-closed", () => {
  it("rewrites calendar_connection_outbound_ready to use the destination mode", () => {
    expect(SQL).toMatch(/calendar_connection_outbound_ready/);
    expect(SQL).toMatch(/c\.destination_mode is not null/);
    expect(SQL).toMatch(/public\.calendar_required_event_scopes\(c\.destination_mode\)/);
  });
  it("guards against the @> empty-array fail-open trap (NULL + cardinality checks)", () => {
    expect(SQL).toMatch(/calendar_required_event_scopes\(c\.destination_mode\) is not null/);
    expect(SQL).toMatch(/cardinality\(public\.calendar_required_event_scopes\(c\.destination_mode\)\) >= 1/);
    expect(SQL).toMatch(/granted_scopes @> public\.calendar_required_event_scopes\(c\.destination_mode\)/);
  });
  it("keeps the readiness signature (uuid, uuid) so claim RPC / view pick it up unchanged", () => {
    expect(SQL).toMatch(/calendar_connection_outbound_ready\(\s*p_connection_id uuid, p_studio_id uuid\)/);
  });
});

describe("0131 — Stage 2 amendment: dedicated provisioning-state (additive + dormant)", () => {
  it("adds the three nullable provisioning-state columns to calendar_connections", () => {
    expect(SQL).toMatch(/add column if not exists destination_provisioning_attempt_token text/);
    expect(SQL).toMatch(/add column if not exists destination_provisioning_started_at timestamptz/);
    expect(SQL).toMatch(/add column if not exists destination_provisioning_ambiguous_at timestamptz/);
  });
  it("guards provisioning-state to the dedicated mode only (NULL-safe / fail-closed)", () => {
    expect(SQL).toMatch(/calendar_connections_provisioning_mode_chk/);
    expect(SQL).toMatch(/destination_provisioning_attempt_token is null[\s\S]*?coalesce\(destination_mode, ''\) = 'dedicated_app_created'/);
  });
  it("stores NO token/secret/PHI — the attempt token is a random NON-SENSITIVE reconciliation marker", () => {
    // Scope to the provisioning-state section only (section 4's readiness predicate
    // legitimately READS sec.encrypted_refresh_token existence — not a stored secret).
    const provBlock = SQL.slice(
      SQL.indexOf("5) DEDICATED-destination provisioning-state"),
      SQL.indexOf("6) Destination-BOUND OAuth state"),
    );
    expect(provBlock).toMatch(/destination_provisioning_attempt_token/);
    expect(provBlock).not.toMatch(/refresh_token|access_token|encrypted_/i);
  });
});

describe("0131 — Stage 2 amendment: destination-bound OAuth state (additive + dormant)", () => {
  it("adds the destination binding columns to google_oauth_states", () => {
    expect(SQL).toMatch(/alter table public\.google_oauth_states[\s\S]*?add column if not exists destination_mode text/);
    expect(SQL).toMatch(/add column if not exists required_event_scope text/);
  });
  it("constrains the bound mode to the two known modes or NULL", () => {
    expect(SQL).toMatch(/google_oauth_states_destination_mode_chk/);
    expect(SQL).toMatch(/destination_mode is null[\s\S]*?in \('dedicated_app_created', 'existing_owned'\)/);
  });
  it("binds destination mode + required scope as a matched pair (both or neither)", () => {
    expect(SQL).toMatch(/google_oauth_states_destination_pair_chk/);
    expect(SQL).toMatch(/\(destination_mode is null\) = \(required_event_scope is null\)/);
  });
  it("does NOT weaken google_oauth_states default-deny (no new browser grant/policy here)", () => {
    // The 0122 RLS/REVOKE posture is untouched; the amendment adds columns only.
    const stateBlock = SQL.slice(SQL.indexOf("alter table public.google_oauth_states"));
    expect(stateBlock).not.toMatch(/grant .* to (anon|authenticated|public)/i);
    expect(stateBlock).not.toMatch(/create policy|enable row level security/i);
  });
});
