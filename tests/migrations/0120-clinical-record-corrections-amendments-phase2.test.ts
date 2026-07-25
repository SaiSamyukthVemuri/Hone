import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Migration 0120: Clinical Record — Phase 2 (corrections & amendments). Snapshot
// lineage fields, an append-only clinical_record_amendments table, a dedicated
// append-only clinical_audit_events table, a NARROW session-scoped transaction-local
// correction permit on the Phase 1 guard, typed correction-payload appliers, and
// trusted amend/correct RPCs. Carries the repo migration-max tripwire (moved from
// 0119). Behavioral proof: tests/db/clinical-corrections.db.test.ts.

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0120_clinical_record_corrections_amendments_phase2.sql";
const SQL = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
const SQL_CODE = SQL.replace(/--.*$/gm, "");

describe("0120 — repo migration-max tripwire", () => {
  it("is the repo migration max", () => {
    const maxNum = Math.max(
      ...readdirSync(MIGRATIONS_DIR)
        .map((f) => /^(\d{4})_.*\.sql$/.exec(f))
        .filter(Boolean)
        .map((m) => Number((m as RegExpExecArray)[1])),
    );
    // Advanced to 0136 (PR B — capacity booking kill-switch), on top of 0135
    // (per-practitioner availability). Bump this tripwire consciously
    // when a new migration lands.
    expect(maxNum).toBe(155); // 0155 = probe inventory chart linkage
    expect(FILE).toMatch(/^0120_/);
  });
});

describe("0120 — additive & non-destructive", () => {
  it("adds snapshot lineage columns (existing v1 -> 'original') and does not rewrite v1", () => {
    expect(SQL_CODE).toMatch(/add column if not exists version_type text not null default 'original'/);
    expect(SQL_CODE).toMatch(/add column if not exists supersedes_snapshot_id uuid/);
    expect(SQL_CODE).toMatch(/add column if not exists correction_reason text/);
    expect(SQL_CODE).toMatch(/add column if not exists corrected_by uuid/);
    expect(SQL_CODE).toMatch(/check \(version_type in \('original', 'correction'\)\)/);
    // Lineage consistency constraint (originals bare; corrections carry supersede + reason).
    expect(SQL_CODE).toMatch(/version_type = 'correction'[\s\S]*supersedes_snapshot_id is not null[\s\S]*correction_reason is not null/);
  });

  it("no destructive change and NO ON DELETE CASCADE anywhere", () => {
    expect(SQL_CODE).not.toMatch(/^\s*delete\s+from/im);
    expect(SQL_CODE).not.toMatch(/drop\s+(table|column)/i);
    expect(SQL_CODE).not.toMatch(/on delete cascade/i);
  });

  it("adds a Phase-2 studio flag (separate from Phase 1), default OFF", () => {
    expect(SQL_CODE).toMatch(/add column if not exists clinical_corrections_enabled boolean not null default false/);
  });
});

describe("0120 — append-only amendments + audit tables", () => {
  it("clinical_record_amendments: RESTRICT FKs, non-empty reason, member SELECT, revoked writes, append-only", () => {
    expect(SQL_CODE).toMatch(/create table if not exists public\.clinical_record_amendments/);
    expect(SQL_CODE).toMatch(/check \(length\(btrim\(reason\)\) > 0\)/);
    expect(SQL_CODE).toMatch(/foreign key \(studio_id, session_id\) references public\.sessions \(studio_id, id\) on delete restrict/);
    expect(SQL_CODE).toMatch(/references public\.clinical_record_snapshots\(id\) on delete restrict/);
    expect(SQL_CODE).toMatch(/create policy "clinical_record_amendments_member_select"[\s\S]*for select to authenticated[\s\S]*is_studio_member/);
    expect(SQL_CODE).toMatch(/revoke insert, update, delete, truncate on public\.clinical_record_amendments from anon, authenticated/);
    expect(SQL_CODE).toMatch(/create trigger clinical_record_amendments_append_only\s+before update or delete on public\.clinical_record_amendments/);
    // Append-only reuses the 0119 guard fn.
    expect(SQL_CODE).toMatch(/execute function public\.guard_snapshot_append_only\(\)/);
  });

  it("clinical_audit_events: dedicated, append-only, studio-scoped, PHI-safe (ids + versions, no value columns)", () => {
    expect(SQL_CODE).toMatch(/create table if not exists public\.clinical_audit_events/);
    expect(SQL_CODE).toMatch(/operation_type in \('correction', 'amendment'\)/);
    expect(SQL_CODE).toMatch(/record_version_before integer/);
    expect(SQL_CODE).toMatch(/record_version_after integer/);
    expect(SQL_CODE).toMatch(/affected_entity_ids jsonb/);
    expect(SQL_CODE).toMatch(/create policy "clinical_audit_events_member_select"[\s\S]*is_studio_member/);
    expect(SQL_CODE).toMatch(/revoke insert, update, delete, truncate on public\.clinical_audit_events from anon, authenticated/);
    expect(SQL_CODE).toMatch(/create trigger clinical_audit_events_append_only\s+before update or delete on public\.clinical_audit_events/);
    // No old_value/new_value clinical-value columns (PHI stays out).
    expect(SQL_CODE).not.toMatch(/clinical_audit_events[\s\S]{0,600}(old_value|new_value)\b/);
  });
});

describe("0120 — narrow correction bypass (session-scoped, no broad escape hatch)", () => {
  it("adds exactly ONE GUC key, session-scoped, and set only inside the trusted RPCs", () => {
    // Exactly the one allowed key.
    const guc = SQL_CODE.match(/hone\.correction_session_id/g) ?? [];
    expect(guc.length).toBeGreaterThan(0);
    // No other hone.* GUC.
    const anyHone = SQL_CODE.match(/current_setting\(\s*'hone\.[a-z_]+'/g) ?? [];
    expect(new Set(anyHone).size).toBe(1);
    // Session-scoped permit: compared to the row's own session id (TEXT compare, no ::uuid cast).
    expect(SQL_CODE).toMatch(/v_correcting <> '' and v_correcting = old\.id::text/);
    expect(SQL_CODE).toMatch(/v_correcting <> '' and v_correcting = old\.session_id::text/);
    // Set transaction-local (is_local=true) only inside the correction/late-photo RPCs.
    expect(SQL_CODE).toMatch(/set_config\('hone\.correction_session_id', p_session_id::text, true\)/);
    expect(SQL_CODE).toMatch(/set_config\('hone\.correction_session_id', '', true\)/);
  });

  it("has NO broad service-role / auth.uid()-null / role bypass in the guard", () => {
    expect(SQL_CODE).not.toMatch(/auth\.uid\(\)\s+is\s+null/i);
    expect(SQL_CODE).not.toMatch(/service_role/i);
    expect(SQL_CODE).not.toMatch(/current_user\s*=/i);
    expect(SQL_CODE).not.toMatch(/session_user/i);
  });

  it("keeps child/entry INSERT and all DELETE frozen even under the permit (corrections only UPDATE)", () => {
    // The permit appears EXACTLY 5x: sessions UPDATE, image INSERT + UPDATE(old) +
    // UPDATE(new), child UPDATE. It is NOT on child/entry INSERT or any DELETE, so
    // those still raise unconditionally on a finalized parent.
    expect((SQL_CODE.match(/v_correcting <> '' and v_correcting =/g) ?? []).length).toBe(5);
  });
});

describe("0120 — typed correction payload (allow-listed; no arbitrary columns)", () => {
  it("per-entity appliers reject unknown keys and are revoked from clients", () => {
    for (const fn of [
      "_apply_session_correction",
      "_apply_block_correction",
      "_apply_electrolysis_correction",
      "_apply_laser_correction",
      "_apply_image_correction",
    ]) {
      expect(SQL_CODE, fn).toMatch(new RegExp(`create or replace function public\\.${fn}`));
      expect(SQL_CODE, fn).toMatch(new RegExp(`revoke execute on function public\\.${fn}\\(uuid, jsonb\\) from anon, authenticated, public`));
    }
    // Disallowed-field rejection present per entity.
    expect((SQL_CODE.match(/Disallowed .* correction field/g) ?? []).length).toBeGreaterThanOrEqual(5);
    // The session applier body never assigns studio/client/lifecycle columns.
    const sessApplier = SQL_CODE.slice(
      SQL_CODE.indexOf("function public._apply_session_correction"),
      SQL_CODE.indexOf("function public._apply_block_correction"),
    );
    expect(sessApplier.length).toBeGreaterThan(0);
    expect(sessApplier).not.toMatch(/(studio_id|client_id|record_status|record_version|current_snapshot_id|record_origin)\s*=/);
  });

  it("top-level payload sections are allow-listed", () => {
    expect(SQL_CODE).toMatch(/k not in \('session','blocks','electrolysis_entries','laser_entries','images'\)/);
  });
});

describe("0120 — amendment RPC (append-only; no normalized/version/snapshot change)", () => {
  it("inserts one immutable amendment + clinical audit, requires reason, native+finalized, and does NOT touch canonical rows", () => {
    expect(SQL_CODE).toMatch(/create or replace function public\.amend_finalized_session/);
    expect(SQL_CODE).toMatch(/A reason is required/);
    expect(SQL_CODE).toMatch(/Target version does not belong to this session/);
    // Body of amend_finalized_session must not update sessions / build a snapshot / set the correction GUC.
    const amendBody = SQL_CODE.slice(
      SQL_CODE.indexOf("function public.amend_finalized_session("),
      SQL_CODE.indexOf("function public.amend_finalized_session_with_image("),
    );
    expect(amendBody).not.toMatch(/update public\.sessions/);
    expect(amendBody).not.toMatch(/build_session_snapshot/);
    expect(amendBody).not.toMatch(/set_config\('hone\.correction_session_id'/);
    expect(amendBody).toMatch(/insert into public\.clinical_record_amendments/);
  });
});

describe("0120 — correction RPC (atomic version N -> N+1)", () => {
  it("CAS, native+finalized, min-charting re-check, supersede chain, single record_version increment, audit", () => {
    expect(SQL_CODE).toMatch(/create or replace function public\.correct_finalized_session/);
    expect(SQL_CODE).toMatch(/for update/);
    expect(SQL_CODE).toMatch(/Record version conflict/);
    expect(SQL_CODE).toMatch(/Only native records can be corrected/);
    // Rebuild + re-validate the persisted snapshot (never empty).
    expect(SQL_CODE).toMatch(/v_snapshot := public\.build_session_snapshot\(p_session_id\)/);
    expect(SQL_CODE).toMatch(/without a treatment area\/pass/);
    // New version = N+1; supersedes prior; corrector-signed; record_version advanced once.
    expect(SQL_CODE).toMatch(/v_new_ver := v_version \+ 1/);
    expect(SQL_CODE).toMatch(/'correction', v_prev_snap,/);
    expect(SQL_CODE).toMatch(/set record_version = v_new_ver, current_snapshot_id = v_snap_id/);
    // record_status is NOT set to draft anywhere (no destructive reopen).
    expect(SQL_CODE).not.toMatch(/record_status\s*=\s*'draft'/);
    expect(SQL_CODE).toMatch(/insert into public\.clinical_audit_events/);
  });

  it("grants are narrow (revoke anon/public; grant authenticated) for all three RPCs", () => {
    for (const sig of [
      "amend_finalized_session\\(uuid, uuid, text, text, text, jsonb\\)",
      "correct_finalized_session\\(uuid, integer, text, jsonb\\)",
      "amend_finalized_session_with_image\\(uuid, uuid, text, text, text, text, bigint, text, uuid, text\\)",
    ]) {
      expect(SQL_CODE, sig).toMatch(new RegExp(`revoke execute on function public\\.${sig} from anon, public`));
      expect(SQL_CODE, sig).toMatch(new RegExp(`grant execute on function public\\.${sig} to authenticated`));
    }
  });
});
