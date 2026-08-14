import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Migration 0119: Clinical Record, Phase 1 (finalization boundary). Additive
// lifecycle + provenance columns, a studio-scoped feature flag, an immutable
// append-only snapshot artifact, a deterministic UTC-canonical snapshot builder,
// full finalized-aggregate write guards (sessions + children + treatment_images,
// NO service-role/GUC bypass), a practitioner attribution-retention trigger, and a
// trusted native-only finalize RPC. Carries the repo migration-max tripwire.
// Behavioral proof: tests/db/clinical-finalization.db.test.ts.

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0119_clinical_record_finalization_phase1.sql";
const SQL = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
// Strip line comments so the doc-comment (which names forbidden ops to say it
// avoids them) can't satisfy or trip the greps.
const SQL_CODE = SQL.replace(/--.*$/gm, "");

describe("0119: exists", () => {
  it("0119 is present; the repo-max tripwire now lives in the 0120 test", () => {
    const maxNum = Math.max(
      ...readdirSync(MIGRATIONS_DIR)
        .map((f) => /^(\d{4})_.*\.sql$/.exec(f))
        .filter(Boolean)
        .map((m) => Number((m as RegExpExecArray)[1])),
    );
    // 0119 is no longer newest (0120 added corrections & amendments).
    expect(maxNum).toBeGreaterThanOrEqual(119);
    expect(FILE).toMatch(/^0119_/);
  });
});

describe("0119: additive, non-destructive, legacy-truthful", () => {
  it("adds lifecycle columns (default draft), no rewrite/backfill of existing rows", () => {
    expect(SQL_CODE).toMatch(
      /add column if not exists record_status text not null default 'draft'/,
    );
    expect(SQL_CODE).toMatch(/add column if not exists finalized_at timestamptz/);
    expect(SQL_CODE).toMatch(/add column if not exists record_version integer not null default 1/);
    expect(SQL_CODE).toMatch(/check \(record_status in \('draft', 'finalized', 'void'\)\)/);
  });

  it("adds provenance: existing rows -> legacy (default at ADD), future -> native", () => {
    expect(SQL_CODE).toMatch(
      /add column if not exists record_origin text not null default 'legacy'/,
    );
    expect(SQL_CODE).toMatch(/alter column record_origin set default 'native'/);
    expect(SQL_CODE).toMatch(/check \(record_origin in \('native', 'legacy'\)\)/);
    // Descriptive classification column exists + constrained; only legacy rows may carry it.
    expect(SQL_CODE).toMatch(/add column if not exists legacy_classification text/);
    expect(SQL_CODE).toMatch(
      /legacy_classification in \('clearly_completed', 'clearly_incomplete', 'ambiguous'\)/,
    );
    expect(SQL_CODE).toMatch(/legacy_classification is null or record_origin = 'legacy'/);
  });

  it("does NO destructive change and never auto-finalizes/signs/backfills a legacy row", () => {
    expect(SQL_CODE).not.toMatch(/^\s*delete\s+from/im);
    expect(SQL_CODE).not.toMatch(/drop\s+(table|column)/i);
    // The ONLY sessions->finalized write is the per-row RPC flip (where id = p_session_id).
    expect(SQL_CODE).toMatch(
      /update public\.sessions\s+set record_status = 'finalized'[\s\S]*where id = p_session_id/,
    );
    // No BULK / status-or-origin-based backfill of existing rows to 'finalized'.
    expect(SQL_CODE).not.toMatch(
      /update public\.sessions set record_status = 'finalized' where (record_origin|record_status|deleted_at|studio_id)/i,
    );
    // No heuristic UPDATE populating legacy_classification (deferred to review queue).
    expect(SQL_CODE).not.toMatch(/update\s+public\.sessions\s+set[\s\S]*legacy_classification/i);
  });

  it("adds a studio-scoped feature flag, default OFF (not global)", () => {
    expect(SQL_CODE).toMatch(
      /alter table public\.studios[\s\S]*clinical_finalization_enabled boolean not null default false/,
    );
  });
});

describe("0119, snapshot retention: never cascade-delete", () => {
  it("has NO ON DELETE CASCADE anywhere (snapshots/lineage are permanent)", () => {
    expect(SQL_CODE).not.toMatch(/on delete cascade/i);
  });

  it("snapshot + attribution FKs use RESTRICT / NO ACTION", () => {
    // studio, session, composite same-studio, and finalized_by all RESTRICT.
    expect(SQL_CODE).toMatch(
      /clinical_record_snapshots_studio_fk[\s\S]*references public\.studios\(id\) on delete restrict/,
    );
    expect(SQL_CODE).toMatch(
      /clinical_record_snapshots_session_fk[\s\S]*references public\.sessions\(id\) on delete restrict/,
    );
    expect(SQL_CODE).toMatch(
      /foreign key \(studio_id, session_id\) references public\.sessions \(studio_id, id\) on delete restrict/,
    );
    // finalized_by never nulled by practitioner deletion (session + snapshot).
    expect(SQL_CODE).toMatch(
      /finalized_by uuid references public\.practitioners\(id\) on delete restrict/,
    );
    // current_snapshot_id back-reference does not cascade.
    expect(SQL_CODE).toMatch(
      /sessions_current_snapshot_fk[\s\S]*references public\.clinical_record_snapshots\(id\) on delete no action/,
    );
    // No ON DELETE SET NULL on any finalized-attribution FK.
    expect(SQL_CODE).not.toMatch(/finalized_by[\s\S]{0,80}on delete set null/i);
  });
});

describe("0119: immutable, append-only snapshot artifact", () => {
  it("has the required schema columns incl. hash_algorithm + canonicalization_version + attestation", () => {
    expect(SQL_CODE).toMatch(/create table if not exists public\.clinical_record_snapshots/);
    expect(SQL_CODE).toMatch(/content_hash text not null/);
    expect(SQL_CODE).toMatch(/hash_algorithm text not null default 'sha256'/);
    expect(SQL_CODE).toMatch(/canonicalization_version integer not null default 1/);
    expect(SQL_CODE).toMatch(/attestation_text text/);
    expect(SQL_CODE).toMatch(/record_origin text not null default 'native'/);
    expect(SQL_CODE).toMatch(/unique \(session_id, version_no\)/);
  });

  it("is append-only: member SELECT only; client write grants revoked; UPDATE/DELETE blocked for ALL roles", () => {
    expect(SQL_CODE).toMatch(
      /create policy "clinical_record_snapshots_member_select"[\s\S]*for select to authenticated[\s\S]*is_studio_member/,
    );
    expect(SQL_CODE).toMatch(
      /revoke insert, update, delete, truncate on public\.clinical_record_snapshots from anon, authenticated/,
    );
    expect(SQL_CODE).toMatch(/revoke all on public\.clinical_record_snapshots from public/);
    // No authenticated insert/update/delete POLICY (the "for each row" trigger and
    // the RPC's "for update" lock are not policies and must not trip this).
    expect(SQL_CODE).not.toMatch(/on public\.clinical_record_snapshots\s+for (insert|update|delete)/);
    // Storage-layer append-only trigger blocks UPDATE/DELETE even for service-role/owner.
    expect(SQL_CODE).toMatch(/function public\.guard_snapshot_append_only/);
    expect(SQL_CODE).toMatch(
      /create trigger clinical_record_snapshots_append_only\s+before update or delete on public\.clinical_record_snapshots/,
    );
  });
});

describe("0119: deterministic, UTC-canonical snapshot builder", () => {
  it("orders every array with a stable id tiebreak and renders timestamps in UTC", () => {
    expect(SQL_CODE).toMatch(/function public\.build_session_snapshot/);
    expect(SQL_CODE).toMatch(/order by b\.sort_order, b\.id/);
    expect(SQL_CODE).toMatch(/order by e\.created_at, e\.id/);
    expect(SQL_CODE).toMatch(/order by l\.created_at, l\.id/);
    expect(SQL_CODE).toMatch(/order by ti\.created_at, ti\.id/);
    // UTC normalization (NOT the connection TimeZone GUC).
    expect(SQL_CODE).toMatch(/at time zone 'UTC'/);
  });

  it("excludes deleted/voided children, image bytes, and operational price", () => {
    // Deleted children excluded across blocks/entries/images.
    expect(SQL_CODE).toMatch(/from public\.session_blocks b\s+where b\.session_id = p_session_id and b\.deleted_at is null/);
    expect(SQL_CODE).toMatch(/from public\.treatment_images ti\s+where ti\.session_id = p_session_id and ti\.deleted_at is null/);
    // Photos: references only, never bytes/URLs/secrets.
    expect(SQL_CODE).toMatch(/'storage_path', ti\.storage_path/);
    expect(SQL_CODE).not.toMatch(/decode\(|bytea|image_bytes|file_contents|signed_url|createSignedUrl/i);
    // price_paid_cents is operational: neither snapshotted nor frozen -> absent from code.
    expect(SQL_CODE).not.toMatch(/price_paid_cents/);
  });

  it("captures practitioner identity evidence (display name)", () => {
    expect(SQL_CODE).toMatch(/'practitioner_display_name'/);
    expect(SQL_CODE).toMatch(/'performed_by_display_name'/);
  });
});

describe("0119: full finalized-aggregate freeze (NO bypass)", () => {
  it("guards sessions (UPDATE+DELETE), all 3 children (INSERT+UPDATE+DELETE), and treatment_images (INSERT+UPDATE+DELETE)", () => {
    expect(SQL_CODE).toMatch(/function public\.guard_finalized_clinical_write/);
    expect(SQL_CODE).toMatch(
      /create trigger sessions_guard_finalized\s+before update or delete on public\.sessions/,
    );
    for (const t of ["session_blocks", "electrolysis_entries", "laser_entries", "treatment_images"]) {
      expect(SQL_CODE, t).toMatch(
        new RegExp(`create trigger ${t}_guard_finalized\\s+before insert or update or delete on public\\.${t}`),
      );
    }
  });

  it("freezes clinical + attribution + soft-delete + lifecycle (blocks status reversal & soft-delete)", () => {
    // Status reversal blocked (record_status frozen).
    expect(SQL_CODE).toMatch(/new\.record_status is distinct from old\.record_status/);
    // Soft-delete of a finalized session blocked (deleted_at frozen).
    expect(SQL_CODE).toMatch(/new\.deleted_at is distinct from old\.deleted_at/);
    // Attribution frozen.
    expect(SQL_CODE).toMatch(/new\.practitioner_id is distinct from old\.practitioner_id/);
    expect(SQL_CODE).toMatch(/new\.performed_by_practitioner_id is distinct from old\.performed_by_practitioner_id/);
    // Clinical content frozen.
    expect(SQL_CODE).toMatch(/new\.session_notes is distinct from old\.session_notes/);
    expect(SQL_CODE).toMatch(/new\.aftercare_and_risks_explained_at is distinct from old\.aftercare_and_risks_explained_at/);
    // Hard-delete of a finalized/snapshotted session blocked.
    expect(SQL_CODE).toMatch(/cannot be deleted/i);
  });

  it("has NO broad service-role / auth.uid() IS NULL / GUC bypass in the integrity path", () => {
    expect(SQL_CODE).not.toMatch(/auth\.uid\(\)\s+is\s+null/i);
    expect(SQL_CODE).not.toMatch(/service_role/i);
    expect(SQL_CODE).not.toMatch(/trusted_clinical_write/i);
    expect(SQL_CODE).not.toMatch(/current_setting\(\s*'hone\./i);
  });
});

describe("0119: practitioner attribution retention", () => {
  it("blocks hard-deleting a practitioner referenced by a finalized record (deactivation still allowed)", () => {
    expect(SQL_CODE).toMatch(/function public\.guard_practitioner_finalized_refs/);
    expect(SQL_CODE).toMatch(
      /create trigger practitioners_block_finalized_delete\s+before delete on public\.practitioners/,
    );
    expect(SQL_CODE).toMatch(/record_status in \('finalized', 'void'\)/);
    expect(SQL_CODE).toMatch(/Cannot delete a practitioner referenced by a finalized clinical record/);
  });
});

describe("0119: trusted finalize RPC", () => {
  it("is SECURITY DEFINER with hardened search_path, locks the row, server-derives actor/studio", () => {
    expect(SQL_CODE).toMatch(/function public\.finalize_session/);
    expect(SQL_CODE).toMatch(/security definer/);
    expect(SQL_CODE).toMatch(/set search_path = ''/);
    expect(SQL_CODE).toMatch(/for update/);
    expect(SQL_CODE).toMatch(/where p\.user_id = auth\.uid\(\) and p\.active = true and p\.studio_id = v_studio/);
  });

  it("enforces the studio flag INSIDE the RPC, native-only, draft-only, and minimum charting", () => {
    expect(SQL_CODE).toMatch(/select st\.clinical_finalization_enabled into v_flag/);
    expect(SQL_CODE).toMatch(/not enabled for this studio/i);
    expect(SQL_CODE).toMatch(/if v_origin <> 'native' then/);
    expect(SQL_CODE).toMatch(/if v_status <> 'draft' then/);
    // Minimum charting: a live block AND a live entry (block-with-no-entry insufficient).
    expect(SQL_CODE).toMatch(/no treatment area/i);
    expect(SQL_CODE).toMatch(/no treatment pass/i);
    // Airtight: re-validates the BUILT snapshot jsonb (closes the TOCTOU where a
    // concurrent soft-delete could otherwise persist an empty finalized record).
    expect(SQL_CODE).toMatch(/jsonb_array_length\(v_snapshot->'blocks'\)/);
    expect(SQL_CODE).toMatch(/jsonb_array_length\(v_snapshot->'electrolysis_entries'\)/);
  });

  it("uses compare-and-set (expected=1) and does NOT increment version at initial finalization", () => {
    expect(SQL_CODE).toMatch(/p_expected_record_version is null or p_expected_record_version <> v_version/);
    // session.record_version stays 1: no increment.
    expect(SQL_CODE).not.toMatch(/record_version\s*=\s*record_version\s*\+\s*1/);
    // snapshot version 1 + current_snapshot_id set atomically in the flip.
    expect(SQL_CODE).toMatch(/current_snapshot_id = v_snap_id/);
    expect(SQL_CODE).toMatch(/return query select v_snap_id, 1, v_hash, false/);
  });

  it("is idempotent (studio-locked; returns THIS session's snapshot), DB-timed, and PHI-free in audit", () => {
    expect(SQL_CODE).toMatch(/if v_status = 'finalized' then[\s\S]*already_finalized|return query select v_snap_id, v_snap_ver, v_hash, true/);
    expect(SQL_CODE).toMatch(/finalized_at = now\(\)/);
    // Deterministic hash via pgcrypto digest (extensions schema).
    expect(SQL_CODE).toMatch(/encode\(extensions\.digest\(v_snapshot::text, 'sha256'\), 'hex'\)/);
    // Audit event carries only lifecycle transition, no PHI.
    expect(SQL_CODE).toMatch(/'record_status', 'draft', 'finalized'/);
  });

  it("execute is revoked from anon/public and granted only to authenticated", () => {
    expect(SQL_CODE).toMatch(/revoke execute on function public\.finalize_session\(uuid, integer\) from anon, public/);
    expect(SQL_CODE).toMatch(/grant execute on function public\.finalize_session\(uuid, integer\) to authenticated/);
  });
});
