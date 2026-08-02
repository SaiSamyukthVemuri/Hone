import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Migration 0164 — L18 Phase 1A. A narrow SECURITY DEFINER create command for
// the ONE genuinely entry-only writer (addLaserEntryAction). Purely additive:
// no grant is revoked and no policy is dropped, so direct DML keeps working
// through this whole phase.
//
// electrolysis_entries is NOT touched by this migration. All three of its
// writers are block-coupled — including addElectrolysisEntryAction, which via
// ensureBlockForSession can INSERT a session_blocks row before the entry when
// the submitted form omits block_id — so they move together in the combined
// session_blocks/electrolysis_entries phase.
//
// This file carries the REPO migration-max pin (it moved off the 0163 test when
// 0164 landed). 0164 is NOT applied, so unlike 0159-0163 it is deliberately NOT
// checksum-frozen — it may still be revised until it is applied.
//
// Behavioural proof: tests/db/entry-create-commands.db.test.ts.

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0164_")) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");
const PROSE = SQL.replace(/^\s*--\s?/gm, "").replace(/\s+/g, " ");
const CODE = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const FLAT_CODE = CODE.replace(/\s+/g, " ");

describe("0164 — clean laser entry create command (repo migration-max tripwire)", () => {
  it("is present, 0163 precedes it, exactly one 0164, and it is the repo max", () => {
    expect(FILE).toMatch(/^0164_.*\.sql$/);
    const files = readdirSync(MIG_DIR);
    expect(files.some((f) => f.startsWith("0163_"))).toBe(true);
    expect(files.filter((f) => /^0164_/.test(f))).toHaveLength(1);
    expect(files.filter((f) => /^01(6[6-9]|[7-9]\d)_/.test(f))).toEqual([]);
    expect(files.filter((f) => /^0[2-9]\d\d_/.test(f))).toEqual([]);
    const nums = files
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .map((f) => parseInt(f.slice(0, 4), 10))
      .sort((a, b) => a - b);
    expect(nums[nums.length - 1]).toBe(165);
    expect(new Set(nums).size).toBe(nums.length);
    expect(files.filter((f) => /^0158_/.test(f))).toEqual([]);
  });

  it("declares its migration-max transition", () => {
    expect(PROSE).toMatch(/Migration max 0163 -> 0164/i);
  });
});

describe("0164 — transactional with an armed lock_timeout", () => {
  it("opens its own transaction and commits exactly once", () => {
    expect(CODE.match(/^\s*begin\s*;/gim) ?? []).toHaveLength(1);
    expect(CODE.match(/^\s*commit\s*;/gim) ?? []).toHaveLength(1);
  });

  it("arms lock_timeout INSIDE the transaction", () => {
    const b = FLAT_CODE.search(/\bbegin\s*;/i);
    const l = FLAT_CODE.search(/set local lock_timeout\s*=\s*'5s'/i);
    const c = FLAT_CODE.search(/\bcommit\s*;/i);
    expect(b).toBeGreaterThan(-1);
    expect(l).toBeGreaterThan(b);
    expect(c).toBeGreaterThan(l);
  });

  it("explains the 25P01 lesson", () => {
    expect(PROSE).toMatch(/does NOT wrap a migration file in an explicit transaction/i);
    expect(PROSE).toMatch(/25P01/);
  });
});

describe("0164 — the command meets the command contract", () => {
  it("is SECURITY DEFINER with search_path = ''", () => {
    expect(FLAT_CODE).toMatch(/security definer/i);
    expect(FLAT_CODE).toMatch(/set search_path = ''/i);
  });

  it("requires a non-null auth.uid()", () => {
    expect(FLAT_CODE).toMatch(/if auth\.uid\(\) is null then/i);
    expect(FLAT_CODE).toMatch(/An authenticated practitioner is required\./);
  });

  it("derives studio + client from the trusted sessions row", () => {
    expect(FLAT_CODE).toMatch(
      /select s\.studio_id, s\.client_id into v_studio_id, v_client_id from public\.sessions s/i,
    );
  });

  it("requires an ACTIVE practitioner matched by auth.uid() in the session's studio", () => {
    expect(FLAT_CODE).toMatch(/from public\.practitioners p/i);
    expect(FLAT_CODE).toMatch(/p\.studio_id = s\.studio_id/i);
    expect(FLAT_CODE).toMatch(/p\.user_id = auth\.uid\(\)/i);
    expect(FLAT_CODE).toMatch(/p\.active = true/i);
  });

  it("re-checks the asserted client against the session's real client", () => {
    expect(FLAT_CODE).toMatch(/p_client_id is distinct from v_client_id/i);
    expect(FLAT_CODE).toMatch(/Session does not belong to that client\./);
  });

  it("takes NO caller-supplied studio, practitioner or actor id", () => {
    const sig = FLAT_CODE.slice(
      FLAT_CODE.indexOf("create or replace function public.create_laser_entry"),
      FLAT_CODE.indexOf("returns uuid"),
    );
    expect(sig).not.toMatch(/p_studio_id/i);
    expect(sig).not.toMatch(/p_practitioner_id/i);
    expect(sig).not.toMatch(/p_created_by|p_actor|p_user_id/i);
  });

  it("uses no dynamic SQL and no generic JSON patch", () => {
    expect(FLAT_CODE).not.toMatch(/\bexecute\s+format\(/i);
    expect(FLAT_CODE).not.toMatch(/\bexecute\s+'/i);
    expect(FLAT_CODE).not.toMatch(/jsonb_populate_record|jsonb_each|->>\s*key/i);
  });

  it("returns only the new row id", () => {
    expect(FLAT_CODE.match(/returns uuid/gi) ?? []).toHaveLength(1);
    expect(FLAT_CODE).toMatch(/returning id into v_entry_id/i);
  });

  it("errors are stable and non-sensitive", () => {
    const raises = SQL.match(/raise exception '([^']+)'/g) ?? [];
    expect(raises.length).toBeGreaterThanOrEqual(2);
    for (const r of raises) {
      expect(r).not.toMatch(/%|\|\||v_client_id|p_session_id/);
    }
  });
});

describe("0164 — least-privilege EXECUTE", () => {
  it("revoked from PUBLIC and anon, granted to authenticated only", () => {
    expect(FLAT_CODE).toMatch(
      /revoke execute on function public\.create_laser_entry[^;]*from public/i,
    );
    expect(FLAT_CODE).toMatch(
      /revoke execute on function public\.create_laser_entry[^;]*from anon/i,
    );
    expect(FLAT_CODE).toMatch(
      /grant execute on function public\.create_laser_entry[^;]*to authenticated/i,
    );
  });

  it("is NOT granted to service_role", () => {
    expect(FLAT_CODE).not.toMatch(
      /grant execute on function public\.create_laser_entry[^;]*to[^;]*service_role/i,
    );
  });

  it("carries the 0129/0130 anon-EXECUTE lesson", () => {
    expect(PROSE).toMatch(/ALTER DEFAULT PRIVILEGES/i);
    expect(PROSE).toMatch(/0129 revoked only .from public./i);
  });
});

describe("0164 — laser-only, additive, and honest about scope", () => {
  it("creates NO electrolysis command", () => {
    expect(
      FLAT_CODE,
      "0164 is laser-only — electrolysis moves with the block phase",
    ).not.toMatch(/create or replace function public\.create_electrolysis_entry/i);
  });

  it("creates exactly one function", () => {
    expect(FLAT_CODE.match(/create or replace function/gi) ?? []).toHaveLength(1);
  });

  it("revokes NO table privilege and drops NO policy", () => {
    expect(FLAT_CODE).not.toMatch(
      /revoke[^;]*on public\.(electrolysis_entries|laser_entries)/i,
    );
    expect(FLAT_CODE).not.toMatch(/drop policy/i);
    expect(FLAT_CODE).not.toMatch(/revoke\s+(insert|update|delete)\s+on/i);
  });

  it("makes no schema, column, constraint, index or trigger change", () => {
    expect(FLAT_CODE).not.toMatch(/\bcreate table\b|\balter table\b/i);
    expect(FLAT_CODE).not.toMatch(/\badd column\b|\bdrop column\b/i);
    expect(FLAT_CODE).not.toMatch(/\bcreate index\b|\bdrop index\b/i);
    expect(FLAT_CODE).not.toMatch(/\bcreate trigger\b|\bdrop trigger\b/i);
  });

  it("performs no data rewrite", () => {
    expect(FLAT_CODE).not.toMatch(/\bupdate public\./i);
    expect(FLAT_CODE).not.toMatch(/\bdelete from\b/i);
    expect(FLAT_CODE).not.toMatch(/\btruncate\b/i);
  });

  it("names ALL THREE deferred block-coupled electrolysis writers", () => {
    expect(PROSE).toMatch(/addElectrolysisEntryAction/);
    expect(PROSE).toMatch(/createTreatmentAreaWithEntryAction/);
    expect(PROSE).toMatch(/updateTreatmentAreaWithEntryAction/);
    expect(PROSE).toMatch(/ensureBlockForSession/);
    expect(PROSE).toMatch(/combined session_blocks\/electrolysis_entries phase/i);
  });

  it("makes NO claim that electrolysis_entries is command-bound", () => {
    expect(PROSE).toMatch(/MAKES NO CLAIM ABOUT electrolysis_entries/i);
  });

  it("records the corrected 25-writer count and does NOT claim L18 closed", () => {
    expect(PROSE).toMatch(/25 runtime write sites/i);
    expect(PROSE).toMatch(/NOT the 26 the findings register claims/i);
    expect(PROSE).toMatch(/L18 REMAINS OPEN/i);
    expect(PROSE).toMatch(/moves ONE of 25 runtime writers/i);
  });

  it("states that existing guard triggers and CHECKs remain the validation authority", () => {
    expect(PROSE).toMatch(/guard_finalized_clinical_write/);
    expect(PROSE).toMatch(/guard_immutable_clinical_lineage/);
    expect(PROSE).toMatch(/Validation is therefore preserved EXACTLY/i);
  });
});
