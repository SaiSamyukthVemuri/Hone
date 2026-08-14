import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
//   * 0129 revoked only `from public`, leaving `anon` with EXECUTE, 0130 had
//     to clean it up.
//   * 0164 revoked `from public` and `from anon`, leaving `service_role` with
//     EXECUTE, while its own comment claimed there was "deliberately no
//     service_role grant". 0165 repairs it.
//
// The check is textual and deliberately narrow. It looks only at migrations
// that CREATE a **directly callable** function whose body requires a non-null
// `auth.uid()`, i.e. a command intended for authenticated callers only.
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
  { fn: "claim_calendar_sync_op", why: "0124 outbox worker, service-role only by design" },
  { fn: "record_calendar_sync_result", why: "0124 outbox worker, service-role only by design" },
  { fn: "copy_session_setup", why: "0157 provenance ledger, service_role-only RPC" },
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
      // `returns trigger`: not directly callable, so EXECUTE is inert.
      isTrigger: /\breturns\s+trigger\b/i.test(body),
      body,
    });
  }
  return out;
}

describe("clinical RPC grant guard: authenticated-only commands", () => {
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
          `explicitly, by name, granting to authenticated does not remove them. ` +
          `This was missed in 0129 (anon) and again in 0164 (service_role).`,
      ).toEqual([]);
    });
  }

  /**
   * A function that is explicitly REVOKEd from `authenticated` and never
   * granted back is an INTERNAL helper, not a command, it exists only to be
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
    // itself, the other two are called after their caller has already
    // validated, so the check is on the revoke, not on the auth-gated set.
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
