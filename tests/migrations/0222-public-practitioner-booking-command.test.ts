import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

const VERSION = "0222";
const FILE = "supabase/migrations/0222_public_practitioner_booking_command.sql";
const sql = readFileSync(FILE, "utf8");

/** Executable SQL only — comments stripped, line comments before block
 *  comments. A DDL/DML scan that reads prose reports a TRUNCATE for the word
 *  "Truncate" in a comment, which is exactly what happened to 0219's guard. */
const EXECUTABLE = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

/** TOP-LEVEL statements only: every $$-quoted function body removed.
 *
 *  A booking command INSERTS at runtime — into appointments and
 *  appointment_audit — and must. What this migration must not do is write data
 *  or alter schema when it is APPLIED. Scanning the whole file for "insert
 *  into" conflates the two and would ban the feature itself. */
const TOP_LEVEL = EXECUTABLE.replace(/\$\$[\s\S]*?\$\$/g, " <body> ");

describe("0222 sits correctly in the migration sequence", () => {
  it("is no longer the repo max — it handed off to 0225", () => {
    // CLAUDE.md §2 handoff, on this branch only. 0225 (the new-client write
    // side) now sits above 0222. On a branch without 0225, 0222 is the max and
    // asserts it there.
    expect(isRepoMax(VERSION)).toBe(false);
    const above = versionsAbove(VERSION);
    expect(above.length, "nothing sits above 0222").toBeGreaterThan(0);
    expect(above.every((v) => Number(v) > Number(VERSION))).toBe(true);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(sql).toMatch(/^begin;/m);
    expect(sql).toMatch(/set local lock_timeout = '5s';/);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql.indexOf("set local lock_timeout")).toBeGreaterThan(sql.indexOf("begin;"));
  });
});

describe("0222 is additive — the live public booking path is untouched", () => {
  it("creates exactly THREE functions and nothing else", () => {
    // The census is PINNED EXACTLY, which is why it fired when the resolver
    // was added rather than letting a third function in unnoticed. Updated
    // deliberately, not relaxed: the list is still exhaustive and still sorted,
    // so a fourth function reds this again.
    //
    // `resolve_public_any_available_practitioner` exists because BOTH
    // create_public_appointment_v2 (resolving the default "Any available") and
    // 0225's new-client wrapper (answering the same question BEFORE it inserts
    // a client row, so a refusal cannot leave an orphan) need one answer. Two
    // copies of that loop would be two engines answering one question.
    const created = [
      ...TOP_LEVEL.matchAll(/create or replace function public\.([a-z_0-9]+)/g),
    ].map((m) => m[1]);
    expect(created.sort()).toEqual([
      "create_public_appointment_v2",
      "resolve_public_any_available_practitioner",
      "validate_public_booking_slot_v2",
    ]);
  });

  it("grants the resolver to service_role ONLY, revoking all four by name", () => {
    // CLAUDE.md section 5: ALTER DEFAULT PRIVILEGES grants EXECUTE to anon,
    // authenticated AND service_role at create time, so an authenticated-only
    // command must revoke from all three explicitly plus public. Missed once in
    // 0129 (anon) and again in 0164 (service_role); a new function is exactly
    // where it gets missed a third time.
    const sig = "resolve_public_any_available_practitioner(uuid, uuid, timestamptz, timestamptz)";
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(
        EXECUTABLE,
        `the resolver must revoke execute from ${role} by name`,
      ).toContain(`revoke execute on function public.${sig} from ${role};`);
    }
    expect(EXECUTABLE).toContain(
      `grant execute on function public.${sig} to service_role;`,
    );
    // And never to a public-facing role.
    expect(EXECUTABLE).not.toMatch(
      new RegExp(`grant execute on function public\\.${sig.replace(/[()]/g, "\\$&")} to (anon|authenticated)`),
    );
  });

  it("does NOT redefine 0170's command or validator", () => {
    // The entire safety claim: every existing caller keeps today's authority.
    expect(EXECUTABLE).not.toMatch(
      /create or replace function public\.create_public_appointment\s*\(/,
    );
    expect(EXECUTABLE).not.toMatch(
      /create or replace function public\.validate_public_booking_slot\s*\(/,
    );
  });

  it("writes nothing and alters no schema object WHEN APPLIED", () => {
    for (const banned of [
      /\bcreate table\b/i, /\balter table\b/i, /\bdrop table\b/i,
      /\bcreate index\b/i, /\bcreate trigger\b/i, /\bcreate policy\b/i,
      /\binsert into\b/i, /\bupdate \w/i, /\bdelete from\b/i, /\btruncate\b/i,
      /\bdrop function\b/i,
    ]) {
      expect(TOP_LEVEL, `0222 must not contain ${banned} at top level`).not.toMatch(banned);
    }
  });
});

describe("0222 grant posture — revoke all three by name, then service_role only", () => {
  const fns: [string, string][] = [
    ["validate_public_booking_slot_v2", "uuid, uuid, uuid, timestamptz, timestamptz"],
    ["create_public_appointment_v2", "uuid, uuid, uuid, timestamptz, text, text, text, uuid"],
  ];
  for (const [fn, args] of fns) {
    it(`${fn} revokes from public, anon, authenticated and service_role`, () => {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(sql, `${fn} does not revoke from ${role}`).toContain(
          `revoke execute on function public.${fn}(${args}) from ${role};`,
        );
      }
    });
    it(`${fn} grants EXECUTE to service_role only`, () => {
      expect(sql).toContain(
        `grant execute on function public.${fn}(${args}) to service_role;`,
      );
      for (const role of ["anon", "authenticated"]) {
        expect(sql).not.toContain(
          `grant execute on function public.${fn}(${args}) to ${role};`,
        );
      }
    });
  }
});

describe("0222 — the three validator changes are present and correctly shaped", () => {
  it("CHANGE 1: the conflict scope names the resource that holds rows in each mode", () => {
    // Both arms must name a resource that actually carries reservations in that
    // mode. `resource_key = p_studio_id` under capacity-ON is VACUOUS and makes
    // the check fail OPEN — the trap recorded in the migration.
    expect(EXECUTABLE).toMatch(/when not v_cap_on then r\.resource_key = p_studio_id/);
    expect(EXECUTABLE).toMatch(/else r\.resource_key = p_practitioner_id/);
    expect(EXECUTABLE).toContain("public.studio_capacity_enabled(p_studio_id)");
  });

  it("CHANGE 2: the scoped window preference is gated on capacity", () => {
    expect(EXECUTABLE).toMatch(/if v_cap_on then/);
    expect(EXECUTABLE).toMatch(/order by \(o\.practitioner_id is not null\) desc/);
    expect(EXECUTABLE).toMatch(/order by \(d\.practitioner_id is not null\) desc/);
    // and the capacity-OFF arm must read studio-wide rows only
    expect(EXECUTABLE).toMatch(/o\.practitioner_id is null/);
    expect(EXECUTABLE).toMatch(/d\.practitioner_id is null/);
  });

  it("CHANGE 3: the membership gate reads the PRACTITIONER-SCOPED loader", () => {
    expect(EXECUTABLE).toContain("public.public_booking_slot_candidates_for_practitioner(");
    // and must not fall back to the studio-wide loader inside the scoped validator
    const v2 = EXECUTABLE.slice(
      EXECUTABLE.indexOf("validate_public_booking_slot_v2"),
      EXECUTABLE.indexOf("create or replace function public.create_public_appointment_v2"),
    );
    expect(v2).not.toMatch(/public\.public_booking_slot_candidates\s*\(/);
  });

  it("the command routes NULL to the LEGACY validator and non-NULL to v2", () => {
    expect(EXECUTABLE).toMatch(/if p_practitioner_id is not null then[\s\S]*?validate_public_booking_slot_v2/);
    expect(EXECUTABLE).toMatch(/else[\s\S]*?public\.validate_public_booking_slot\(/);
  });

  it("writes its audit row through the SHARED helper, not an inlined INSERT", () => {
    // tests/db/appointment-audit-invariant.db.test.ts PINS the set of functions
    // that insert into appointment_audit, because that table is append-only
    // history and growing the writer census must be a conscious act. An inlined
    // INSERT here would make create_public_appointment_v2 a ninth writer — and
    // it did, until CI caught it. The helper is a pure pass-through of the same
    // five columns, so the row is identical.
    expect(EXECUTABLE).toMatch(/perform public\.write_appointment_audit\(/);
    expect(
      EXECUTABLE,
      "0222 must not inline an appointment_audit INSERT — use write_appointment_audit",
    ).not.toMatch(/insert into public\.appointment_audit/i);
  });

  it("keeps the shared studio constraints that genuinely apply", () => {
    // studio_blockouts has no practitioner column — studio-wide by schema.
    expect(EXECUTABLE).toMatch(/public\.studio_blockouts b/);
    expect(EXECUTABLE).not.toMatch(/studio_blockouts[\s\S]{0,200}practitioner_id/);
  });
});
