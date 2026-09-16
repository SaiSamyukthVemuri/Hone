import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  aclByFunction,
  actorGated,
  functionDefs,
} from "./migration-acl";

// ===========================================================================
// Authenticated-only clinical RPCs must revoke EVERY default-granted role
// ===========================================================================
//
// Supabase's `ALTER DEFAULT PRIVILEGES` grants EXECUTE on a newly created
// function to `anon`, `authenticated` AND `service_role`, and PostgreSQL grants
// it to PUBLIC. A migration that creates an authenticated-only command must
// therefore revoke from ALL THREE of `public`, `anon` and `service_role`
// explicitly, by name. Granting to `authenticated` does not remove the others.
//
// This rule has now been learned three times:
//   * 0129 revoked only `from public`, leaving `anon` with EXECUTE — 0130 had
//     to clean it up.
//   * 0164 revoked `from public` and `from anon`, leaving `service_role` with
//     EXECUTE, while its own comment claimed there was "deliberately no
//     service_role grant". 0165 repairs it.
//
// The check is textual and deliberately narrow. It looks only at migrations
// that CREATE a **directly callable** function whose body requires a non-null
// `auth.uid()` — i.e. a command intended for authenticated callers only.
//
// TRIGGER FUNCTIONS ARE EXCLUDED, on principle rather than convenience: a
// `returns trigger` function cannot be invoked directly at all (PostgreSQL
// raises `0A000 trigger functions can only be called as triggers`), so an
// EXECUTE grant on one is inert and revoking it would be theatre. Every
// clinical guard trigger in this repo carries default PUBLIC EXECUTE for
// exactly that reason.
//
// Functions that are legitimately service-role callable are exempted by name
// below, each with a stated reason.

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const DEFAULT_GRANTED_ROLES = ["public", "anon", "service_role"] as const;

/**
 * Functions deliberately callable by service_role, so a missing
 * `revoke ... from service_role` is correct for them. Each entry must name the
 * migration and the reason. This list exists because some commands genuinely
 * ARE service-role paths; it is not a place to silence a real miss.
 */
const SERVICE_ROLE_CALLABLE: ReadonlyArray<{ fn: string; why: string }> = [
  { fn: "claim_calendar_sync_op", why: "0124 outbox worker — service-role only by design" },
  { fn: "record_calendar_sync_result", why: "0124 outbox worker — service-role only by design" },
  { fn: "copy_session_setup", why: "0157 provenance ledger — service_role-only RPC" },
];

type Created = {
  file: string;
  fn: string;
  requiresAuthUid: boolean;
  isTrigger: boolean;
  body: string;
};

function migrationFiles(): string[] {
  return readdirSync(MIG_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
}

/** Functions CREATED by a migration, with whether they gate on auth.uid(). */
function createdFunctions(file: string): Created[] {
  const sql = readFileSync(join(MIG_DIR, file), "utf8");
  const code = sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  const out: Created[] = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    // Body = from this definition to the next one (or EOF).
    const next = re.lastIndex;
    const after = code.slice(next);
    const following = /create\s+(?:or\s+replace\s+)?function\s+public\./i.exec(after);
    const body = following ? after.slice(0, following.index) : after;
    out.push({
      file,
      fn: m[1],
      requiresAuthUid: /if\s+auth\.uid\(\)\s+is\s+null\s+then/i.test(body),
      // `returns trigger` — not directly callable, so EXECUTE is inert.
      isTrigger: /\breturns\s+trigger\b/i.test(body),
      body,
    });
  }
  return out;
}

describe("clinical RPC grant guard — authenticated-only commands", () => {
  const created = migrationFiles().flatMap(createdFunctions);

  const authOnly = created.filter(
    (c) =>
      c.requiresAuthUid &&
      !c.isTrigger &&
      !SERVICE_ROLE_CALLABLE.some((s) => s.fn === c.fn),
  );

  it("finds at least one authenticated-only command to check", () => {
    // A regression in the parser must fail loudly rather than vacuously pass.
    expect(authOnly.length).toBeGreaterThan(0);
    expect(authOnly.map((c) => c.fn)).toContain("create_laser_entry");
  });

  it("excludes trigger functions, which are not directly callable", () => {
    // enforce_intake_terminal_immutability (0118, replaced by 0162) is
    // auth.uid()-gated but `returns trigger`, so EXECUTE on it is inert.
    const triggers = created.filter((c) => c.isTrigger).map((c) => c.fn);
    expect(triggers).toContain("enforce_intake_terminal_immutability");
    expect(authOnly.map((c) => c.fn)).not.toContain(
      "enforce_intake_terminal_immutability",
    );
  });

  for (const role of DEFAULT_GRANTED_ROLES) {
    it(`every authenticated-only command revokes EXECUTE from ${role}`, () => {
      const missing: string[] = [];
      for (const c of authOnly) {
        // The revoke may live in the creating migration or a later repair one,
        // so search every migration for a revoke naming this function + role.
        const revoked = migrationFiles().some((f) => {
          const sql = readFileSync(join(MIG_DIR, f), "utf8")
            .split("\n")
            .map((l) => l.replace(/--.*$/, ""))
            .join(" ")
            .replace(/\s+/g, " ");
          const re = new RegExp(
            `revoke\\s+execute\\s+on\\s+function\\s+public\\.${c.fn}\\s*\\([^)]*\\)\\s*from\\s+${role}\\b`,
            "i",
          );
          return re.test(sql);
        });
        if (!revoked) missing.push(`${c.fn} (created in ${c.file})`);
      }
      expect(
        missing,
        `Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated ` +
          `AND service_role at create time, and PostgreSQL grants it to PUBLIC. An ` +
          `authenticated-only command must revoke from public, anon AND service_role ` +
          `explicitly, by name — granting to authenticated does not remove them. ` +
          `This was missed in 0129 (anon) and again in 0164 (service_role).`,
      ).toEqual([]);
    });
  }

  /**
   * A function that is explicitly REVOKEd from `authenticated` and never
   * granted back is an INTERNAL helper, not a command — it exists only to be
   * called from inside another SECURITY DEFINER function, which runs as the
   * owner. The "must grant to authenticated" rule does not apply to it, but
   * every revoke rule above still does. (0166 introduced the first of these:
   * assert_session_writable, assert_block_in_session, write_electrolysis_entry.)
   */
  function isInternalHelper(fn: string): boolean {
    const revoked = migrationFiles().some((f) => {
      const sql = readFileSync(join(MIG_DIR, f), "utf8")
        .split("\n")
        .map((l) => l.replace(/--.*$/, ""))
        .join(" ")
        .replace(/\s+/g, " ");
      return new RegExp(
        `revoke\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\s*\\([^)]*\\)\\s*from\\s+authenticated\\b`,
        "i",
      ).test(sql);
    });
    const granted = migrationFiles().some((f) => {
      const sql = readFileSync(join(MIG_DIR, f), "utf8")
        .split("\n")
        .map((l) => l.replace(/--.*$/, ""))
        .join(" ")
        .replace(/\s+/g, " ");
      return new RegExp(
        `grant\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\s*\\([^)]*\\)\\s*to\\s+authenticated\\b`,
        "i",
      ).test(sql);
    });
    return revoked && !granted;
  }

  it("internal helpers are revoked from authenticated and never granted back", () => {
    // 0166's three helpers. Only assert_session_writable gates on auth.uid()
    // itself — the other two are called after their caller has already
    // validated — so the check is on the revoke, not on the auth-gated set.
    for (const fn of [
      "assert_session_writable",
      "assert_block_in_session",
      "write_electrolysis_entry",
    ]) {
      expect(isInternalHelper(fn), `${fn} must be revoked from authenticated and not granted back`).toBe(true);
    }
  });

  it("every authenticated-only COMMAND grants EXECUTE to authenticated", () => {
    const missing: string[] = [];
    for (const c of authOnly.filter((x) => !isInternalHelper(x.fn))) {
      const granted = migrationFiles().some((f) => {
        const sql = readFileSync(join(MIG_DIR, f), "utf8")
          .split("\n")
          .map((l) => l.replace(/--.*$/, ""))
          .join(" ")
          .replace(/\s+/g, " ");
        return new RegExp(
          `grant\\s+execute\\s+on\\s+function\\s+public\\.${c.fn}\\s*\\([^)]*\\)\\s*to\\s+authenticated\\b`,
          "i",
        ).test(sql);
      });
      if (!granted) missing.push(c.fn);
    }
    expect(missing).toEqual([]);
  });

  it("the service-role-callable exemption list is small, named and justified", () => {
    // Not a growable silencer: every entry must carry a reason mentioning the
    // migration that made it service-role callable.
    expect(SERVICE_ROLE_CALLABLE.length).toBeLessThanOrEqual(5);
    for (const e of SERVICE_ROLE_CALLABLE) {
      expect(e.why).toMatch(/\d{4}/);
      expect(e.why.length).toBeGreaterThan(20);
    }
  });

  it("create_laser_entry is NOT on the service-role-callable list", () => {
    expect(SERVICE_ROLE_CALLABLE.map((e) => e.fn)).not.toContain("create_laser_entry");
  });
});

// ===========================================================================
// WIDENED COVERAGE (Trust follow-up, #705 P2-01)
// ===========================================================================
//
// The guard above is correct but narrow in two independent ways, and the #705
// audit measured the cost: of the browser-callable SECURITY DEFINER commands in
// this chain, it was enforcing the revoke rule on FIVE.
//
//   * CLASSIFICATION. `requiresAuthUid` matches a literal inline
//     `if auth.uid() is null then`. Almost every command here delegates the
//     actor check to a helper — assert_session_writable,
//     session_actor_practitioner, is_studio_member, own_practitioner_in_studio
//     — which is the better design and was invisible to it.
//
//   * DETECTION. A revoke was recognised only as
//     `revoke execute on function public.f(...) from <role>`. The chain also
//     writes `revoke all on function`, `revoke all privileges on function`,
//     comma-separated role lists, and DO-blocks that loop
//     `execute format('revoke all privileges on function %s from anon', f)`
//     over an array of signatures (0134, 0136, 0137, 0138, 0140, 0141, 0150,
//     0173, 0178, 0192).
//
// Both had to widen together: widening classification alone would report
// correctly-revoked commands as unprotected, and widening detection alone
// would change nothing.
//
// CORRECTNESS ORACLE. The parser is not trusted on its own authority. Applied
// to this chain it must conclude that exactly three directly-callable
// SECURITY DEFINER functions retain anon EXECUTE — is_studio_member,
// is_studio_owner and session_is_visible. That is the same set the #705 audit
// measured with has_function_privilege against a real migrated database. A
// parser change that alters that answer is wrong, and says so here.

/** Directly-callable definer functions that may keep anon EXECUTE, with why. */
const ANON_CALLABLE: ReadonlyArray<{ fn: string; why: string }> = [
  {
    fn: "is_studio_member",
    why: "0001 membership predicate; resolves through auth.uid(), so anon can only ever get false",
  },
  {
    fn: "is_studio_owner",
    why: "0001 ownership predicate; resolves through auth.uid(), so anon can only ever get false",
  },
  {
    fn: "session_is_visible",
    why: "0001 visibility predicate; resolves through auth.uid(), so anon can only ever get false",
  },
];

/**
 * Commands that predate this guard and say NOTHING about service_role — they
 * neither revoke it nor grant it, so they inherit Supabase's default EXECUTE.
 * Frozen here so the posture is recorded rather than silently tolerated, and
 * so every NEW command has to declare one. Not a statement that these are
 * correct; a statement that they are known and not growing.
 */
const SERVICE_ROLE_UNDECLARED_LEGACY: readonly string[] = [
  "is_studio_member",
  "is_studio_owner",
  "session_is_visible",
  "get_studio_payment_settings_display",
  "get_appointment_payment_display",
  "get_disputes_for_studio",
  "get_refunds_for_appointment",
  "get_payment_audit_for_appointment",
  "soft_delete_session_area",
];

describe("RPC grant guard — widened to the shapes this repository actually uses", () => {
  const defs = functionDefs();
  const acl = aclByFunction();
  const gated = actorGated(defs);

  const definerCallable = [...defs.values()].filter((d) => d.isDefiner && !d.isTrigger);
  const revoked = (fn: string, role: string) => acl.get(fn)?.revoked.has(role) ?? false;
  const granted = (fn: string, role: string) => acl.get(fn)?.granted.has(role) ?? false;

  /** Actor-gated commands actually exposed to browser sessions. */
  const commands = definerCallable.filter(
    (d) => gated.has(d.fn) && granted(d.fn, "authenticated"),
  );

  it("the parser reproduces the live-database measurement from the #705 audit", () => {
    const keepAnon = definerCallable
      .filter((d) => !revoked(d.fn, "anon"))
      .map((d) => d.fn)
      .sort();
    expect(keepAnon).toEqual(ANON_CALLABLE.map((a) => a.fn).sort());
  });

  it("covers far more than the inline-gated set, and never less", () => {
    // No weakening: every command the original predicate found is still here.
    const inline = definerCallable.filter((d) => d.gatesInline).map((d) => d.fn);
    expect(inline.length).toBeGreaterThan(0);
    const covered = new Set(commands.map((d) => d.fn));
    for (const fn of inline) {
      if (SERVICE_ROLE_CALLABLE.some((s) => s.fn === fn)) continue;
      // Internal helpers are inline-gated but deliberately NOT browser-callable
      // (revoked from authenticated, never granted back — 0166's three). The
      // original guard excluded them too; they are covered by the anon rule.
      if (revoked(fn, "authenticated") && !granted(fn, "authenticated")) continue;
      expect(covered.has(fn), `${fn} was covered by the original guard and must stay covered`).toBe(true);
    }
    // And strictly more: the whole point of the widening.
    expect(commands.length).toBeGreaterThan(inline.length * 4);
  });

  it("every directly-callable SECURITY DEFINER function closes anon, or is named", () => {
    const named = new Set(ANON_CALLABLE.map((a) => a.fn));
    const open = definerCallable
      .filter((d) => !revoked(d.fn, "anon") && !named.has(d.fn))
      .map((d) => `${d.fn} (${d.file})`);
    expect(
      open,
      "Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon at create time, so a " +
        "function with no anon revoke is callable from an anonymous browser session. " +
        "Revoke it, or add it to ANON_CALLABLE with a reason.",
    ).toEqual([]);
  });

  it("every browser-callable command revokes EXECUTE from public", () => {
    const open = commands.filter((d) => !revoked(d.fn, "public")).map((d) => d.fn);
    expect(open).toEqual([]);
  });

  it("every browser-callable command DECLARES a service_role posture", () => {
    const legacy = new Set(SERVICE_ROLE_UNDECLARED_LEGACY);
    const silent = commands
      .filter(
        (d) =>
          !revoked(d.fn, "service_role") &&
          !granted(d.fn, "service_role") &&
          !legacy.has(d.fn),
      )
      .map((d) => `${d.fn} (${d.file})`);
    expect(
      silent,
      "A command that neither revokes service_role nor grants it inherits the default " +
        "EXECUTE silently — the 0164 defect. Say which one it is.",
    ).toEqual([]);
  });

  it("the legacy service_role list is frozen, named and real", () => {
    expect(SERVICE_ROLE_UNDECLARED_LEGACY.length).toBeLessThanOrEqual(9);
    for (const fn of SERVICE_ROLE_UNDECLARED_LEGACY) {
      expect(defs.has(fn), `${fn} is listed as legacy but no longer exists`).toBe(true);
    }
  });

  it("the anon allowlist is small and every entry is justified", () => {
    expect(ANON_CALLABLE.length).toBeLessThanOrEqual(3);
    for (const a of ANON_CALLABLE) {
      expect(a.why).toMatch(/auth\.uid\(\)/);
      expect(defs.has(a.fn)).toBe(true);
    }
  });
});
