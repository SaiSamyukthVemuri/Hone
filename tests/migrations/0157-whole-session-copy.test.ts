import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Migration 0157 — whole-session "Copy areas and settings": a provenance ledger
// + a service_role-only, source-authoritative, atomic, idempotent copy RPC, plus
// a member-gated preview descriptor and a private source-fingerprint helper.
// Additive; carries the repo migration-max tripwire.

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0157_")) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");
const CODE = SQL.split("\n")
  .filter((l) => !/^\s*--/.test(l))
  .join("\n");

describe("0157 — whole-session copy (repo migration-max tripwire)", () => {
  it("is present, 0156 precedes it, exactly one 0157, nothing 0160+ (repo max pin now lives in the 0159 test)", () => {
    expect(FILE).toMatch(/^0157_.*\.sql$/);
    const files = readdirSync(MIG_DIR);
    expect(files.some((f) => f.startsWith("0156_"))).toBe(true);
    expect(files.filter((f) => /^0157_/.test(f))).toHaveLength(1);
    expect(files.filter((f) => /^01(6[5-9]|[7-9]\d)_/.test(f))).toEqual([]);
    // The absolute repo-max pin moved to the 0159 test (0159 = retire signed
    // clinical records; 0158 is intentionally skipped, see that test).
  });

  it("adds a PROVENANCE ledger (source+target+practitioner+hash+fingerprint), member-only RLS, no browser DML", () => {
    expect(SQL).toMatch(/create table if not exists public\.session_copy_operations/);
    for (const col of [
      "target_session_id",
      "source_session_id",
      "created_by_practitioner_id",
      "request_hash",
      "source_fingerprint",
      "copied_block_count",
    ]) {
      expect(CODE).toMatch(new RegExp(`\\b${col}\\b`));
    }
    // Idempotency is scoped to the TARGET session + key.
    expect(SQL).toMatch(
      /constraint session_copy_operations_idem_uniq unique \(target_session_id, idempotency_key\)/,
    );
    // Same-studio composite FKs for source, target, AND the committing practitioner.
    expect(SQL).toMatch(/foreign key \(studio_id, target_session_id\)[\s\S]{0,80}references public\.sessions \(studio_id, id\)/);
    expect(SQL).toMatch(/foreign key \(studio_id, source_session_id\)[\s\S]{0,80}references public\.sessions \(studio_id, id\)/);
    expect(SQL).toMatch(/foreign key \(created_by_practitioner_id, studio_id\)[\s\S]{0,80}references public\.practitioners \(id, studio_id\)/);
    // No clinical payload column on the ledger.
    expect(CODE).not.toMatch(/\bspecs\b\s+jsonb/);
    // RLS: member SELECT only; EXPLICIT least-privilege grants.
    expect(SQL).toMatch(/enable row level security/);
    expect(SQL).toMatch(/for select to authenticated/i);
    expect(SQL).not.toMatch(/for insert to authenticated/i);
    expect(SQL).not.toMatch(/for update to authenticated/i);
    expect(SQL).not.toMatch(/for delete/i);
    // COMPLETE least-privilege posture (P1 privilege hardening): revoke ALL table
    // privileges from the browser roles (covers TRUNCATE/REFERENCES/TRIGGER, which
    // RLS does NOT protect — not just DML), then grant back ONLY SELECT to
    // authenticated. A partial `revoke insert, update, delete` is insufficient.
    expect(CODE).toMatch(
      /revoke all on table public\.session_copy_operations\s+from public, anon, authenticated/,
    );
    expect(CODE).toMatch(
      /grant select on table public\.session_copy_operations\s+to authenticated/,
    );
    // The old incomplete DML-only revoke must be gone.
    expect(CODE).not.toMatch(/revoke insert, update, delete on public\.session_copy_operations/);
    // created_by stores the PRACTITIONER, not auth.uid().
    expect(CODE).not.toMatch(/created_by_practitioner_id[^\n]*auth\.uid/);
  });

  it("the copy RPC is service_role-ONLY (browser cannot call it directly)", () => {
    expect(SQL).toMatch(/create or replace function public\.copy_session_setup/);
    expect(SQL).toMatch(/security definer/);
    expect(SQL).toMatch(/set search_path = ''/);
    // Grant model: revoked from authenticated + anon; granted to service_role ONLY.
    expect(SQL).toMatch(
      /revoke all on function public\.copy_session_setup\(uuid, uuid, uuid, jsonb, text, text, uuid\) from public, anon, authenticated/,
    );
    expect(SQL).toMatch(
      /grant execute on function public\.copy_session_setup\(uuid, uuid, uuid, jsonb, text, text, uuid\) to service_role;/,
    );
    // NOT granted to authenticated.
    expect(SQL).not.toMatch(/grant execute on function public\.copy_session_setup[^\n]*authenticated/);
  });

  it("enforces authorization + session-wide serialization + source authority + stale detection", () => {
    // Practitioner-based membership check (service_role bypasses RLS, so no auth.uid()).
    expect(CODE).toMatch(/from public\.practitioners[\s\S]{0,120}active = true/);
    // TARGET row lock serializes all commits for one target (key-independent).
    expect(CODE).toMatch(/from public\.sessions[\s\S]{0,200}for update/i);
    // Target must be an empty electrolysis draft.
    expect(CODE).toMatch(/record_status/);
    expect(CODE).toMatch(/electrolysis/);
    expect(CODE).toMatch(/from public\.session_blocks[\s\S]{0,120}deleted_at is null/);
    expect(CODE).toMatch(/from public\.electrolysis_entries[\s\S]{0,120}deleted_at is null/);
    // SOURCE is server-derived (not browser-chosen) + fingerprint verified.
    expect(CODE).toMatch(/_whole_session_copy_source_id\(p_studio_id, p_target_session_id\)/);
    expect(CODE).toMatch(/_whole_session_copy_fingerprint\(/);
    expect(CODE).toMatch(/p_expected_source_fingerprint/);
    // The source id is REQUIRED (no default) and must match the derived source.
    expect(CODE).not.toMatch(/p_expected_source_session_id\s+uuid\s+default/);
    expect(CODE).toMatch(/p_expected_source_session_id is null/);
    expect(CODE).toMatch(/p_expected_source_session_id <> v_source/);
    // SOURCE is pinned against concurrent edits: session + blocks + areas + entries
    // are locked FOR UPDATE, and the source is re-derived after the session lock.
    expect(CODE).toMatch(/from public\.sessions where id = v_source for update/);
    expect(CODE).toMatch(/from public\.session_blocks sb[\s\S]{0,200}for update/);
    expect(CODE).toMatch(/from public\.session_block_areas sba[\s\S]{0,260}for update/);
    expect(CODE).toMatch(/from public\.electrolysis_entries se[\s\S]{0,200}for update/);
    // Request hash is SHA-256 (pgcrypto) over target + source id + fingerprint + specs.
    expect(CODE).toMatch(/extensions\.digest\([\s\S]{0,200}'sha256'\)/);
    expect(CODE).not.toMatch(/v_req_hash\s*:=\s*md5\(/);
    expect(CODE).toMatch(/p_expected_source_session_id::text/);
    // Stable custom SQLSTATEs the app maps to safe messages.
    for (const code of ["HN001", "HN002", "HN003", "HN004", "HN005", "HN006", "HN007"]) {
      expect(CODE).toMatch(new RegExp(`errcode = '${code}'`));
    }
  });

  it("the source resolver excludes VOID sessions and accepts legacy-only blocks", () => {
    // Void excluded (draft + finalized still valid historical sources).
    expect(CODE).toMatch(/record_status is distinct from 'void'/);
    // Copyable = (structured area OR nonblank legacy primary_area) AND a valid mode.
    expect(CODE).toMatch(/coalesce\(btrim\(b\.primary_area\), ''\) <> ''/);
    expect(CODE).toMatch(/in \('thermo', 'galv', 'blend'\)/);
  });

  it("SETUP-ONLY: the block + entry INSERT lists carry NO outcome columns and NO minutes_performed", () => {
    for (const outcome of [
      "comments",
      "observation_chips",
      "hairs_treated",
      "tolerance_rating",
      "reaction_type",
      "reaction_notes",
      "caution_for_next_session",
      "caution_note",
      "numbing_status",
      "numbing_notes",
      "probe_lot_number",
      "probe_lot_confirmed",
      "probe_inventory_item_id",
      "probe_lot_id",
    ]) {
      expect(CODE).not.toMatch(new RegExp(`\\b${outcome}\\b`));
    }
    // P1-5: minutes are never written by the copy (not in any INSERT, not in the fingerprint).
    expect(CODE).not.toMatch(/\bminutes_performed\b/);
  });

  it("Phase B: galvanic_intensity_percent is RETIRED — excluded from the fingerprint and forced NULL on insert", () => {
    // The retired reading is NEVER derived from the source entry `e` — neither in
    // the source fingerprint nor in the destination INSERT. (A historical change
    // to only that field therefore can't invalidate a preview, and a copied entry
    // can't inherit the value.)
    expect(CODE).not.toMatch(/e\.galvanic_intensity_percent/);
    // The destination INSERT forces a LITERAL NULL in the galvanic-intensity slot
    // (right after galvanic_duration_seconds), so even a forged spec stores NULL.
    expect(CODE).toMatch(/e\.galvanic_duration_seconds,\s*NULL,/);
    // The column itself is still referenced (kept in the INSERT column list — the
    // schema column is preserved, only the copied VALUE is retired).
    expect(CODE).toMatch(/\bgalvanic_intensity_percent\b/);
  });

  it("has a member-gated preview descriptor (authenticated) + a PRIVATE fingerprint helper", () => {
    expect(SQL).toMatch(/create or replace function public\.whole_session_copy_source_descriptor/);
    expect(CODE).toMatch(/is_studio_member\(p_studio_id\)/);
    expect(SQL).toMatch(
      /grant execute on function public\.whole_session_copy_source_descriptor\(uuid, uuid\) to authenticated, service_role/,
    );
    // Core helpers are private (revoked from authenticated).
    expect(SQL).toMatch(
      /revoke all on function public\._whole_session_copy_fingerprint\(uuid\) from public, anon, authenticated/,
    );
    expect(SQL).toMatch(
      /revoke all on function public\._whole_session_copy_source_id\(uuid, uuid\) from public, anon, authenticated/,
    );
  });

  it("is additive: no ALTER/DROP of existing tables, no backfill, no change to the 0129/0155/0156 block RPCs", () => {
    expect(CODE).not.toMatch(/alter table public\.session_blocks/i);
    expect(CODE).not.toMatch(/alter table public\.electrolysis_entries/i);
    expect(CODE).not.toMatch(/alter table public\.sessions/i);
    expect(CODE).not.toMatch(/drop /i);
    expect(CODE).not.toMatch(/create or replace function public\.create_session_block_with_areas/);
    expect(CODE).not.toMatch(/create or replace function public\.update_session_block_with_areas/);
    expect(CODE).not.toMatch(/update public\.(session_blocks|electrolysis_entries)/i);
  });

  it("documents a MIGRATION-FIRST rollout and touches no unrelated surface", () => {
    expect(SQL).toMatch(/MIGRATION-FIRST \(DB-first\)/i);
    expect(SQL).toMatch(/app-first is NOT safe/i);
    for (const forbidden of [
      /stripe/i, /payment/i, /appointment/i, /\bconsent/i, /\bemail/i, /\bsms\b/i,
      /probe_lots\b/, /electrolysis_entries\.probe_lot_id/,
    ]) {
      expect(CODE).not.toMatch(forbidden);
    }
  });
});

describe("0157 rollout is documented as MIGRATION-FIRST (no app-first claim)", () => {
  const ROLLOUT = readFileSync(
    join(process.cwd(), "docs/runbooks/0157-whole-session-copy-rollout.md"),
    "utf8",
  );
  const FORBIDDEN = [
    /app[-\s]?first\s+(deployment\s+)?(is\s+)?(perfectly\s+|totally\s+)?safe/i,
    /safe\s+to\s+(deploy|ship|merge)\s+(the\s+)?app(lication)?\s+(first|before)/i,
    /inert\s+until\s+(the\s+)?migration/i,
  ];
  for (const [label, text] of [
    ["rollout runbook", ROLLOUT],
    ["migration header", SQL],
  ] as const) {
    it(`${label} never claims app-first is safe`, () => {
      for (const bad of FORBIDDEN) expect(text).not.toMatch(bad);
    });
  }
  it("the runbook states the DB-first order (migration before merge)", () => {
    expect(ROLLOUT).toMatch(/MIGRATION-FIRST|DB-first/i);
    expect(ROLLOUT).toMatch(/app-first is NOT\s+safe/i);
    expect(ROLLOUT).toMatch(/apply migration\s+0157\s+to production \*{0,2}BEFORE\*{0,2}\s+merging/i);
    expect(ROLLOUT).toMatch(/do not apply 0157 to production or any remote/i);
  });
});
