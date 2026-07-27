import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Migration 0158 — CONTAINMENT for the P0 "finalized structured treatment areas
// are mutable, unsigned and outside the correction lineage". 0128 made
// public.session_block_areas the AUTHORITATIVE area + laterality representation
// but shipped it outside 0119's finalized-write guard, outside least privilege
// (authenticated held EVERY table privilege) and outside build_session_snapshot,
// so a finalized record's treated areas could be rewritten without moving
// record_status, record_version or the signed content_hash. 0158 adds a
// finalized-parent trigger, revokes browser DML, narrows the 0128 FOR ALL policy
// to SELECT, and locks the parent encounter inside both charting RPCs. It is
// purely schema-level: ZERO data operations. Carries the repo migration-max
// tripwire (moved here from the 0157 test).

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0158_")) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");
// Executable DDL only (whole-line comments stripped) for the "never contains X"
// greps: the header names the very operations this migration avoids, and must be
// able to neither satisfy nor trip them.
const CODE = SQL.split("\n")
  .filter((l) => !/^\s*--/.test(l))
  .join("\n");
// The same DDL with every $$-quoted function body elided. A statement that
// survives here is a statement the MIGRATION ITSELF runs at apply time; a
// statement inside a body only ever runs later, when the app calls the RPC. This
// is what makes "zero data operations" provable without a false failure on the
// `delete from public.session_block_areas` that lives INSIDE
// update_session_block_with_areas (pre-existing replace semantics, not a data op).
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, "\n<<function body elided>>\n");

/** Header + body of one `create or replace function public.<name>(...)` block. */
function fn(name: string): string {
  const start = CODE.indexOf(`create or replace function public.${name}(`);
  expect(start, `public.${name} is defined`).toBeGreaterThan(-1);
  const open = CODE.indexOf("$$", start);
  const close = CODE.indexOf("$$", open + 2);
  expect(close, `public.${name} body is $$-quoted`).toBeGreaterThan(open);
  return CODE.slice(start, close + 2);
}

/** The single statement beginning with `head` (up to its terminating `;`). */
function stmt(head: string): string {
  const start = CODE.indexOf(head);
  expect(start, `statement "${head}" is present`).toBeGreaterThan(-1);
  return CODE.slice(start, CODE.indexOf(";", start) + 1);
}

const GUARD_FNS = [
  "assert_session_chartable",
  "assert_structured_area_parent_mutable",
  "guard_finalized_structured_area_write",
] as const;

describe("0158 — structured-area containment (repo migration-max tripwire)", () => {
  it("is present, 0157 and 0128 precede it, exactly one 0158, and it is the repo max (nothing 0159+)", () => {
    expect(FILE).toMatch(/^0158_.*\.sql$/);
    const files = readdirSync(MIG_DIR);
    expect(files.some((f) => f.startsWith("0157_"))).toBe(true);
    // 0128 created the table this migration contains.
    expect(files.some((f) => f.startsWith("0128_"))).toBe(true);
    // Collision guard: exactly ONE migration per number.
    expect(files.filter((f) => /^0158_/.test(f))).toHaveLength(1);
    // Absolute repo-max pin. Move it to the next migration's test when one lands.
    expect(files.filter((f) => /^01(59|[6-9]\d)_/.test(f))).toEqual([]);
    const nums = readdirSync(MIG_DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .map((f) => parseInt(f.slice(0, 4), 10))
      .sort((a, b) => a - b);
    expect(nums[nums.length - 1]).toBe(158);
    // No duplicate number anywhere in the chain (the same one-per-number rule,
    // applied to the whole directory rather than just to 0158).
    expect(new Set(nums).size).toBe(nums.length);
  });

  it("satisfies the repo extension-qualification guard (no bare pgcrypto/uuid-ossp call)", () => {
    // Mirrors scripts/check-migration-extension-qualification.mjs, which `npm run
    // ci` executes: on a fresh MANAGED Supabase project these live in `extensions`,
    // off the migration search_path, so a bare call fails at plan time (42883).
    for (const f of [
      "gen_random_bytes",
      "digest",
      "hmac",
      "gen_salt",
      "crypt",
      "pgp_sym_encrypt",
      "pgp_sym_decrypt",
      "uuid_generate_v4",
    ]) {
      expect(CODE, f).not.toMatch(new RegExp(`(?<![\\w.])${f}\\s*\\(`));
    }
  });
});

describe("0158 — finalized-parent guard trigger on public.session_block_areas", () => {
  it("installs a BEFORE INSERT OR UPDATE OR DELETE ... FOR EACH ROW trigger (the 0119 shape 0128 never got)", () => {
    expect(CODE).toMatch(
      /drop trigger if exists session_block_areas_guard_finalized on public\.session_block_areas;/,
    );
    expect(CODE).toMatch(
      /create trigger session_block_areas_guard_finalized\s+before insert or update or delete on public\.session_block_areas\s+for each row execute function public\.guard_finalized_structured_area_write\(\);/,
    );
    // No WHEN clause: the guard must not be conditionally skippable for any role.
    expect(stmt("create trigger session_block_areas_guard_finalized")).not.toMatch(
      /\bwhen\s*\(/i,
    );
    // The 0128 studio-derive trigger is WIDENED (review finding): it previously
    // fired only on `update of session_block_id`, so a studio_id-only UPDATE
    // escaped the anti-spoof derivation and could re-tenant a row. It is
    // recreated over both columns; its FUNCTION is untouched.
    expect(CODE).toMatch(
      /drop trigger if exists session_block_areas_derive_studio on public\.session_block_areas;/,
    );
    expect(CODE).toMatch(
      /create trigger session_block_areas_derive_studio\s+before insert or update of session_block_id, studio_id on public\.session_block_areas\s+for each row execute function public\.session_block_areas_derive_studio\(\);/,
    );
    // The column list stays narrow: an unrestricted UPDATE clause would make this
    // INVOKER trigger resolve the parent block on every edit.
    expect(stmt("create trigger session_block_areas_derive_studio")).not.toMatch(
      /before insert or update on public\.session_block_areas/,
    );
    // The derive FUNCTION is not redefined here.
    expect(CODE).not.toMatch(
      /create or replace function public\.session_block_areas_derive_studio\(/,
    );
  });

  it("the guard and both lifecycle asserts are SECURITY DEFINER with a pinned empty search_path", () => {
    for (const name of GUARD_FNS) {
      const body = fn(name);
      expect(body, name).toMatch(/security definer/);
      expect(body, name).toMatch(/set search_path = ''/);
      // A writable/searchable path would let a caller shadow `sessions`.
      expect(body, name).not.toMatch(/set search_path = (public|"\$user")/);
    }
  });

  it("locks public.sessions FOR NO KEY UPDATE — excludes finalization, not FK child inserts", () => {
    // Review finding (reproduced as SQLSTATE 40P01): `for update` here deadlocks
    // against soft_delete_session_area (0123), which locks a session_blocks row
    // FIRST and only then inserts its session_audit row — an insert that needs
    // FOR KEY SHARE on the same session. FOR NO KEY UPDATE still conflicts with
    // the FOR UPDATE that finalize_session / correct_finalized_session /
    // copy_session_setup take, and with itself, so the serialization guarantee is
    // unchanged; it simply stops blocking child inserts that never conflicted.
    for (const name of ["assert_session_chartable", "assert_structured_area_parent_mutable"]) {
      expect(fn(name), name).toMatch(
        /from public\.sessions s\s+where s\.id = p_session_id\s+for no key update;/,
      );
      expect(fn(name), name).not.toMatch(/\bfor update;/);
    }
    // Every guard branch routes through that lock: DELETE, UPDATE(old parent),
    // UPDATE(new parent), INSERT — four call sites, no unguarded path.
    const guard = fn("guard_finalized_structured_area_write");
    expect(guard.match(/perform public\.assert_structured_area_parent_mutable\(/g) ?? [])
      .toHaveLength(4);
    // Only the DELETE path tolerates a soft-deleted parent (ordinary cleanup);
    // INSERT/UPDATE require a live draft.
    expect(guard.match(/assert_structured_area_parent_mutable\(v_session_id, true\)/g) ?? [])
      .toHaveLength(1);
    expect(guard.match(/assert_structured_area_parent_mutable\(v_session_id, false\)/g) ?? [])
      .toHaveLength(3);
    // Once finalized, ALWAYS frozen: both asserts reject on the finalization
    // EVIDENCE too, so a record_status round-trip through the 0120 permit cannot
    // reopen the write window. The snapshot-existence probe is the tamper-resistant
    // leg (clinical_record_snapshots is append-only for every role, 0119).
    for (const name of ["assert_session_chartable", "assert_structured_area_parent_mutable"]) {
      const body = fn(name);
      expect(body, name).toMatch(/v_final is not null or v_snap is not null/);
      expect(body, name).toMatch(
        /exists \(select 1 from public\.clinical_record_snapshots cs\s+where cs\.session_id = p_session_id\)/,
      );
      expect(body, name).toMatch(/finalized and signed/i);
      expect(body, name).toMatch(/s\.finalized_at, s\.current_snapshot_id/);
    }
    // Both asserts reject a non-draft parent (finalized AND void).
    for (const name of ["assert_session_chartable", "assert_structured_area_parent_mutable"]) {
      expect(fn(name), name).toMatch(/v_status is distinct from 'draft'/);
    }
    expect(fn("assert_session_chartable")).toMatch(/v_deleted is not null/);
  });

  it("resolves the parent SERVER-SIDE and checks BOTH parents on UPDATE (reassignment + reorder covered)", () => {
    const guard = fn("guard_finalized_structured_area_write");
    // Never trusts a caller-supplied session id: the parent is looked up from the
    // row's own session_block_id.
    expect(guard).toMatch(
      /select b\.session_id into v_session_id\s+from public\.session_blocks b where b\.id = old\.session_block_id;/,
    );
    expect(guard).toMatch(
      /select b\.session_id into v_session_id\s+from public\.session_blocks b where b\.id = new\.session_block_id;/,
    );
    const update = guard.slice(
      guard.indexOf("if tg_op = 'UPDATE' then"),
      guard.indexOf("if tg_op = 'UPDATE' then") + guard.slice(guard.indexOf("if tg_op = 'UPDATE' then")).indexOf("return new;"),
    );
    // Old parent first (value edits, display_order reorder, moving a row OUT)...
    expect(update).toMatch(/old\.session_block_id/);
    // ...then the new parent when the row is reassigned (moving a row IN).
    expect(update).toMatch(/new\.session_block_id is distinct from old\.session_block_id/);
    expect(update).toMatch(/new\.session_block_id;/);
    expect(update.match(/perform public\.assert_structured_area_parent_mutable\(/g) ?? [])
      .toHaveLength(2);
  });

  it("tolerates ONLY the FK ON DELETE CASCADE cleanup path", () => {
    const guard = fn("guard_finalized_structured_area_write");
    const del = guard.slice(
      guard.indexOf("if tg_op = 'DELETE' then"),
      guard.indexOf("if tg_op = 'UPDATE' then"),
    );
    // Parent block already gone => the row trigger can only be running under the
    // studios -> sessions -> session_blocks -> session_block_areas cascade, which
    // the 0119 delete guards already prove descends from a non-finalized parent.
    expect(del).toMatch(/if not found then\s+return old;\s+end if;/);
    // Every OTHER missing-parent case is a hard error, never a silent allow.
    expect(guard.match(/does not reference an existing settings block/g) ?? [])
      .toHaveLength(3);
  });
});

describe("0158 — NO correction-context bypass", () => {
  it("never reads a hone.correction_session_id permit", () => {
    // 0120 gives the 0119 guard a narrow transaction-local correction permit
    // (`hone.correction_session_id`) because sessions/blocks/entries/images all
    // have a typed correction applier AND a snapshot representation, so a
    // permitted write is versioned and restorable. Structured areas have NEITHER
    // today: they are not in build_session_snapshot and there is no area applier.
    // Honouring the permit here would therefore let a "correction" silently
    // rewrite the authoritative areas of a finalized record with no signed
    // artifact and no way back — a hole, not a feature. Absence is the contract
    // until snapshot v2 ships. Asserted on the EXECUTABLE text: the header
    // deliberately names the GUC when explaining why it is not honoured, and when
    // explaining the once-finalized-always-frozen check that closes the status
    // round-trip the permit would otherwise enable.
    expect(CODE).not.toMatch(/hone\.correction_session_id/);
    expect(CODE).not.toMatch(/current_setting\(/);
    // …and the header must still explain the decision, so a future reader cannot
    // mistake the omission for an oversight.
    expect(SQL).toMatch(/hone\.correction_session_id/);
  });

  it("has no role-based, GUC-based or auth.uid()-based escape hatch in the integrity path", () => {
    for (const name of GUARD_FNS) {
      const body = fn(name);
      expect(body, name).not.toMatch(/service_role/i);
      expect(body, name).not.toMatch(/auth\.uid\(\)\s+is\s+null/i);
      expect(body, name).not.toMatch(/current_setting\(/);
      expect(body, name).not.toMatch(/trusted_clinical_write/);
    }
  });
});

describe("0158 — least privilege on public.session_block_areas", () => {
  it("revokes ALL table privileges from public, anon AND authenticated", () => {
    // `revoke all`, not `revoke insert, update, delete`: RLS does not protect
    // TRUNCATE, REFERENCES or TRIGGER, and production had authenticated holding
    // the FULL privilege set on this table.
    for (const role of ["public", "anon", "authenticated"]) {
      expect(CODE, role).toMatch(
        new RegExp(`revoke all on table public\\.session_block_areas from ${role};`),
      );
    }
    // The incomplete DML-only form must not stand in for it.
    expect(CODE).not.toMatch(
      /revoke (select, )?insert, update, delete on (table )?public\.session_block_areas/,
    );
    // The 0128 posture is gone.
    expect(CODE).not.toMatch(
      /grant select, insert, update, delete on public\.session_block_areas to authenticated/,
    );
  });

  it("grants back to authenticated EXACTLY select — no write privilege survives anywhere in the file", () => {
    expect(CODE).toMatch(/grant select on table public\.session_block_areas to authenticated;/);
    // Structural sweep of every TABLE grant in the file (function grants carry an
    // argument list and are excluded by the `public.<ident> to` shape): any grant
    // naming `authenticated` must confer SELECT and nothing else.
    const tableGrants = [
      ...CODE.matchAll(/grant\s+([a-z, ]+?)\s+on\s+(?:table\s+)?(public\.\w+)\s+to\s+([a-z_, ]+?)\s*;/gi),
    ];
    expect(tableGrants.length).toBeGreaterThan(0);
    for (const [statement, privileges, , roles] of tableGrants) {
      if (!/\bauthenticated\b/.test(roles)) continue;
      expect(privileges.trim().toLowerCase(), statement).toBe("select");
    }
    // Plain-text backstop for the same rule.
    expect(CODE).not.toMatch(/grant[^;]*\binsert\b[^;]*\bauthenticated\b/i);
    expect(CODE).not.toMatch(/grant[^;]*\bupdate\b[^;]*\bauthenticated\b/i);
    expect(CODE).not.toMatch(/grant[^;]*\bdelete\b[^;]*\bauthenticated\b/i);
    expect(CODE).not.toMatch(/grant[^;]*\btruncate\b[^;]*\bauthenticated\b/i);
  });

  it("service_role keeps DML and gains NO finalized-record bypass (the trigger still binds it)", () => {
    expect(CODE).toMatch(
      /grant select, insert, update, delete on table public\.session_block_areas to service_role;/,
    );
    // Proven by the guard containing no service_role branch (asserted above) and
    // by the trigger carrying no WHEN clause.
    expect(CODE).not.toMatch(/alter table public\.session_block_areas[\s\S]{0,80}disable trigger/i);
  });

  it("drops the 0128 FOR ALL policy and replaces it with a SELECT-only policy", () => {
    expect(CODE).toMatch(
      /drop policy if exists "session_block_areas_member_all" on public\.session_block_areas;/,
    );
    expect(CODE).toMatch(
      /create policy "session_block_areas_member_select"\s+on public\.session_block_areas for select to authenticated\s+using \(public\.is_studio_member\(studio_id\)\);/,
    );
    // Exactly one policy is created, and it is read-only. A write policy here
    // would silently reopen direct DML the moment a privilege were re-granted.
    expect(CODE.match(/create policy/gi) ?? []).toHaveLength(1);
    expect(CODE).not.toMatch(/create policy[\s\S]{0,200}?\bfor all\b/i);
    expect(CODE).not.toMatch(/on public\.session_block_areas\s+for\s+(all|insert|update|delete)\b/i);
  });

  it("is replayable on a fresh database (idempotent drop-if-exists / create-or-replace, grants re-asserted)", () => {
    expect(CODE).toMatch(/drop trigger if exists/);
    expect(CODE.match(/drop policy if exists/g) ?? []).toHaveLength(2);
    expect(CODE.match(/create or replace function/g) ?? []).toHaveLength(6);
  });
});

describe("0158 — hardened charting RPCs (signature + concurrency contract preserved)", () => {
  it("keeps both signatures and return types byte-compatible (no overload, no new parameter)", () => {
    expect(CODE).toMatch(
      /create or replace function public\.create_session_block_with_areas\(\s*p_studio_id\s+uuid,\s*p_session_id\s+uuid,\s*p_block\s+jsonb,\s*p_areas\s+jsonb\s*\)\s*returns uuid/,
    );
    expect(CODE).toMatch(
      /create or replace function public\.update_session_block_with_areas\(\s*p_studio_id\s+uuid,\s*p_session_id\s+uuid,\s*p_block_id\s+uuid,\s*p_block\s+jsonb,\s*p_areas\s+jsonb,\s*p_expected_updated_at\s+timestamptz default null\s*\)\s*returns void/,
    );
    // The grants name the identical type lists, so no second overload was created.
    expect(CODE).toMatch(
      /grant execute on function public\.create_session_block_with_areas\(uuid, uuid, jsonb, jsonb\) to authenticated, service_role;/,
    );
    expect(CODE).toMatch(
      /grant execute on function public\.update_session_block_with_areas\(uuid, uuid, uuid, jsonb, jsonb, timestamptz\) to authenticated, service_role;/,
    );
    // The 0130 posture (anon/public cannot execute the charting RPCs) is preserved.
    expect(CODE).toMatch(
      /revoke all on function public\.create_session_block_with_areas\(uuid, uuid, jsonb, jsonb\) from public, anon;/,
    );
    expect(CODE).toMatch(
      /revoke all on function public\.update_session_block_with_areas\(uuid, uuid, uuid, jsonb, jsonb, timestamptz\) from public, anon;/,
    );
    // No bypass/force parameter smuggled in.
    expect(CODE).not.toMatch(/p_force|p_bypass|p_allow_finalized|p_skip_guard/);
  });

  it("preserves the optimistic-concurrency contract (stale_block_version)", () => {
    expect(CODE).toMatch(/p_expected_updated_at is not null and v_current <> p_expected_updated_at/);
    expect(CODE).toMatch(/stale_block_version: this settings block was changed elsewhere/);
  });

  it("preserves the allow-listed column set (no re-tenanting, no widened write surface)", () => {
    // Both RPCs still build the row through jsonb_populate_record, so an older app
    // payload that omits a key still resolves it to NULL rather than fabricating.
    expect(CODE.match(/jsonb_populate_record\(null::public\.session_blocks, p_block\)/g) ?? [])
      .toHaveLength(2);
    const set = fn("update_session_block_with_areas");
    const assignments = set.slice(
      set.indexOf("update public.session_blocks b set"),
      set.indexOf("where b.id = p_block_id;"),
    );
    for (const forbidden of [
      "studio_id",
      "session_id",
      "sort_order",
      "deleted_at",
      "created_at",
      "record_status",
    ]) {
      expect(assignments, forbidden).not.toMatch(new RegExp(`\\b${forbidden}\\s*=`));
    }
  });

  it("calls assert_session_chartable BEFORE touching public.session_blocks (fixes the global lock order)", () => {
    // create: the assert must precede BOTH the sort_order probe and the INSERT, so
    // the parent session is locked before any block row is read or written.
    const create = fn("create_session_block_with_areas");
    const cMember = create.indexOf("is_studio_member(p_studio_id)");
    const cAssert = create.indexOf("perform public.assert_session_chartable(");
    const cProbe = create.indexOf("from public.session_blocks");
    const cInsert = create.indexOf("insert into public.session_blocks");
    const cAreas = create.indexOf("insert into public.session_block_areas");
    expect(cAssert).toBeGreaterThan(-1);
    expect(cAssert).toBeGreaterThan(cMember); // authorize, then lock
    expect(cAssert).toBeLessThan(cProbe);
    expect(cAssert).toBeLessThan(cInsert);
    // sessions -> session_blocks -> session_block_areas, in that order.
    expect(cInsert).toBeLessThan(cAreas);

    // update: the assert must precede the `for update` row lock on session_blocks.
    const update = fn("update_session_block_with_areas");
    const uMember = update.indexOf("is_studio_member(p_studio_id)");
    const uAssert = update.indexOf("perform public.assert_session_chartable(");
    const uBlocks = update.indexOf("from public.session_blocks");
    const uForUpdate = update.indexOf("for update");
    const uWrite = update.indexOf("update public.session_blocks b set");
    const uAreas = update.indexOf("public.session_block_areas");
    expect(uAssert).toBeGreaterThan(-1);
    expect(uAssert).toBeGreaterThan(uMember);
    expect(uAssert).toBeLessThan(uBlocks);
    expect(uAssert).toBeLessThan(uForUpdate);
    expect(uAssert).toBeLessThan(uWrite);
    expect(uForUpdate).toBeLessThan(uAreas);

    // Tenancy is proven from the STORED session row, not from the caller's claim.
    expect(CODE.match(/perform public\.assert_session_chartable\(p_session_id, p_studio_id\);/g) ?? [])
      .toHaveLength(2);
  });
});

describe("0158 — ZERO data operations", () => {
  it("executes no DML at apply time: every INSERT/UPDATE/DELETE lives inside an RPC body", () => {
    expect(TOP_LEVEL).not.toMatch(/\binsert\s+into\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bdelete\s+from\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bupdate\s+public\./i);
    expect(TOP_LEVEL).not.toMatch(/\btruncate\b/i);
    expect(TOP_LEVEL).not.toMatch(/\balter\s+table\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bcreate\s+table\b/i);
  });

  it("names the forbidden operations explicitly (no session rewrite, no snapshot, no flag flip, no backfill)", () => {
    expect(CODE).not.toMatch(/update\s+public\.sessions\b/i);
    expect(CODE).not.toMatch(/delete\s+from\s+public\.session_blocks\b/i);
    expect(CODE).not.toMatch(/insert\s+into\s+public\.clinical_record_snapshots\b/i);
    expect(CODE).not.toMatch(/clinical_finalization_enabled\s*=/);
    expect(CODE).not.toMatch(/clinical_corrections_enabled\s*=/);
    // No lifecycle rewrite of any kind, and nothing that reads as a backfill.
    expect(CODE).not.toMatch(/record_status\s*=\s*'/);
    expect(CODE).not.toMatch(/\bbackfill\b/i);
    expect(CODE).not.toMatch(/\bcurrent_snapshot_id\s*=/);
    expect(CODE).not.toMatch(/\brecord_version\s*=/);
  });

  it("the ONE delete in the file is update_session_block_with_areas' pre-existing replace semantics", () => {
    // Deliberate carve-out: `delete from public.session_block_areas` is the 0129
    // replace-on-update behaviour, scoped to a single block, inside the RPC body.
    // It is not a data operation performed by this migration, so the assertions
    // above are written against TOP_LEVEL / a table-specific pattern rather than a
    // blanket "no delete" grep that would fail on it.
    const deletes = [...CODE.matchAll(/delete\s+from\s+public\.\w+/gi)].map((m) =>
      m[0].toLowerCase(),
    );
    expect(deletes).toEqual(["delete from public.session_block_areas"]);
    expect(fn("update_session_block_with_areas")).toMatch(
      /delete from public\.session_block_areas where session_block_id = p_block_id;/,
    );
  });

  it("does not add structured areas to the snapshot or a correction applier, and says so", () => {
    // The residual risk this containment does NOT close, stated in the file so a
    // reader cannot mistake containment for closure.
    expect(SQL).toMatch(/snapshot v2/i);
    expect(SQL).toMatch(/MUST NOT be enabled/i);
    expect(CODE).not.toMatch(/build_session_snapshot/);
    expect(CODE).not.toMatch(/clinical_record_amendments/);
    expect(CODE).not.toMatch(/clinical_audit_events/);
    expect(CODE).not.toMatch(/create or replace function public\.finalize_session/);
    expect(CODE).not.toMatch(/create or replace function public\.correct_finalized_session/);
    // clinical_record_snapshots IS referenced — but only as a read-only EXISTS
    // probe inside the two lifecycle asserts (the once-finalized-always-frozen
    // check). It is never written, and the 0119 snapshot builder is untouched.
    const snapshotRefs = CODE.match(/clinical_record_snapshots/g) ?? [];
    expect(snapshotRefs).toHaveLength(3);
    for (const name of ["assert_session_chartable", "assert_structured_area_parent_mutable"]) {
      expect(fn(name), name).toMatch(
        /exists \(select 1 from public\.clinical_record_snapshots cs/,
      );
    }
    expect(CODE).not.toMatch(/insert into public\.clinical_record_snapshots/);
    expect(CODE).not.toMatch(/update public\.clinical_record_snapshots/);
    expect(CODE).not.toMatch(/delete from public\.clinical_record_snapshots/);
  });

  it("removes the statement-level privileges the row guard cannot see (review finding)", () => {
    // TRUNCATE fires no BEFORE ROW trigger and consults no policy, so leaving it
    // with service_role would have let one statement empty a finalized record's
    // authoritative areas with every signed field byte-identical. REFERENCES and
    // TRIGGER go with it: both let a caller attach behaviour without owning the
    // table. Row DML stays — the guard binds it.
    expect(CODE).toMatch(/revoke all on table public\.session_block_areas from service_role;/);
    expect(CODE).toMatch(
      /grant select, insert, update, delete on table public\.session_block_areas to service_role;/,
    );
    expect(CODE).not.toMatch(/grant[^;]*truncate[^;]*to service_role/i);
    // The owner-only residual is documented rather than silently left unstated.
    expect(SQL).toMatch(/session_replication_role/);
    expect(SQL).toMatch(/RESIDUAL/);
  });

  it("never overclaims what the production row counts can evidence", () => {
    // session_block_areas is (id, session_block_id, studio_id, area, laterality,
    // display_order, created_at): there is NO updated_at, NO deleted_at and no
    // history table. Row counts and created_at therefore evidence what EXISTS —
    // they can never prove that no UPDATE or DELETE ever happened to a finalized
    // record's areas. The file must not claim otherwise.
    expect(SQL).not.toMatch(/\bnever (been )?(changed|modified|mutated|rewritten)\b/i);
    expect(SQL).not.toMatch(/\bno (area|row)s?\s+(were|was)\s+ever\s+(changed|updated|deleted)\b/i);
    expect(SQL).not.toMatch(/\bprov(es|en|ably)\s+(that\s+)?no\s+\w+\s+(update|delete)/i);
  });
});

describe("0158 — every object it creates is schema-qualified", () => {
  it("creates exactly the six expected functions, all public.-qualified", () => {
    const created = [...CODE.matchAll(/create (?:or replace )?function\s+([\w.]+)\s*\(/gi)].map(
      (m) => m[1],
    );
    expect(created).toEqual([
      "public.assert_session_chartable",
      "public.assert_structured_area_parent_mutable",
      "public.guard_finalized_structured_area_write",
      "public.guard_signed_record_block_delete",
      "public.create_session_block_with_areas",
      "public.update_session_block_with_areas",
    ]);
    for (const name of created) expect(name, name).toMatch(/^public\./);
  });

  it("closes the FK-cascade erase route with a BEFORE DELETE guard on session_blocks", () => {
    // The area guard cannot police the cascade: by the time it runs the parent
    // block — the only route to the session — is gone. 0119's child-table DELETE
    // branch tests only sessions.record_status, so a status round-trip through the
    // 0120 permit could delete the block and erase a signed record's areas beneath
    // the guard. This trigger refuses to delete a block whose session has EVER been
    // signed, whatever record_status currently says.
    const body = fn("guard_signed_record_block_delete");
    expect(body).toMatch(/security definer/);
    expect(body).toMatch(/set search_path = ''/);
    expect(body).toMatch(
      /exists \(select 1 from public\.clinical_record_snapshots cs\s+where cs\.session_id = old\.session_id\)/,
    );
    expect(body).toMatch(/finalized and signed/i);
    // Keyed on the signed artifact, NOT on record_status — that is the whole point.
    expect(body).not.toMatch(/record_status/);
    expect(CODE).toMatch(
      /drop trigger if exists session_blocks_guard_signed_delete on public\.session_blocks;/,
    );
    expect(CODE).toMatch(
      /create trigger session_blocks_guard_signed_delete\s+before delete on public\.session_blocks\s+for each row execute function public\.guard_signed_record_block_delete\(\);/,
    );
    // DELETE only: it must not interfere with ordinary charting writes.
    expect(stmt("create trigger session_blocks_guard_signed_delete")).not.toMatch(
      /insert|update/i,
    );
  });

  it("bounds the apply with a lock_timeout instead of stalling live reads", () => {
    // Every DROP/CREATE TRIGGER, DROP/CREATE POLICY and REVOKE/GRANT needs ACCESS
    // EXCLUSIVE; a queued request makes every NEW reader queue behind it.
    expect(CODE).toMatch(/^set local lock_timeout = '5s';$/m);
    // It must come before the first statement that takes that lock.
    expect(CODE.indexOf("set local lock_timeout")).toBeLessThan(
      CODE.indexOf("revoke all on table public.session_block_areas"),
    );
    // Retrying is safe only because nothing is written; re-assert that here.
    expect(TOP_LEVEL).not.toMatch(/\binsert into\b/i);
  });

  it("attaches the trigger, the policy and the comments to the fully-qualified table", () => {
    expect(CODE).toMatch(/on public\.session_block_areas\s+for each row execute function public\./);
    expect(CODE).toMatch(/create policy "session_block_areas_member_select"\s+on public\.session_block_areas/);
    expect(CODE).toMatch(/comment on table public\.session_block_areas is/);
    expect(CODE).toMatch(/comment on function public\.assert_session_chartable\(uuid, uuid\) is/);
    expect(CODE).toMatch(
      /comment on function public\.assert_structured_area_parent_mutable\(uuid, boolean\) is/,
    );
  });

  it("qualifies every relation and helper call inside the pinned-search_path bodies", () => {
    // search_path = '' means NOTHING resolves unqualified, so an unqualified name
    // is a hard failure at runtime rather than a style nit.
    for (const name of GUARD_FNS) {
      const body = fn(name);
      // `(?<!distinct\s)` skips plpgsql's `is distinct from <var>` comparisons,
      // and p_/v_ candidates are parameters/locals, not relations.
      const bare = [
        ...body.matchAll(
          /(?<!distinct\s)\b(from|join)\s+(?!public\.|pg_catalog\.|extensions\.)([a-z_]\w*)/gi,
        ),
      ].filter((m) => !/^[pv]_/.test(m[2]));
      expect(bare.map((m) => m[0]), name).toEqual([]);
      expect(body, name).not.toMatch(/\bperform\s+(?!public\.)/);
    }
    // The two RPCs run with `search_path = pg_catalog, pg_temp`, so pg_catalog
    // set-returning functions may be bare — but every clinical relation must not be.
    expect(CODE).not.toMatch(
      /\b(from|join|into)\s+(sessions|session_blocks|session_block_areas|studios|practitioners)\b/i,
    );
  });

  it("keeps the private helpers unexecutable by every client role", () => {
    expect(CODE).toMatch(
      /revoke all on function public\.assert_session_chartable\(uuid, uuid\) from public, anon, authenticated, service_role;/,
    );
    expect(CODE).toMatch(
      /revoke all on function public\.assert_structured_area_parent_mutable\(uuid, boolean\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(CODE).not.toMatch(/grant execute on function public\.assert_/);
  });
});

describe("0158 — touches no unrelated surface", () => {
  it("mentions no billing, scheduling, messaging or calendar surface", () => {
    for (const forbidden of [
      /stripe/i,
      /payment/i,
      /\bcharge\b/i,
      /appointment/i,
      /\bbooking/i,
      /\bconsent/i,
      /\bemail/i,
      /\bsms\b/i,
      /google/i,
      /\bcalendar/i,
      /probe_lots\b/,
    ]) {
      expect(CODE, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("makes no schema change to any table (containment is behaviour + privilege only)", () => {
    for (const table of ["studios", "sessions", "session_blocks", "session_block_areas"]) {
      expect(CODE, table).not.toMatch(new RegExp(`alter table public\\.${table}`, "i"));
    }
    expect(CODE).not.toMatch(/drop (table|column|function|index|constraint)/i);
    expect(CODE).not.toMatch(/add column/i);
    expect(CODE).not.toMatch(/create (unique )?index/i);
    // Does not disturb the 0119 guard installed on the other clinical tables.
    expect(CODE).not.toMatch(/guard_finalized_clinical_write/);
    expect(CODE).not.toMatch(/create or replace function public\.copy_session_setup/);
  });
});
