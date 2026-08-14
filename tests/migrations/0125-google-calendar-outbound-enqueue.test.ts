import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Static (SQL-text) proof of migration 0125, the Google Calendar B2.3-a
// activation-boundary foundation. The behavioural proof (triggers, reaper,
// eligibility, repair, dormancy) is in tests/db/google-calendar-b2-3a-*.db.test.ts;
// this pins the deliberate contract + the three mandatory conditions in the SQL.

const MIG_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0125_"));
const SQL = FILE ? readFileSync(path.join(MIG_DIR, FILE), "utf8") : "";

describe("0125: file + scope boundary", () => {
  it("is the single 0125 migration; the repo-max tripwire now lives in the newest migration test", () => {
    expect(FILE).toBeTruthy();
    expect(FILE).toMatch(/^0125_.*\.sql$/);
    // Later migrations (0126 client_clinical_notes, 0127 its policy fix) legitimately
    // advance the repo max; the absolute repo-max pin lives in the newest migration's
    // test (currently 0127), not here.
    expect(readdirSync(MIG_DIR).filter((f) => f.startsWith("0125_"))).toHaveLength(1);
  });

  it("the required event scope is calendar.events.owned, never broad calendar.events", () => {
    expect(SQL).toMatch(
      /create or replace function public\.calendar_required_event_scopes\(\)[\s\S]*?array\['https:\/\/www\.googleapis\.com\/auth\/calendar\.events\.owned'\]/,
    );
    // The broad scope must NOT be the returned value (it is a fallback only).
    expect(SQL).not.toMatch(/array\['https:\/\/www\.googleapis\.com\/auth\/calendar\.events'\]/);
    expect(SQL).toMatch(/immutable/);
  });
});

describe("0125: appointment fields + version bump", () => {
  it("adds sync_version NOT NULL DEFAULT 1 + reschedule lineage + cancellation_kind CHECK", () => {
    expect(SQL).toMatch(/add column if not exists sync_version integer not null default 1/);
    expect(SQL).toMatch(/rescheduled_from_appointment_id uuid[\s\S]{0,80}references public\.appointments\(id\) on delete set null/);
    expect(SQL).toMatch(/rescheduled_to_appointment_id uuid[\s\S]{0,80}references public\.appointments\(id\) on delete set null/);
    expect(SQL).toMatch(/cancellation_kind text[\s\S]{0,120}in \('rescheduled','withdrawn'\)/);
  });
  it("bump uses IS DISTINCT FROM on serialized fields and respects an explicit caller bump", () => {
    expect(SQL).toMatch(/new\.sync_version is distinct from old\.sync_version[\s\S]{0,60}return new/);
    expect(SQL).toMatch(/new\.starts_at is distinct from old\.starts_at[\s\S]{0,120}new\.sync_version := old\.sync_version \+ 1/);
  });
});

describe("0125: trigger names + firing order", () => {
  it("BEFORE bump trigger is named so it sorts after the existing snapshot trigger", () => {
    expect(SQL).toMatch(/create trigger appointments_sync_version_bump_trg\s*\n?\s*before insert or update on public\.appointments/);
    // 'appointments_snapshot_buffer_trg' < 'appointments_sync_version_bump_trg' alphabetically.
    expect("appointments_snapshot_buffer_trg" < "appointments_sync_version_bump_trg").toBe(true);
  });
  it("AFTER enqueue trigger fires LAST (zzz) after the reservation-sync trigger", () => {
    expect(SQL).toMatch(/create trigger appointments_zzz_outbound_enqueue_trg\s*\n?\s*after insert or update of starts_at, ends_at, status, sync_version/);
    expect(SQL).toMatch(/create trigger appointments_zzz_outbound_enqueue_delete_trg\s*\n?\s*after delete on public\.appointments/);
    expect("appointments_sync_calendar_reservation_trg" < "appointments_zzz_outbound_enqueue_trg").toBe(true);
  });
});

describe("0125: intent-gated enqueue + genuine never-raise", () => {
  it("intent gate checks the studio flag + owner + write_calendar, NOT connection health", () => {
    expect(SQL).toMatch(/s\.google_calendar_outbound_sync_enabled/);
    expect(SQL).toMatch(/c\.is_studio_calendar_owner/);
    expect(SQL).toMatch(/c\.write_calendar_id is not null/);
    // The enqueue function must NOT gate on connected/scope/secret (those are claim-time only).
    const enqueueFn = SQL.slice(
      SQL.indexOf("function public.enqueue_calendar_outbound()"),
      SQL.indexOf("function public.enqueue_calendar_outbound_on_delete()"),
    );
    expect(enqueueFn).not.toMatch(/connection_status = 'connected'/);
    expect(enqueueFn).not.toMatch(/encrypted_refresh_token is not null/);
    expect(enqueueFn).not.toMatch(/granted_scopes @>/);
  });
  it("both enqueue triggers write their ops_alerts marker inside a NESTED never-raise guard", () => {
    // Exactly two durable markers (enqueue + delete-enqueue).
    expect((SQL.match(/insert into public\.ops_alerts/g) ?? []).length).toBe(2);
    // Each marker sits inside its own `begin … insert … exception when others then null; end;`
    // so a failed marker cannot re-raise and abort the appointment write.
    const guardedMarker = /begin[\s\S]*?insert into public\.ops_alerts[\s\S]*?exception when others then\s*null;\s*\n?\s*end;/g;
    expect((SQL.match(guardedMarker) ?? []).length).toBe(2);
  });
  it("neither enqueue trigger function is declared STRICT (no arg-less NULL protection to rely on)", () => {
    // Both trigger functions declare exactly this header, no STRICT.
    expect(SQL).toMatch(/create or replace function public\.enqueue_calendar_outbound\(\)\s*\n?\s*returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as \$\$/);
    expect(SQL).toMatch(/create or replace function public\.enqueue_calendar_outbound_on_delete\(\)\s*\n?\s*returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as \$\$/);
    // Belt-and-suspenders: the migration declares no STRICT function at all.
    expect(SQL.toLowerCase()).not.toMatch(/\bstrict\b/);
  });
  it("marker dedup: a partial unique index + ON CONFLICT DO NOTHING, both markers, inside the guard", () => {
    expect(SQL).toMatch(/create unique index if not exists ops_alerts_calendar_enqueue_skip_dedup_uniq\s*\n?\s*on public\.ops_alerts \(studio_id, \(safe_details->>'dedup_key'\)\)\s*\n?\s*where event = 'calendar_enqueue_skipped' and resolved_at is null/);
    expect((SQL.match(/on conflict \(studio_id, \(safe_details->>'dedup_key'\)\)\s*\n?\s*where event = 'calendar_enqueue_skipped' and resolved_at is null\s*\n?\s*do nothing/g) ?? []).length).toBe(2);
    // Each ON CONFLICT marker sits inside a nested guard (the guardedMarker count above already proves 2 guarded markers).
  });
  it("uses ON CONFLICT (idempotency_key) DO NOTHING (never resurrects a done/dead row)", () => {
    expect(SQL).toMatch(/on conflict \(idempotency_key\) do nothing/);
  });
});

describe("0125, condition 1: append-only suppression telemetry (no contended counter)", () => {
  it("has an append-only calendar_sync_metric_events table (no daily-counter upsert)", () => {
    expect(SQL).toMatch(/create table if not exists public\.calendar_sync_metric_events/);
    expect(SQL).not.toMatch(/on conflict \(studio_id, metric, day\)/i);
    expect(SQL).not.toMatch(/do update set count/i);
    // No unique on (studio_id, metric, day) that would serialize concurrent suppressions.
    expect(SQL).not.toMatch(/unique \(studio_id, metric, day\)/i);
  });
});

describe("0125, condition 2: health-aware reaper + global control in claim", () => {
  it("claim early-returns when the global worker control is OFF/absent (no reap, no claim)", () => {
    // Table-aliased (a bare `id` would collide with the RETURNS TABLE (id …) column).
    expect(SQL).toMatch(/select ctl\.worker_enabled into v_enabled\s*\n?\s*from public\.calendar_sync_control ctl where ctl\.id = true/);
    expect(SQL).toMatch(/if not found or v_enabled is not true then\s*\n?\s*return;/);
  });
  it("evaluates health ONCE per stale row (single-health-read reaper) under FOR UPDATE SKIP LOCKED", () => {
    // One `stale` CTE classifies is_healthy + at_max per locked row; both branches
    // consume that single classification (no two independent predicate re-reads).
    expect(SQL).toMatch(/with stale as \([\s\S]{0,320}calendar_connection_outbound_ready\(o\.connection_id, o\.studio_id\) as is_healthy/);
    expect(SQL).toMatch(/from public\.calendar_sync_outbox o\s*\n?\s*where o\.status = 'processing' and o\.lease_expires_at <= v_now\s*\n?\s*for update of o skip locked/);
  });
  it("applies EXACTLY ONE transition via a CASE on the single is_healthy read (healthy-at-max→dead, unhealthy→release)", () => {
    expect(SQL).toMatch(/set status\s+= case when st\.is_healthy then 'dead' else 'pending' end/);
    expect(SQL).toMatch(/attempts\s+= case when st\.is_healthy then o\.attempts else greatest\(o\.attempts - 1, 0\) end/);
    expect(SQL).toMatch(/and \(\(st\.is_healthy and st\.at_max\) or \(not st\.is_healthy\)\)/);
    // NOT two independent reaper UPDATEs (the old defect).
    expect(SQL).not.toMatch(/set status = 'pending',\s*\n?\s*attempts = greatest\(o\.attempts - 1, 0\),?\s*\n?\s*claimed_at = null, claim_token = null, lease_expires_at = null,\s*\n?\s*next_attempt_at = v_now/);
  });
  it("claim eligibility uses SUPERSET containment (@>), never set equality", () => {
    expect(SQL).toMatch(/granted_scopes @> public\.calendar_required_event_scopes\(\)/);
    expect(SQL).not.toMatch(/granted_scopes = /);
  });
  it("claim keeps the deployed signature + return shape + batch clamp + SKIP LOCKED", () => {
    expect(SQL).toMatch(/create or replace function public\.claim_calendar_sync_op\(p_batch_size integer\)/);
    expect(SQL).toMatch(/least\(greatest\(coalesce\(p_batch_size, 1\), 1\), 25\)/);
    expect(SQL).toMatch(/for update skip locked/);
  });
});

describe("0125, condition 3: no eager write-calendar link repoint", () => {
  it("never bulk-updates an existing link's google_calendar_id", () => {
    expect(SQL).not.toMatch(/update public\.calendar_event_links[\s\S]{0,200}set[\s\S]{0,200}google_calendar_id/i);
  });
});

describe("0125: entity CHECK relaxation (narrow, tombstone delete only)", () => {
  it("event.delete is entity-optional; create/update require an entity; full.resync none", () => {
    const chk = SQL.slice(SQL.indexOf("add constraint calendar_sync_outbox_entity_chk"));
    expect(chk).toMatch(/op_type in \('event\.create','event\.update'\)\s*\n?\s*and hone_entity_type is not null and hone_entity_id is not null/);
    expect(chk).toMatch(/or \(op_type = 'event\.delete'\)/);
    expect(chk).toMatch(/or \(op_type = 'full\.resync'\s*\n?\s*and hone_entity_type is null and hone_entity_id is null\)/);
  });
});

describe("0125: control table + generations + repair primitives", () => {
  it("calendar_sync_control singleton defaults worker_enabled false and is seeded", () => {
    expect(SQL).toMatch(/worker_enabled boolean not null default false/);
    expect(SQL).toMatch(/id\s+boolean primary key default true check \(id\)/);
    expect(SQL).toMatch(/insert into public\.calendar_sync_control \(id, worker_enabled\) values \(true, false\)/);
  });
  it("adds sync_generation + reconcile_generation to calendar_connections", () => {
    expect(SQL).toMatch(/add column if not exists sync_generation\s+bigint not null default 0/);
    expect(SQL).toMatch(/add column if not exists reconcile_generation bigint not null default 0/);
  });
  it("repair primitives never reopen a dead row (they mint a new key)", () => {
    expect(SQL).toMatch(/function public\.repair_bump_appointment_sync_version\(p_appointment_id uuid\)/);
    expect(SQL).toMatch(/set sync_version = sync_version \+ 1/);
    expect(SQL).toMatch(/function public\.repair_enqueue_orphan_link_delete\(p_link_id uuid\)/);
    expect(SQL).toMatch(/event\.delete#reconcile:/);
    // No path flips a dead row back to pending / reopens it.
    expect(SQL).not.toMatch(/update public\.calendar_sync_outbox[\s\S]{0,120}set status = 'pending'[\s\S]{0,120}where[\s\S]{0,120}status = 'dead'/i);
  });
});

describe("0125, hardening: search_path, grants, no destructive/parallel structures", () => {
  it("every SECURITY DEFINER function pins search_path and is service-role only", () => {
    const definers = SQL.match(/security definer/g) ?? [];
    expect(definers.length).toBeGreaterThanOrEqual(4);
    // Each definer block pins the search path.
    expect((SQL.match(/security definer set search_path = pg_catalog, pg_temp/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
  it("adds NO browser grants on the queue/link surfaces and NO generic/parallel outbox", () => {
    expect(SQL).not.toMatch(/grant[\s\S]{0,80}calendar_sync_outbox to (anon|authenticated)/i);
    expect(SQL).not.toMatch(/create table[^;]*job_outbox/i);
    expect(SQL).not.toMatch(/drop table/i);
    // No renamed transport RPCs: reuses the deployed ones.
    expect(SQL).not.toMatch(/create or replace function public\.(claim_sync|drain_|dequeue_)/i);
  });
  it("the health view exposes skip markers + suppression and is union-anchored", () => {
    expect(SQL).toMatch(/create or replace view public\.calendar_sync_queue_health/);
    expect(SQL).toMatch(/skip_markers_open/);
    expect(SQL).toMatch(/idempotency_suppressed_24h/);
    expect(SQL).toMatch(/with studio_ids as \([\s\S]{0,400}union[\s\S]{0,400}calendar_enqueue_skipped/);
  });
  it("the health view splits ELIGIBLE vs PARKED pending (parked still counts in total)", () => {
    for (const field of [
      "pending", // total
      "eligible_pending",
      "parked_pending",
      "oldest_pending_due", // total
      "oldest_eligible_pending_due",
      "oldest_parked_pending_due",
    ]) {
      expect(SQL).toMatch(new RegExp(`as ${field}\\b|${field}\\b`));
    }
    // Parked = pending AND not-ready; eligible = pending AND ready.
    expect(SQL).toMatch(/o\.status = 'pending'\s*\n?\s*and public\.calendar_connection_outbound_ready[\s\S]{0,60}as eligible_pending/);
    expect(SQL).toMatch(/o\.status = 'pending'\s*\n?\s*and not public\.calendar_connection_outbound_ready[\s\S]{0,60}as parked_pending/);
  });
});
