import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Google Calendar — Phase B, PR B1. Static SQL pins for migration 0124: the
// dormant outbound-sync schema + queue foundation. Proves the shape, the
// four-state model, the constraints/indexes, RLS/grants, the trusted RPC posture
// incl. the stale-lease dead transition, and that NO behavior is introduced.

const DIR = join(process.cwd(), "supabase/migrations");
const FILE = "0124_google_calendar_outbound_sync_foundation.sql";
const SQL = readFileSync(join(DIR, FILE), "utf8");

describe("0124 — migration identity + additive/dormant", () => {
  it("advances the repo migration max to 0124 with a purpose-encoding filename", () => {
    const max = Math.max(
      ...readdirSync(DIR)
        .map((f) => /^(\d{4})_.*\.sql$/.exec(f))
        .filter(Boolean)
        .map((m) => Number((m as RegExpExecArray)[1])),
    );
    expect(max).toBe(124);
    expect(FILE).toMatch(/^0124_.*outbound_sync.*\.sql$/);
  });

  it("introduces NO behavior: no trigger on appointments/blocks, no appointment RPC, no availability", () => {
    expect(SQL).not.toMatch(/create (or replace )?trigger[\s\S]{0,80}on public\.(appointments|studio_timed_blocks|studio_calendar_reservations)/i);
    expect(SQL).not.toMatch(/create or replace function public\.(reschedule_appointment|finalize_session|mark_appointment_)/);
    expect(SQL).not.toMatch(/create or replace function public\.getavailable|slots/i);
    // No later-phase tables.
    expect(SQL).not.toMatch(/create table[^;]*external_calendar_busy_events/);
    expect(SQL).not.toMatch(/create table[^;]*watch_channel/);
    // Additive only.
    expect(SQL).not.toMatch(/drop table/i);
    expect(SQL).not.toMatch(/\bupdate public\.(appointments|studio_timed_blocks|studios)\b/i);
    expect(SQL).not.toMatch(/\binsert into public\.(appointments|studio_timed_blocks)\b/i);
  });
});

describe("0124 — calendar_event_links", () => {
  it("exists, polymorphic (no FK to appointments/blocks), same-studio composite FK RESTRICT", () => {
    expect(SQL).toMatch(/create table if not exists public\.calendar_event_links/);
    expect(SQL).toMatch(/hone_entity_type\s+text not null[\s\S]{0,80}check \(hone_entity_type in \('appointment','timed_block'\)\)/);
    // NO direct FK from hone_entity_id to the entity tables.
    expect(SQL).not.toMatch(/hone_entity_id[\s\S]{0,60}references public\.(appointments|studio_timed_blocks)/);
    expect(SQL).toMatch(/foreign key \(connection_id, studio_id\)\s*\n?\s*references public\.calendar_connections \(id, studio_id\) on delete restrict/);
  });

  it("has the active-entity + active-google-event partial uniques", () => {
    expect(SQL).toMatch(/create unique index[\s\S]{0,120}calendar_event_links_active_entity_uniq[\s\S]{0,120}\(studio_id, hone_entity_type, hone_entity_id\)\s*\n?\s*where deleted_at is null/);
    expect(SQL).toMatch(/calendar_event_links_active_google_event_uniq[\s\S]{0,140}where google_event_id is not null and deleted_at is null/);
  });

  it("constrains sync_status + source_system + last_sync_direction", () => {
    expect(SQL).toMatch(/check \(sync_status in \('pending','synced','conflict','error','deleted'\)\)/);
    expect(SQL).toMatch(/check \(source_system in \('hone','google'\)\)/);
    expect(SQL).toMatch(/last_sync_direction in \('hone_to_google','google_to_hone'\)/);
  });

  it("RLS on + member SELECT policy + browser writes revoked", () => {
    expect(SQL).toMatch(/alter table public\.calendar_event_links enable row level security/);
    expect(SQL).toMatch(/create policy calendar_event_links_member_select[\s\S]{0,140}using \(public\.is_studio_member\(studio_id\)\)/);
    expect(SQL).toMatch(/revoke insert, update, delete on public\.calendar_event_links from authenticated/);
    expect(SQL).toMatch(/revoke insert, update, delete on public\.calendar_event_links from anon/);
  });
});

describe("0124 — calendar_sync_outbox (four-state + constraints)", () => {
  it("uses EXACTLY the four-state model (no 'failed')", () => {
    expect(SQL).toMatch(/check \(status in \('pending','processing','done','dead'\)\)/);
    expect(SQL).not.toMatch(/'failed'/);
  });

  it("constrains op_type, priority 0..1000, attempts", () => {
    expect(SQL).toMatch(/check \(op_type in \('event\.create','event\.update','event\.delete','full\.resync'\)\)/);
    expect(SQL).toMatch(/priority\s+integer not null default 100\s*\n?\s*check \(priority between 0 and 1000\)/);
    expect(SQL).toMatch(/check \(attempts >= 0\)/);
    expect(SQL).toMatch(/check \(max_attempts > 0\)/);
    expect(SQL).toMatch(/check \(attempts <= max_attempts\)/);
  });

  it("has the bidirectional claim-metadata CHECK", () => {
    expect(SQL).toMatch(/calendar_sync_outbox_claim_meta_chk check \([\s\S]{0,400}status = 'processing'[\s\S]{0,120}claimed_at is not null and claim_token is not null and lease_expires_at is not null[\s\S]{0,200}status <> 'processing'[\s\S]{0,120}claimed_at is null and claim_token is null and lease_expires_at is null/);
  });

  it("has the entity-field consistency CHECK (entity ops require an entity; full.resync none)", () => {
    expect(SQL).toMatch(/calendar_sync_outbox_entity_chk check \([\s\S]{0,300}event\.create','event\.update','event\.delete'[\s\S]{0,120}hone_entity_type is not null and hone_entity_id is not null[\s\S]{0,120}full\.resync[\s\S]{0,120}hone_entity_type is null and hone_entity_id is null/);
  });

  it("same-studio composite FK RESTRICT", () => {
    expect(SQL).toMatch(/calendar_sync_outbox_connection_same_studio\s*\n?\s*foreign key \(connection_id, studio_id\)\s*\n?\s*references public\.calendar_connections \(id, studio_id\) on delete restrict/);
  });

  it("has a FULL (non-partial) unique idempotency index + a correctly-ordered claim index", () => {
    expect(SQL).toMatch(/create unique index if not exists calendar_sync_outbox_idempotency_uniq\s*\n?\s*on public\.calendar_sync_outbox \(idempotency_key\);/);
    // full = no WHERE on that index.
    const idem = SQL.slice(SQL.indexOf("calendar_sync_outbox_idempotency_uniq"));
    expect(idem.slice(0, 120)).not.toMatch(/where/i);
    // claim/drain index column order supports priority ASC, next_attempt_at, created_at.
    expect(SQL).toMatch(/calendar_sync_outbox_claim_idx\s*\n?\s*on public\.calendar_sync_outbox \(status, priority, next_attempt_at, created_at\)/);
    expect(SQL).toMatch(/calendar_sync_outbox_lease_idx[\s\S]{0,80}where status = 'processing'/);
  });

  it("is default-deny for browser roles (RLS on + REVOKE ALL, no SELECT policy)", () => {
    expect(SQL).toMatch(/alter table public\.calendar_sync_outbox enable row level security/);
    expect(SQL).toMatch(/revoke all on public\.calendar_sync_outbox from authenticated/);
    expect(SQL).toMatch(/revoke all on public\.calendar_sync_outbox from anon/);
    expect(SQL).not.toMatch(/create policy[\s\S]{0,120}on public\.calendar_sync_outbox/);
  });

  it("documents the deterministic idempotency-key contract + sync_generation deferral + payload privacy", () => {
    expect(SQL).toMatch(/\{hone_entity_type\}:\{hone_entity_id\}:\{op_type\}:\{source_version\}/);
    expect(SQL).toMatch(/sync_generation does NOT exist yet/i);
    expect(SQL).toMatch(/DEFERRED to B2/i);
    expect(SQL).toMatch(/PAYLOAD PRIVACY: operational metadata ONLY/);
    expect(SQL).toMatch(/FIXED allow-listed serializer from TYPED params/);
  });
});

describe("0124 — claim + result RPCs (trusted, service-role only)", () => {
  it("both RPCs are SECURITY DEFINER with a pinned search_path, executable by service_role only", () => {
    for (const fn of ["claim_calendar_sync_op", "record_calendar_sync_result"]) {
      expect(SQL).toMatch(new RegExp(`create or replace function public\\.${fn}`));
      expect(SQL).toMatch(new RegExp(`grant execute on function public\\.${fn}[\\s\\S]{0,120}to service_role`));
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${fn}[\\s\\S]{0,120}from authenticated`));
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${fn}[\\s\\S]{0,120}from anon`));
    }
    expect(SQL).toMatch(/security definer\s*\n?\s*set search_path = pg_catalog, pg_temp/);
  });

  it("claim uses FOR UPDATE SKIP LOCKED, a fixed 5-min lease, the binding order, and reaps stale-at-max to dead", () => {
    expect(SQL).toMatch(/for update skip locked/);
    expect(SQL).toMatch(/v_lease\s+interval := interval '5 minutes'/);
    expect(SQL).toMatch(/order by o\.priority asc, o\.next_attempt_at asc, o\.created_at asc/);
    // stale-at-max reaper -> dead BEFORE claiming.
    expect(SQL).toMatch(/set status = 'dead'[\s\S]{0,200}where o\.status = 'processing'\s*\n?\s*and o\.lease_expires_at <= v_now\s*\n?\s*and o\.attempts >= o\.max_attempts/);
    expect(SQL).toMatch(/claim_token = gen_random_uuid\(\)/);
    expect(SQL).toMatch(/attempts = o\.attempts \+ 1/);
  });

  it("result enforces backoff bounds (5..21600), processed_at only on done, retains diagnostics on success", () => {
    expect(SQL).toMatch(/p_retry_after_seconds < 5 or p_retry_after_seconds > 21600/);
    // success sets processed_at; exhaustion (dead) does not.
    expect(SQL).toMatch(/status = 'done',\s*\n?\s*processed_at = v_now/);
    const deadBlock = SQL.slice(SQL.indexOf("set status = 'dead'", SQL.indexOf("record_calendar_sync_result")));
    expect(deadBlock.slice(0, 300)).not.toMatch(/processed_at = v_now/);
    // stale/wrong token + terminal-row protection.
    expect(SQL).toMatch(/claim_token <> p_claim_token[\s\S]{0,40}return 'stale_token'/);
    expect(SQL).toMatch(/status = 'done' then return 'already_done'/);
    expect(SQL).toMatch(/status = 'dead' then return 'already_dead'/);
    // error messages capped.
    expect(SQL).toMatch(/left\(coalesce\(p_error_message[\s\S]{0,20}, 500\)/);
  });
});
