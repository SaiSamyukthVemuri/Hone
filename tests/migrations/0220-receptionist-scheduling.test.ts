import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0220 — STUDIO-READY-02c (#824): receptionist scheduling over the
// shared core. SOURCE CONTRACT. Behaviour is proved against real roles in
// tests/db/receptionist-scheduling.db.test.ts, and the practitioner commands'
// unchanged behaviour by their existing suites. This pins what those cannot see:
//   * the three practitioner commands are pure wrappers that pass the LITERAL
//     actor kind 'practitioner', with their signatures unchanged;
//   * every 0174 sentinel survives in each core;
//   * the receptionist commands take no actor, override or notes argument and
//     resolve the actor from receptionist_actor_id;
//   * privileges: cores revoked from every API role, practitioner commands
//     service_role only, receptionist commands authenticated only;
//   * the attribution columns are nullable with no default, and the public
//     booking path is not re-emitted;
//   * no row is written at top level.
// ===========================================================================

const VERSION = "0220";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIGRATIONS, f), "utf8");
const SQL = read("0220_receptionist_scheduling.sql");
const R0174 = read("0174_appointment_attribution_and_audit_integrity.sql");
const stripComments = (sql: string) => sql.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const CODE = stripComments(SQL);
const TOP_LEVEL = CODE.replace(/\$function\$[\s\S]*?\$function\$/g, " ").replace(/\$\$[\s\S]*?\$\$/g, " ");
const flat = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The body of `public.<fn>` between its first dollar-quote pair (case-insensitive). */
function bodyOf(sql: string, fn: string): string {
  const lower = sql.toLowerCase();
  const start = lower.indexOf(`create or replace function public.${fn}(`);
  expect(start, `${fn} not defined`).toBeGreaterThan(-1);
  // Whichever dollar-quote opens first after the header: 0174 and 0220 use
  // $function$, older files use $$.
  const fn$ = lower.indexOf("$function$", start);
  const dd = lower.indexOf("$$", start);
  const tag = fn$ > -1 && (dd === -1 || fn$ <= dd) ? "$function$" : "$$";
  const open = lower.indexOf(tag, start);
  return sql.slice(open + tag.length, lower.indexOf(tag, open + tag.length));
}

const sentinels = (body: string) => new Set([...body.matchAll(/'([a-z_]+)'::text|return '([a-z_]+)'/g)].map((m) => m[1] ?? m[2]));

describe("0220 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this (CLAUDE.md §2).
    expect(isRepoMax(VERSION), "0220 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("opens its own transaction and arms lock_timeout inside it", () => {
    const begin = TOP_LEVEL.search(/\bbegin;/i);
    const timeout = TOP_LEVEL.search(/set local lock_timeout = '5s';/i);
    const commit = TOP_LEVEL.search(/\bcommit;/i);
    expect(begin).toBeGreaterThan(-1);
    expect(timeout).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(timeout);
  });
});

describe("0220 reuses the authoritative commands rather than forking them", () => {
  const WRAPPERS = [
    ["create_internal_appointment_v2", "create_appointment_core"],
    ["move_or_reassign_appointment", "move_appointment_core"],
    ["practitioner_cancel_appointment", "cancel_appointment_core"],
  ] as const;

  it("each practitioner command is a one-statement wrapper passing the LITERAL kind 'practitioner'", () => {
    for (const [cmd, core] of WRAPPERS) {
      const body = flat(stripComments(bodyOf(SQL, cmd)));
      expect(body, cmd).toMatch(new RegExp(`public\\.${core}\\( ?'practitioner',`));
      expect(body, cmd).not.toMatch(/insert into|update public|delete from|receptionist/);
    }
  });

  it("each practitioner command keeps its 0174 signature exactly", () => {
    const sig = (sql: string, fn: string) => {
      const lower = sql.toLowerCase();
      const at = lower.indexOf(`create or replace function public.${fn}(`);
      return flat(sql.slice(at, lower.indexOf("returns", at)))
        .replace(/timestamp with time zone/g, "timestamptz")
        .replace(/::[a-z]+/g, "")
        .replace(/\s/g, "");
    };
    for (const [cmd] of WRAPPERS) expect(sig(SQL, cmd), cmd).toBe(sig(R0174, cmd));
  });

  it("every sentinel the 0174 body can return survives in its core", () => {
    for (const [cmd, core] of WRAPPERS) {
      const before = sentinels(bodyOf(R0174, cmd));
      const after = sentinels(bodyOf(SQL, core));
      expect(before.size, cmd).toBeGreaterThan(2);
      for (const s of before) expect(after.has(s), `${core} lost '${s}'`).toBe(true);
    }
  });

  it("the receptionist commands take no actor, override or notes argument and resolve the actor from the session", () => {
    for (const fn of ["receptionist_create_appointment", "receptionist_move_appointment", "receptionist_cancel_appointment"]) {
      const lower = SQL.toLowerCase();
      const at = lower.indexOf(`create or replace function public.${fn}(`);
      const args = lower.slice(at, lower.indexOf("returns", at));
      expect(args, fn).not.toMatch(/actor|override|outside|notes|duration|token|hash/);
      const body = flat(bodyOf(SQL, fn));
      expect(body, fn).toContain("public.receptionist_actor_id(p_studio_id)");
      expect(body, fn).toMatch(/'receptionist'/);
    }
  });

  it("generates the cancellation credential inside the command, never from the caller (Codex P1 4244695029)", () => {
    const body = flat(stripComments(bodyOf(SQL, "receptionist_create_appointment")));
    expect(body).toContain("encode(pg_catalog.sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'utf8')), 'hex')");
    expect(body).not.toMatch(/p_cancellation_token_hash/);
  });

  it("does not re-emit the public booking path or public cancellation", () => {
    for (const fn of ["create_public_appointment", "reschedule_appointment_v2", "public_cancel_appointment_with_token"]) {
      expect(flat(CODE), fn).not.toContain(`function public.${fn}(`);
    }
  });

  it("re-emits revert_appointment_outcome with ONLY the two canceller clears added (Codex P2 4244674652)", () => {
    const R0173 = read("0173_appointment_repair_commands.sql");
    const norm = (b: string) => flat(stripComments(b));
    const before = norm(bodyOf(R0173, "revert_appointment_outcome"));
    const after = norm(bodyOf(SQL, "revert_appointment_outcome"));
    const added = "cancelled_by_practitioner_id = null, cancelled_by_receptionist_id = null,";
    expect(after).toContain(added);
    expect(after.replace(`${added} `, "")).toBe(before);
    for (const role of ["public", "anon", "authenticated"]) {
      expect(flat(TOP_LEVEL)).toContain(
        `revoke execute on function public.revert_appointment_outcome(uuid, uuid, uuid, text, text) from ${role};`,
      );
    }
    expect(flat(TOP_LEVEL)).toContain(
      "grant execute on function public.revert_appointment_outcome(uuid, uuid, uuid, text, text) to service_role;",
    );
  });
});

describe("0220 privileges", () => {
  const revokes = (sig: string, role: string) => flat(TOP_LEVEL).includes(`revoke execute on function public.${sig} from ${role};`);
  const grants = (sig: string, role: string) => flat(TOP_LEVEL).includes(`grant execute on function public.${sig} to ${role};`);

  const CORES = [
    "create_appointment_core(text, uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, integer, boolean)",
    "cancel_appointment_core(text, uuid, uuid, uuid, text)",
    "move_appointment_core(text, uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, boolean)",
  ];
  const PRACTITIONER_CMDS = [
    "create_internal_appointment_v2(uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, integer, boolean)",
    "practitioner_cancel_appointment(uuid, uuid, uuid, text)",
    "move_or_reassign_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, boolean)",
  ];
  const RECEPTIONIST_CMDS = [
    "receptionist_create_appointment(uuid, uuid, uuid, uuid, timestamptz)",
    "receptionist_cancel_appointment(uuid, uuid, text)",
    "receptionist_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz)",
    "receptionist_booking_options(uuid)",
  ];

  it("every core is revoked by name from public, anon, authenticated AND service_role, and granted to nobody", () => {
    for (const c of CORES) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) expect(revokes(c, role), `${c} ${role}`).toBe(true);
      expect(flat(TOP_LEVEL)).not.toContain(`grant execute on function public.${c}`);
    }
  });

  it("the practitioner commands stay service_role only", () => {
    for (const c of PRACTITIONER_CMDS) {
      for (const role of ["public", "anon", "authenticated"]) expect(revokes(c, role), `${c} ${role}`).toBe(true);
      expect(grants(c, "service_role"), c).toBe(true);
    }
  });

  it("the receptionist commands are authenticated only (revoked from public, anon and service_role by name)", () => {
    for (const c of RECEPTIONIST_CMDS) {
      for (const role of ["public", "anon", "service_role"]) expect(revokes(c, role), `${c} ${role}`).toBe(true);
      expect(grants(c, "authenticated"), c).toBe(true);
    }
  });
});

describe("0220 attribution and data", () => {
  it("adds the two receptionist attribution columns nullable with NO default (the public INSERT shape holds)", () => {
    const t = flat(TOP_LEVEL);
    expect(t).toContain("add column if not exists created_by_receptionist_id uuid,");
    expect(t).toContain("add column if not exists cancelled_by_receptionist_id uuid;");
    expect(t).not.toMatch(/receptionist_id uuid (not null|default)/);
  });

  it("only WIDENS cancelled_by and actor_type, and keeps actor_id_type NOT VALID", () => {
    const t = flat(TOP_LEVEL);
    expect(t).toContain("check (cancelled_by in ('client', 'practitioner', 'owner', 'receptionist') or cancelled_by is null)");
    expect(t).toContain("check (actor_type in ('practitioner', 'client', 'system', 'receptionist'))");
    expect(t).toMatch(/appointment_audit_actor_id_type_ck check \(.*\) not valid;/);
  });

  it("writes no row at top level", () => {
    expect(TOP_LEVEL).not.toMatch(/^\s*(insert\s+into|update\s+public\.|delete\s+from)/im);
  });
});
