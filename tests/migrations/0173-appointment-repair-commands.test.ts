import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// 0173 — APPOINTMENT BOUNDARY B4 source contract.
//
// Behaviour lives in tests/db/appointment-repair-commands.db.test.ts. This file
// pins byte-level properties of the migration that behaviour cannot reach:
// which functions exist, what the file must NOT contain, and the standing
// prohibitions B4 inherits from 0172.
//
// Cloned from tests/migrations/0172-appointment-dml-revocation.test.ts, which is
// the repository's template for a boundary migration test — including its
// hard-won lesson about anchored regexes (see EXECUTABLE below).
// ===========================================================================

const FILE = "supabase/migrations/0173_appointment_repair_commands.sql";
const SQL = readFileSync(join(__dirname, "..", "..", FILE), "utf8");

/**
 * The migration with `--` comment lines stripped. The header discusses every
 * forbidden pattern at length — `snapshot_appointment_buffer`, `revoke all`,
 * trigger functions — so prose describing a prohibition must never satisfy a
 * guard looking for it.
 */
const CODE = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const PROSE = SQL.split("\n")
  .filter((l) => l.trimStart().startsWith("--"))
  .join(" ");

/**
 * Executable statements. NOT `^create` — anchoring at column 0 makes a
 * statement indented by a single space INVISIBLE to every guard built on it.
 * The 0172 adversarial pass demonstrated four mutants that survived a full
 * suite exactly that way. Leading whitespace is consumed everywhere below.
 */
const EXECUTABLE = CODE.split(";")
  .map((s) => s.trim())
  .filter(Boolean);

const FUNCTIONS = [
  "appointment_actor_role",
  "lock_appointment_for_command",
  "appointment_has_blocking_dependents",
  "write_appointment_audit",
  "revert_appointment_outcome",
  "set_appointment_notes",
] as const;

// ---------------------------------------------------------------------------

describe("0173 — migration state", () => {
  // The CENTRAL tripwire, moved here from
  // tests/migrations/0172-appointment-dml-revocation.test.ts when B4 landed.
  // Only the current maximum migration's own test carries it (CLAUDE.md §2);
  // an older per-migration test that keeps the pin turns every subsequent
  // migration into a mechanical sweep, which is exactly how 0163, 0164 and 0165
  // each went red after push.
  //
  // 0173 is B4's ONLY migration. The L23 closure it also carries was briefly
  // drafted as a companion 0174 and withdrawn, because the canonical
  // appointment-DML program reserves 0174 for B5, 0175 for B6, 0176 for B7 and
  // 0177 for B8. When B5's 0174 lands, this block moves there.
  it("is the current repository maximum", () => {
    expect(isRepoMax("0173")).toBe(true);
    expect(versionsAbove("0173")).toEqual([]);
  });
});

describe("0173 — declares exactly the intended functions", () => {
  it("creates the four helpers and the two commands, and nothing else", () => {
    const declared = [
      ...CODE.matchAll(/create or replace function public\.(\w+)\(/g),
    ].map((m) => m[1]);
    expect(declared.sort()).toEqual([...FUNCTIONS].sort());
  });

  it.each(FUNCTIONS)("%s carries a comment documenting its contract", (fn) => {
    expect(CODE).toContain(`comment on function public.${fn}(`);
  });

  it("every helper has a B4 consumer — no generic abstractions", () => {
    // The brief forbids helpers without a consumer in this migration. Each
    // helper name must appear at least twice: its definition and a call.
    for (const fn of [
      "appointment_actor_role",
      "lock_appointment_for_command",
      "appointment_has_blocking_dependents",
      "write_appointment_audit",
    ]) {
      const uses = CODE.match(new RegExp(`public\\.${fn}\\b`, "g")) ?? [];
      expect(uses.length, `${fn} must be defined AND called`).toBeGreaterThan(2);
    }
  });
});

describe("0173 — transaction and lock discipline", () => {
  it("opens its own transaction (db push does not wrap the file)", () => {
    expect(CODE).toMatch(/^\s*begin\s*;/m);
    expect(CODE).toMatch(/^\s*commit\s*;/m);
  });

  it("arms lock_timeout inside that transaction", () => {
    expect(CODE).toMatch(/set\s+local\s+lock_timeout\s*=\s*'5s'/);
  });

  it("the canonical lock order is studio -> capacity lock -> appointment", () => {
    const helper = CODE.slice(
      CODE.indexOf("function public.lock_appointment_for_command"),
    );
    const studio = helper.indexOf("from public.studios");
    const capacity = helper.indexOf("acquire_studio_capacity_lock");
    const appointment = helper.indexOf("from public.appointments");
    expect(studio).toBeGreaterThan(-1);
    expect(capacity).toBeGreaterThan(studio);
    expect(appointment).toBeGreaterThan(capacity);
  });

  it("the appointment lookup is scoped by BOTH id and studio_id", () => {
    const helper = CODE.slice(
      CODE.indexOf("function public.lock_appointment_for_command"),
      CODE.indexOf("comment on function public.lock_appointment_for_command"),
    );
    expect(helper).toMatch(/a\.id\s*=\s*p_appointment_id/);
    expect(helper).toMatch(/a\.studio_id\s*=\s*p_studio_id/);
    expect(helper).toMatch(/for update/);
  });
});

describe("0173 — the standing prohibitions", () => {
  it("does NOT touch snapshot_appointment_buffer", () => {
    // Production carries an out-of-band GUC behaviour in that function which
    // exists in NO migration here; emitting it from repo source would silently
    // delete a live behaviour. Prose may name it; executable code may not.
    expect(CODE).not.toContain("snapshot_appointment_buffer");
    expect(PROSE).toContain("snapshot_appointment_buffer");
  });

  it("creates, replaces or drops NO trigger", () => {
    for (const stmt of EXECUTABLE) {
      expect(stmt.toLowerCase()).not.toMatch(/^create\s+(or\s+replace\s+)?trigger/);
      expect(stmt.toLowerCase()).not.toMatch(/^drop\s+trigger/);
    }
  });

  it("contains no `revoke all` (the 0169 doctrine: name every verb)", () => {
    for (const stmt of EXECUTABLE) {
      expect(stmt.toLowerCase()).not.toMatch(/revoke\s+all\b/);
    }
  });

  it("adds no table, column, index or constraint", () => {
    for (const stmt of EXECUTABLE) {
      const s = stmt.toLowerCase();
      expect(s).not.toMatch(/^create\s+table/);
      expect(s).not.toMatch(/^alter\s+table/);
      expect(s).not.toMatch(/^create\s+(unique\s+)?index/);
    }
  });

  it("grants NO table privilege to a browser role", () => {
    for (const stmt of EXECUTABLE) {
      const s = stmt.toLowerCase();
      if (/^grant\b/.test(s) && /\bon\s+table\b/.test(s)) {
        expect(s, "no table grant may reach anon/authenticated").not.toMatch(
          /\b(anon|authenticated)\b/,
        );
      }
    }
  });

  it("writes, deletes or repairs no row at migration time", () => {
    // Splitting the whole file on `;` tears FUNCTION BODIES apart, and those
    // legitimately contain `insert into public.appointment_audit`. Only
    // TOP-LEVEL DML is forbidden, so the $$-quoted bodies and the DO block are
    // removed before splitting.
    const topLevel = CODE.replace(/\$\$[\s\S]*?\$\$/g, " BODY ")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of topLevel) {
      expect(
        stmt.toLowerCase(),
        `top-level DML found: ${stmt.slice(0, 80)}`,
      ).not.toMatch(/^(insert|update|delete)\b/);
    }
    // The extraction must actually have seen the file, not an empty list.
    expect(topLevel.length).toBeGreaterThan(5);
  });
});

describe("0173 — EXECUTE posture", () => {
  it("revokes EXECUTE from public, anon and authenticated for every function", () => {
    // The grant loop is a DO block, so assert the loop body's four statements
    // and that every function name appears in the array literal.
    expect(CODE).toMatch(/revoke execute on function %s from public/);
    expect(CODE).toMatch(/revoke execute on function %s from anon/);
    expect(CODE).toMatch(/revoke execute on function %s from authenticated/);
    expect(CODE).toMatch(/grant\s+execute on function %s to service_role/);
    for (const fn of FUNCTIONS) {
      expect(CODE).toContain(`public.${fn}(`);
    }
  });

  it("names service_role as the ONLY grantee", () => {
    const grants = CODE.match(/grant\s+execute[^']*'/g) ?? [];
    for (const g of grants) {
      expect(g).toContain("service_role");
      expect(g).not.toMatch(/\b(anon|authenticated)\b/);
    }
  });
});

describe("0173 — the command contracts", () => {
  it("revert_appointment_outcome is owner-gated in SQL", () => {
    const fn = CODE.slice(
      CODE.indexOf("function public.revert_appointment_outcome"),
      CODE.indexOf("comment on function public.revert_appointment_outcome"),
    );
    expect(fn).toMatch(/v_role\s*<>\s*'owner'/);
    expect(fn).toContain("'not_owner'");
    // No role parameter exists, so the browser has nothing to forge.
    expect(fn).not.toMatch(/p_actor_role|p_role\b/);
  });

  it("the repair window is 72 hours, anchored to the audit baseline", () => {
    const fn = CODE.slice(
      CODE.indexOf("function public.revert_appointment_outcome"),
      CODE.indexOf("comment on function public.revert_appointment_outcome"),
    );
    expect(fn).toMatch(/interval\s*'72 hours'/);
    expect(fn).toContain("no_audit_baseline");
    expect(fn).toContain("from public.appointment_audit");
    // Inclusive at the boundary: `>` refuses, `>=` would refuse AT 72h too.
    expect(fn).toMatch(/now\(\)\s*-\s*v_baseline_at\s*>\s*c_window/);
  });

  it("only terminal statuses are accepted as the expected status", () => {
    const fn = CODE.slice(
      CODE.indexOf("function public.revert_appointment_outcome"),
      CODE.indexOf("comment on function public.revert_appointment_outcome"),
    );
    expect(fn).toMatch(
      /p_expected_status not in \('completed', 'no_show', 'cancelled'\)/,
    );
  });

  it("the UPDATE carries the expected status in its own predicate", () => {
    const fn = CODE.slice(
      CODE.indexOf("function public.revert_appointment_outcome"),
      CODE.indexOf("comment on function public.revert_appointment_outcome"),
    );
    // Optimistic concurrency must be enforced by the UPDATE, not only by the
    // earlier gate — otherwise a concurrent change between the two wins.
    expect(fn).toMatch(/update public\.appointments[\s\S]*?a\.status\s*=\s*p_expected_status/);
  });

  it("23P01 is caught specifically, not broadly", () => {
    const fn = CODE.slice(
      CODE.indexOf("function public.revert_appointment_outcome"),
      CODE.indexOf("comment on function public.revert_appointment_outcome"),
    );
    expect(fn).toContain("when exclusion_violation then");
    expect(fn).toContain("'slot_conflict'");
    expect(fn, "a bare `when others` would swallow unknown failures").not.toMatch(
      /when\s+others\s+then/,
    );
  });

  it("set_appointment_notes trims in SQL and caps at 2000", () => {
    const fn = CODE.slice(
      CODE.indexOf("function public.set_appointment_notes"),
      CODE.indexOf("comment on function public.set_appointment_notes"),
    );
    expect(fn).toMatch(/c_max_notes\s+constant\s+integer\s*:=\s*2000/);
    expect(fn).toMatch(/btrim\(coalesce\(p_notes/);
    expect(fn).toMatch(/v_after\s*=\s*''/); // blank -> NULL
  });

  it("the notes audit records lengths, never the note text", () => {
    const fn = CODE.slice(
      CODE.indexOf("function public.set_appointment_notes"),
      CODE.indexOf("comment on function public.set_appointment_notes"),
    );
    expect(fn).toContain("'previous_length'");
    expect(fn).toContain("'new_length'");
    // The jsonb payload must not carry the text itself under any key.
    const payload = fn.slice(fn.indexOf("jsonb_build_object"));
    expect(payload).not.toMatch(/,\s*v_after\s*[,)]/);
    expect(payload).not.toMatch(/'notes'\s*,/);
  });

  it("set_appointment_notes writes only notes and updated_at", () => {
    const fn = CODE.slice(
      CODE.indexOf("function public.set_appointment_notes"),
      CODE.indexOf("comment on function public.set_appointment_notes"),
    );
    const update = fn.slice(fn.indexOf("update public.appointments"));
    const setClause = update.slice(0, update.indexOf("where"));
    expect(setClause).toMatch(/notes\s*=/);
    expect(setClause).toMatch(/updated_at\s*=/);
    for (const forbidden of [
      "status",
      "starts_at",
      "ends_at",
      "duration_minutes",
      "practitioner_id",
      "service_id",
    ]) {
      expect(setClause, `notes command must not write ${forbidden}`).not.toContain(
        `${forbidden} =`,
      );
    }
  });

  it("both commands are SECURITY DEFINER with a pinned search_path", () => {
    for (const fn of FUNCTIONS) {
      const body = CODE.slice(CODE.indexOf(`function public.${fn}(`));
      const head = body.slice(0, body.indexOf("as $$"));
      expect(head, `${fn} must be security definer`).toContain(
        "security definer",
      );
      expect(head, `${fn} must pin search_path`).toMatch(
        /set search_path = pg_catalog, pg_temp/,
      );
    }
  });
});

describe("0173 — scope: B5-B8 are not absorbed", () => {
  it("does not create the audit studio_id column, an actor FK or a transition trigger", () => {
    const s = CODE.toLowerCase();
    expect(s).not.toContain("alter table public.appointment_audit");
    expect(s).not.toContain("add column");
  });

  it("GROUPS 1-4 touch ONLY the repair commands — services/practitioners are confined to GROUP 5", () => {
    // 0173 does close L23, but that work is confined to GROUP 5 so it stays
    // independently auditable. The repair-command groups must not reach the
    // parent tables or touch a policy at all; if they ever do, the two subjects
    // have started to blur and the file has stopped being reviewable in parts.
    const g5 = CODE.indexOf("revoke delete on table public.services");
    expect(g5, "GROUP 5 must exist").toBeGreaterThan(-1);
    const commandGroups = CODE.slice(0, g5);

    for (const stmt of commandGroups.split(";").map((x) => x.trim()).filter(Boolean)) {
      const s = stmt.toLowerCase();
      if (/^(grant|revoke)\b/.test(s) && /\bon\s+table\b/.test(s)) {
        expect(s).not.toMatch(/public\.(services|practitioners)\b/);
      }
      expect(s).not.toMatch(/^drop\s+policy/);
      expect(s).not.toMatch(/^create\s+policy/);
    }
  });

  it("does not absorb B5's 0174 — no such migration is created here", () => {
    // The L23 closure was briefly drafted as a companion 0174. 0174 belongs to
    // B5 (attribution + audit integrity); the full ownership assertion lives in
    // tests/migrations/0173-parent-delete-l23-closure.test.ts.
    expect(PROSE).toMatch(/0174/);
  });
});
