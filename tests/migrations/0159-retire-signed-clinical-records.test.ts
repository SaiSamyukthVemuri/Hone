import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// Migration 0159: PERMANENTLY RETIRE signed/finalized clinical records, plus the
// privilege hardening that is safe to take without an application change.
//
// Hone will not offer signed or cryptographically finalized clinical records.
// Treatment sessions stay ORDINARY EDITABLE operational records. 0119/0120 built a
// signed-snapshot system that was never enabled for a real studio; 0159 makes the
// decision structural instead of leaving it to an operator remembering to keep a
// flag off, which matters, because `authenticated` holds EXECUTE on the four
// signed-record RPCs and can PATCH the flag through the studios owners-update RLS
// policy, so the capability is browser-reachable today.
//
// Carries the repo migration-max tripwire (moved here from the 0157 test). 0158 is
// intentionally skipped, DRAFT PR #481 carries a different, superseded migration
// under that number on a branch retained for audit evidence.

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0159_")) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");
// Executable DDL only (whole-line comments stripped): the header names the very
// operations this migration must never perform, so the negative greps have to run
// against code rather than prose.
const CODE = SQL.split("\n")
  .filter((l) => !/^\s*--/.test(l))
  .join("\n");
// The same DDL with every $$-quoted function body elided. A statement that survives
// here runs at APPLY time; a statement inside a body only runs when something calls
// the function later. That distinction is what makes "zero data operations" provable.
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, "\n<<body elided>>\n");

/** Header + body of one `create or replace function public.<name>(...)` block. */
function fn(name: string): string {
  const start = CODE.indexOf(`create or replace function public.${name}(`);
  expect(start, `public.${name} is defined`).toBeGreaterThan(-1);
  const open = CODE.indexOf("$$", start);
  const close = CODE.indexOf("$$", open + 2);
  expect(close, `public.${name} body is $$-quoted`).toBeGreaterThan(open);
  return CODE.slice(start, close + 2);
}

const RETIRED_RPCS = [
  "finalize_session",
  "correct_finalized_session",
  "amend_finalized_session",
  "amend_finalized_session_with_image",
  "build_session_snapshot",
  // The five correction appliers: the only leftover that still held WRITE
  // authority (0120 never revoked service_role from them).
  "_apply_session_correction",
  "_apply_block_correction",
  "_apply_electrolysis_correction",
  "_apply_laser_correction",
  "_apply_image_correction",
] as const;

const LEDGERS = [
  "clinical_record_snapshots",
  "clinical_record_amendments",
  "clinical_audit_events",
] as const;

const CLINICAL_TABLES = [
  "sessions",
  "session_blocks",
  "session_block_areas",
  "electrolysis_entries",
  "laser_entries",
  "treatment_images",
] as const;

describe("0159: retirement (repo migration-max tripwire)", () => {
  it("is present, 0157 precedes it, exactly one 0159, nothing 0161+ (repo max pin now lives in the 0160 test)", () => {
    expect(FILE).toMatch(/^0159_.*\.sql$/);
    const files = readdirSync(MIG_DIR);
    expect(files.some((f) => f.startsWith("0157_"))).toBe(true);
    expect(files.filter((f) => /^0159_/.test(f))).toHaveLength(1);
    // The absolute repo-max pin moved to the 0160 test (0160 = immutable clinical
    // lineage, the follow-up this migration's header points at).
    const nums = files
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .map((f) => parseInt(f.slice(0, 4), 10))
      .sort((a, b) => a - b);
    expect(new Set(nums).size).toBe(nums.length); // no duplicate number anywhere
  });

  it("0158 is deliberately absent, and the file says why", () => {
    // PR #481's superseded migration owns that number on a retained branch. Two
    // artifacts must never share a number, so the gap is intentional, record the
    // reason here so a future reader does not "fix" it.
    expect(readdirSync(MIG_DIR).filter((f) => /^0158_/.test(f))).toEqual([]);
    expect(SQL).toMatch(/0158 is deliberately skipped/i);
    expect(SQL).toMatch(/#481/);
  });

  it("mirrors the extension-qualification rule (no bare pgcrypto calls)", () => {
    expect(CODE).not.toMatch(
      /(?<!extensions\.)\b(gen_random_bytes|digest|hmac|gen_salt|crypt|pgp_sym_encrypt|pgp_sym_decrypt|uuid_generate_v4)\s*\(/,
    );
  });
});

describe("0159: the flags can never be turned on again", () => {
  it("pins both to false with CHECK constraints, not a trigger and not a default", () => {
    // A CHECK binds every role including the owner and is visible in the schema.
    for (const col of [
      "clinical_finalization_enabled",
      "clinical_corrections_enabled",
    ] as const) {
      const name = `studios_${col.replace("clinical_", "clinical_").replace("_enabled", "")}_retired`;
      expect(CODE).toMatch(new RegExp(`check \\(${col} = false\\)`));
      expect(name.length).toBeGreaterThan(0);
    }
    expect(CODE).toMatch(
      /add constraint studios_clinical_finalization_retired\s+check \(clinical_finalization_enabled = false\)/,
    );
    expect(CODE).toMatch(
      /add constraint studios_clinical_corrections_retired\s+check \(clinical_corrections_enabled = false\)/,
    );
    // Idempotent: each constraint is dropped-if-exists first, so a replay is clean.
    expect(CODE.match(/drop constraint if exists studios_clinical_\w+_retired;/g) ?? []).toHaveLength(2);
  });

  it("keeps the columns rather than dropping them, and labels them retired", () => {
    expect(CODE).not.toMatch(/drop column .*clinical_(finalization|corrections)_enabled/i);
    for (const col of ["clinical_finalization_enabled", "clinical_corrections_enabled"] as const) {
      expect(CODE).toMatch(new RegExp(`comment on column public\\.studios\\.${col} is`));
    }
    expect(CODE).toMatch(/RETIRED \(0159\)/);
  });
});

describe("0159: no runtime role can invoke the retired capability", () => {
  it("revokes ALL on every retired RPC from every runtime role", () => {
    for (const rpc of RETIRED_RPCS) {
      const re = new RegExp(
        `revoke all on function public\\.${rpc}\\([^)]*\\)\\s*\\n?\\s*from public, anon, authenticated, service_role;`,
      );
      expect(CODE, rpc).toMatch(re);
    }
  });

  it("grants EXECUTE on none of them back to anyone", () => {
    for (const rpc of RETIRED_RPCS) {
      expect(CODE, rpc).not.toMatch(new RegExp(`grant execute on function public\\.${rpc}\\b`));
    }
    // No grant anywhere in the file mentions a retired RPC.
    for (const stmt of CODE.split(";")) {
      if (/^\s*grant\b/i.test(stmt)) {
        for (const rpc of RETIRED_RPCS) expect(stmt, rpc).not.toContain(rpc);
      }
    }
  });

  it("does NOT drop the retired functions, 0119/0120 must stay replayable", () => {
    for (const rpc of RETIRED_RPCS) {
      expect(CODE, rpc).not.toMatch(new RegExp(`drop function .*${rpc}`, "i"));
    }
  });
});

describe("0159: nothing can enter the retired lifecycle", () => {
  it("guards the record_status TRANSITION, so the legacy row is preserved", () => {
    const body = fn("guard_retired_finalization_transition");
    expect(body).toMatch(/security invoker/);
    expect(body).toMatch(/set search_path = ''/);
    // A transition test, NOT a value test: `new <> old` is what keeps the one
    // existing finalized row valid instead of making every UPDATE on it fail.
    expect(body).toMatch(/new\.record_status is distinct from old\.record_status/);
    expect(body).toMatch(/new\.record_status in \('finalized', 'void'\)/);
    // INSERT must arrive as draft.
    expect(body).toMatch(/tg_op = 'INSERT'/);
    expect(body).toMatch(/new\.record_status is distinct from 'draft'/);
    expect(CODE).toMatch(
      /create trigger sessions_guard_retired_finalization\s+before insert or update of record_status on public\.sessions\s+for each row execute function public\.guard_retired_finalization_transition\(\);/,
    );
    expect(CODE).toMatch(
      /drop trigger if exists sessions_guard_retired_finalization on public\.sessions;/,
    );
  });

  it("blocks INSERT into all three signed-record ledgers", () => {
    const body = fn("guard_retired_signed_ledger_insert");
    expect(body).toMatch(/raise exception/);
    expect(body).toMatch(/tg_table_name/); // names the table in the error
    for (const t of LEDGERS) {
      expect(CODE, t).toMatch(
        new RegExp(
          `create trigger ${t}_retired_no_insert\\s+before insert on public\\.${t}\\s+for each row execute function public\\.guard_retired_signed_ledger_insert\\(\\);`,
        ),
      );
      expect(CODE, t).toMatch(new RegExp(`drop trigger if exists ${t}_retired_no_insert`));
    }
  });

  it("leaves the 0119/0120 guards that PROTECT the legacy artifact in place", () => {
    // Dropping these would un-protect the one preserved record, the opposite of
    // what the decision asks for.
    for (const keep of [
      "guard_finalized_clinical_write",
      "guard_snapshot_append_only",
      "guard_practitioner_finalized_refs",
      "sessions_guard_finalized",
      "clinical_record_snapshots_append_only",
    ]) {
      expect(CODE, keep).not.toMatch(new RegExp(`drop (trigger|function)[^;]*${keep}`, "i"));
    }
  });

  it("keeps sessions.record_status, which two shipped features still read", () => {
    // 0157 (whole-session copy) and 0123 (soft_delete_session_area) both branch on
    // it on live paths, and the session page derives its editability from it.
    expect(CODE).not.toMatch(/drop column .*record_status/i);
    expect(CODE).not.toMatch(/alter column record_status/i);
    expect(SQL).toMatch(/0157/);
    expect(SQL).toMatch(/0123/);
  });
});

describe("0159: privilege hardening that breaks nothing today", () => {
  it("removes every anon write privilege on all six clinical tables", () => {
    for (const t of CLINICAL_TABLES) {
      expect(CODE, t).toMatch(
        new RegExp(
          `revoke insert, update, delete, truncate, references, trigger\\s*\\n?\\s*on public\\.${t}\\s+from anon;`,
        ),
      );
    }
  });

  it("removes TRUNCATE / REFERENCES / TRIGGER from authenticated on all six", () => {
    for (const t of CLINICAL_TABLES) {
      expect(CODE, t).toMatch(
        new RegExp(`revoke truncate, references, trigger\\s*\\n?\\s*on public\\.${t}\\s+from authenticated;`),
      );
    }
  });

  it("does NOT revoke row DML from authenticated on the five tables the app still writes", () => {
    // The deployed application writes these directly. Revoking here would break
    // Willow's live charting the moment the migration applied, that is PR B, after
    // the callers move onto narrow commands.
    for (const t of ["sessions", "session_blocks", "electrolysis_entries", "laser_entries", "treatment_images"]) {
      expect(CODE, t).not.toMatch(
        new RegExp(`revoke[^;]*\\b(insert|update|delete)\\b[^;]*on public\\.${t}[^;]*from[^;]*authenticated`, "i"),
      );
    }
    expect(SQL).toMatch(/PR B|follow-up PR/i);
  });

  it("makes session_block_areas read-only to browser roles, with a SELECT-only policy", () => {
    // It is the authoritative area record and has ZERO direct application writes.
    for (const role of ["public", "anon", "authenticated"]) {
      expect(CODE, role).toMatch(
        new RegExp(`revoke all on table public\\.session_block_areas from ${role};`),
      );
    }
    expect(CODE).toMatch(/grant select on table public\.session_block_areas to authenticated;/);
    expect(CODE).toMatch(
      /grant select, insert, update, delete on table public\.session_block_areas to service_role;/,
    );
    expect(CODE).not.toMatch(/grant[^;]*\b(insert|update|delete|truncate)\b[^;]*to authenticated/i);
    expect(CODE).toMatch(/drop policy if exists "session_block_areas_member_all"/);
    expect(CODE).toMatch(
      /create policy "session_block_areas_member_select"\s+on public\.session_block_areas for select to authenticated\s+using \(public\.is_studio_member\(studio_id\)\)/,
    );
    expect(CODE.match(/create policy/g) ?? []).toHaveLength(1);
  });

  it("widens the 0128 studio-derive trigger to cover studio_id, narrowly", () => {
    expect(CODE).toMatch(
      /create trigger session_block_areas_derive_studio\s+before insert or update of session_block_id, studio_id on public\.session_block_areas/,
    );
    // Unrestricted would make this INVOKER trigger resolve the parent on every
    // edit, which fails for any role without a direct SELECT on session_blocks.
    expect(CODE).not.toMatch(
      /create trigger session_block_areas_derive_studio\s+before insert or update on public\./,
    );
    // The function itself is untouched.
    expect(CODE).not.toMatch(/create or replace function public\.session_block_areas_derive_studio\(/);
  });

  it("bounds the apply with a lock_timeout before taking any exclusive lock", () => {
    expect(CODE).toMatch(/^set local lock_timeout = '5s';$/m);
    expect(CODE.indexOf("set local lock_timeout")).toBeLessThan(
      CODE.indexOf("alter table public.studios"),
    );
  });
});

describe("0159: ZERO data operations, nothing destructive", () => {
  it("runs no INSERT / UPDATE / DELETE / TRUNCATE at apply time", () => {
    // Scoped to a real table reference: the comment strings legitimately contain
    // the words "INSERT into the retired ... ledgers" when describing the guard.
    expect(TOP_LEVEL).not.toMatch(/\binsert into public\./i);
    expect(TOP_LEVEL).not.toMatch(/\bupdate public\./i);
    expect(TOP_LEVEL).not.toMatch(/\bdelete from\b/i);
    expect(TOP_LEVEL).not.toMatch(/\btruncate\b(?!\s*,)/i);
  });

  it("drops no table, column, function, policy-bearing table or trigger it must keep", () => {
    expect(CODE).not.toMatch(/\bdrop table\b/i);
    expect(CODE).not.toMatch(/\bdrop column\b/i);
    expect(CODE).not.toMatch(/\bdrop function\b/i);
    expect(CODE).not.toMatch(/\bdrop index\b/i);
    // The only drops are the idempotent re-create pairs.
    const drops = (CODE.match(/^\s*drop (trigger|policy|constraint)[^;]*;/gim) ?? []).length;
    expect(drops).toBeGreaterThan(0);
  });

  it("touches no flag value, no record_status value and no snapshot row", () => {
    expect(CODE).not.toMatch(/set clinical_(finalization|corrections)_enabled\s*=/i);
    expect(CODE).not.toMatch(/set record_status\s*=/i);
    expect(CODE).not.toMatch(/insert into public\.clinical_record_snapshots/i);
    expect(CODE).not.toMatch(/\bbackfill\b/i);
    expect(CODE).not.toMatch(/content_hash\s*=/);
  });

  it("does not touch ordinary audit/provenance, payments, appointments or copy provenance", () => {
    // The retired ledger has "audit" in its name; the ORDINARY ones must survive.
    for (const keep of [
      "session_audit",
      "record_keeping_audit_events",
      "session_copy_operations",
      "admin_action_events",
      "client_portal_access_events",
      "appointments",
      "payment_charge_attempts",
      "copy_session_setup",
    ]) {
      expect(CODE, keep).not.toMatch(new RegExp(`\\b(drop|revoke|alter)[^;]*\\b${keep}\\b`, "i"));
    }
  });

  it("carries the lock-order warning forward from the superseded PR #481 review", () => {
    // The reproduced 40P01 against soft_delete_session_area (0123) must survive the
    // supersession, somewhere a future lock author will actually look.
    expect(SQL).toMatch(/40P01/);
    expect(SQL).toMatch(/soft_delete_session_area/);
    expect(SQL).toMatch(/FOR NO KEY UPDATE/);
  });

  it("does not point at artifacts that do not exist", () => {
    // An earlier draft justified keeping owner EXECUTE on build_session_snapshot by
    // naming an "integrity audit script" that was deliberately dropped.
    expect(SQL).not.toMatch(/integrity audit script/i);
  });

  it("states the retirement plainly and points at the decision record", () => {
    expect(SQL).toMatch(/docs\/decisions\/clinical-finalization-retired\.md/);
    expect(SQL).toMatch(/will NOT offer signed or\s*(--\s*)?cryptographically finalized clinical records/i);
    expect(SQL).toMatch(/ORDINARY, EDITABLE/i);
    // …and is honest about what it is NOT giving up.
    expect(SQL).toMatch(/whole-session-copy provenance/i);
    expect(SQL).toMatch(/tenant isolation/i);
    // …and about the one preserved artifact.
    expect(SQL).toMatch(/legacy artifact/i);
    expect(SQL).toMatch(/9d37c51a-6237-42ef-b9d3-28a567c2bfa8/);
    expect(SQL).toMatch(/MATCH/);
  });

  it("never overclaims the production counts it quotes", () => {
    // Production is live and charting daily, so the numbers are dated observations
    // and the apply must be gated on invariants, not on a count matching.
    expect(SQL).toMatch(/as of 2026-07-2\d/);
    expect(SQL).toMatch(/dated observation/i);
    expect(SQL).toMatch(/[Rr]e-derive the baseline/);
  });
});
