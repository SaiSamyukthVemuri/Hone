import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Migration 0133: the atomic SAME-RECORD practitioner_move_appointment RPC. Static SQL
// pins for the sensitive-lifecycle-RPC conventions + the move-not-rebook guarantees.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0133_practitioner_move_appointment.sql"),
  "utf8",
);
const ARGS = "\\(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz\\)";

describe("0133: practitioner_move_appointment RPC", () => {
  it("is a SECURITY DEFINER function with a pinned search_path", () => {
    expect(SQL).toMatch(/create or replace function public\.practitioner_move_appointment/);
    expect(SQL).toMatch(/language plpgsql/);
    expect(SQL).toMatch(/security definer/);
    expect(SQL).toMatch(/set search_path = pg_catalog, pg_temp/);
  });

  it("is service_role-only (revoked from public/anon/authenticated)", () => {
    expect(SQL).toMatch(new RegExp(`revoke execute on function public\\.practitioner_move_appointment${ARGS} from public`));
    expect(SQL).toMatch(new RegExp(`revoke execute on function public\\.practitioner_move_appointment${ARGS} from anon`));
    expect(SQL).toMatch(new RegExp(`revoke execute on function public\\.practitioner_move_appointment${ARGS} from authenticated`));
    expect(SQL).toMatch(new RegExp(`grant execute on function public\\.practitioner_move_appointment${ARGS} to service_role`));
  });

  it("authorizes via an active practitioner in the studio (parameter-based, like the cancel RPC)", () => {
    expect(SQL).toMatch(/from public\.practitioners pr[\s\S]{0,120}pr\.id = p_practitioner_id[\s\S]{0,80}pr\.studio_id = p_studio_id[\s\S]{0,60}pr\.active = true/);
    expect(SQL).toMatch(/'not_authorized'/);
  });

  it("locks the row scoped by (id, studio_id) and hides cross-studio existence", () => {
    expect(SQL).toMatch(/from public\.appointments a[\s\S]{0,120}a\.id = p_appointment_id[\s\S]{0,60}a\.studio_id = p_studio_id[\s\S]{0,40}for update/);
    expect(SQL).toMatch(/'appointment_not_found'/);
  });

  it("declares the exact closed result set", () => {
    for (const r of ["moved", "no_change", "stale_appointment", "appointment_not_found", "appointment_not_movable", "invalid_time", "not_authorized"]) {
      expect(SQL).toContain(`'${r}'`);
    }
  });

  it("requires confirmed + future original and a valid future target", () => {
    expect(SQL).toMatch(/v_appt\.status <> 'confirmed' or v_appt\.starts_at <= v_now/);
    expect(SQL).toMatch(/p_new_starts_at is null or p_new_starts_at <= v_now/);
  });

  it("is an optimistic same-record move (compares both stored endpoints; no_change on equal start)", () => {
    expect(SQL).toMatch(/v_appt\.starts_at is distinct from p_expected_starts_at[\s\S]{0,60}v_appt\.ends_at is distinct from p_expected_ends_at/);
    expect(SQL).toMatch(/p_new_starts_at = v_appt\.starts_at/);
  });

  it("preserves duration + computes the new ends_at in-DB, and updates ONLY the scheduling window", () => {
    expect(SQL).toMatch(/p_new_starts_at \+ make_interval\(mins => v_appt\.duration_minutes\)/);
    expect(SQL).toMatch(/update public\.appointments\s*\n?\s*set starts_at = p_new_starts_at,\s*\n?\s*ends_at = v_new_ends_at,\s*\n?\s*updated_at = v_now/);
    // duration_minutes / client_id / practitioner_id / service_id / notes are NOT in the UPDATE set list.
    const updateBlock = SQL.slice(SQL.indexOf("update public.appointments"), SQL.indexOf("insert into public.appointment_audit"));
    expect(updateBlock).not.toMatch(/duration_minutes\s*=/);
    expect(updateBlock).not.toMatch(/client_id\s*=|practitioner_id\s*=|service_id\s*=|notes\s*=|status\s*=/);
  });

  it("is a MOVE, not cancel+rebook: no status='cancelled' write, no second appointment insert", () => {
    expect(SQL).not.toMatch(/status\s*=\s*'cancelled'/);
    expect(SQL).not.toMatch(/insert into public\.appointments/);
  });

  it("writes exactly one atomic 'moved' audit row with PHI-free details", () => {
    expect(SQL).toMatch(/insert into public\.appointment_audit \(appointment_id, actor_type, actor_id, action, details\)/);
    expect(SQL).toMatch(/'practitioner', p_practitioner_id, 'moved'/);
    expect(SQL).toMatch(/'source', 'practitioner_ui'/);
    expect(SQL).toMatch(/'previous_starts_at', v_appt\.starts_at/);
    expect(SQL).toMatch(/'new_starts_at', p_new_starts_at/);
  });

  it("does NOT catch 23P01 (no exception handler, exclusion violations roll back to the server adapter)", () => {
    // The RPC body must contain no exception handler at all; comments may reference
    // 23P01 for documentation, so only the actual `exception when` clause is forbidden.
    expect(SQL).not.toMatch(/\bexception\s+when\b/i);
    expect(SQL).not.toMatch(/\braise\s+exception\b/i);
  });

  it("does not touch trigger-owned fields (buffer/reservation/sync_version) or Google Calendar", () => {
    expect(SQL).not.toMatch(/buffer_minutes_snapshot\s*=|blocked_ends_at\s*=|sync_version\s*=/);
    expect(SQL).not.toMatch(/studio_calendar_reservations|calendar_event_links|googleapis/i);
  });

  it("is additive-only (no destructive DDL)", () => {
    expect(SQL).not.toMatch(/drop table|drop column|alter table.*(drop|add)/i);
  });
});
