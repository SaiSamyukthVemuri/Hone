import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// 0172, APPOINTMENT BOUNDARY B3 source contract.
//
// This is a privilege/policy CUTOVER with zero application-runtime change, so
// the contract is mostly about what the file must NOT contain. Everything
// asserted here is a byte-level property of the migration; behaviour lives in
// tests/db/appointment-boundary-revocation.db.test.ts.
//
// Cloned from tests/migrations/0169-final-l18-revocation.test.ts, which is the
// repository's template for a revoke migration.
// ===========================================================================

const FILE = "supabase/migrations/0172_revoke_authenticated_appointment_dml.sql";
const SQL = readFileSync(join(__dirname, "..", "..", FILE), "utf8");

/**
 * The migration with `--` comment lines stripped. Prose that DESCRIBES a
 * forbidden pattern ("REVOKE ALL is forbidden", "no create or replace
 * function") must never satisfy a guard looking for that pattern, the header
 * of this migration discusses every one of them at length.
 */
const CODE = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");
const CODE_FLAT = CODE.replace(/\s+/g, " ");
const PROSE = SQL.split("\n")
  .filter((l) => l.trimStart().startsWith("--"))
  .join(" ");

/**
 * Every executable REVOKE statement, whole.
 *
 * NOT `^revoke`, that anchors at column 0, so a statement indented by a single
 * space becomes INVISIBLE to this list and to every guard built on it. An
 * adversarial pass demonstrated four mutants that passed the entire suite that
 * way, including `  revoke select on table public.appointments from
 * authenticated;` sailing past the "no revocation names SELECT" doctrine, and
 * `  revoke insert, update, delete on all tables in schema public from
 * authenticated;` evading the count, the grantee check and the two-table scope
 * check at once. Leading whitespace is now consumed, and the statement-count
 * cross-check below proves the extraction saw everything.
 */
const REVOKES = CODE.match(/^[ \t]*revoke\b[^;]+;/gm) ?? [];

/** Every executable statement, split on `;`, for whole-file scope checks. */
const STATEMENTS = CODE.split(";")
  .map((s) => s.trim())
  .filter(Boolean);

const TABLES = ["appointments", "appointment_audit"] as const;
const ROW_DML = ["insert", "update", "delete"] as const;

// ---------------------------------------------------------------------------

// 0173 superseded 0172 as the repository maximum when B4 landed. B4 ships ONE
// migration: 0173 carries both the repair commands and, in its GROUP 5, the L23
// parent-delete closure. (That closure was briefly drafted as a companion 0174
// and withdrawn, 0174 is reserved for B5.) Per CLAUDE.md §2, ONLY the current
// maximum migration's own test may assert isRepoMax, an older per-migration
// test that keeps the pin turns every subsequent migration into a mechanical
// sweep, which is exactly how 0163/0164/0165 each went red after push. The
// "nothing above me" tripwire is served centrally by the current maximum's test
// (tests/migrations/0173-appointment-repair-commands.test.ts).
//
// This file's own contract is unchanged: 0172 is applied-frozen in B3 and B4
// does not edit a single byte of it.

describe("0172, GROUP 1/2: row DML revoked from both browser roles on both tables", () => {
  for (const table of TABLES) {
    for (const role of ["authenticated", "anon"] as const) {
      it(`${table}: INSERT, UPDATE, DELETE revoked from ${role}`, () => {
        // Whitespace-tolerant so the file may stay column-aligned, but the
        // grantee and the three verbs are pinned exactly.
        const re = new RegExp(
          `^revoke\\s+insert,\\s*update,\\s*delete\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+${role};$`,
          "m",
        );
        expect(CODE, `${table} <- ${role}`).toMatch(re);
      });
    }
  }

  it("every row-DML revocation names all three verbs", () => {
    const rowDmlRevokes = REVOKES.filter((r) => /\binsert\b/.test(r));
    expect(rowDmlRevokes).toHaveLength(4); // 2 tables x 2 roles
    for (const line of rowDmlRevokes) {
      for (const verb of ROW_DML) {
        expect(line, line).toMatch(new RegExp(`\\b${verb}\\b`));
      }
    }
  });
});

describe("0172, GROUP 4: TRUNCATE, REFERENCES and TRIGGER revoked", () => {
  for (const table of TABLES) {
    it(`${table}: truncate, references, trigger revoked from anon and authenticated`, () => {
      const re = new RegExp(
        `^revoke\\s+truncate,\\s*references,\\s*trigger\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+anon,\\s*authenticated;$`,
        "m",
      );
      expect(CODE, table).toMatch(re);
    });
  }
});

describe("0172, GROUP 5: the production-measured MAINTAIN privilege is named explicitly", () => {
  // Production measured `arwdDxtm` for anon and authenticated on BOTH tables.
  // The trailing `m` IS MAINTAIN (PostgreSQL 17+). If it is not named here it
  // survives the cutover silently, because REVOKE ALL is forbidden and nothing
  // else sweeps it up.
  for (const table of TABLES) {
    it(`${table}: maintain revoked from anon and authenticated`, () => {
      const re = new RegExp(
        `^revoke\\s+maintain\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+anon,\\s*authenticated;$`,
        "m",
      );
      expect(CODE, table).toMatch(re);
    });
  }

  it("MAINTAIN is revoked in its own statements, never folded into another group", () => {
    // Its own group is deliberate: it is the ONE group with a version floor
    // (syntax error below PostgreSQL 17), so a reviewer must be able to excise
    // it without touching the P1 closure in groups 1-2 or the sweep in group 4.
    const maintainLines = REVOKES.filter((r) => /\bmaintain\b/i.test(r));
    expect(maintainLines).toHaveLength(2);
    for (const line of maintainLines) {
      expect(line, line).not.toMatch(/\b(insert|update|delete|truncate|references|trigger)\b/i);
    }
  });

  it("documents the PostgreSQL 17 version floor and the production measurement", () => {
    expect(PROSE).toMatch(/PostgreSQL 17/);
    expect(PROSE).toMatch(/major_version = 17/);
    expect(PROSE).toMatch(/arwdDxtm/);
  });
});

describe("0172: the exact revocation surface, and nothing beyond it", () => {
  it("contains exactly EIGHT revoke statements", () => {
    // 4 row-DML (2 tables x 2 roles) + 2 group-4 + 2 group-5.
    expect(REVOKES).toHaveLength(8);
  });

  it("the REVOKE extraction is complete, no statement can hide from it", () => {
    // The guard on the guard. Counts every `revoke` token in the executable SQL
    // independently of the extraction regex, so an indented, line-wrapped or
    // otherwise unusually-formatted revoke cannot be silently skipped by the
    // list every other assertion in this file is built on.
    const tokens = (CODE.match(/\brevoke\b/gi) ?? []).length;
    expect(tokens, "every `revoke` token must appear in exactly one extracted statement").toBe(
      REVOKES.length,
    );
  });

  it("the whole file contains exactly FIFTEEN executable statements", () => {
    // begin, set local lock_timeout, 8 revokes, 3 drop policy, 1 create policy,
    // commit. Anything smuggled in, at any indentation, changes this number.
    expect(STATEMENTS).toHaveLength(15);
  });

  it("no statement uses a schema-wide or ALL TABLES form", () => {
    // `revoke ... on all tables in schema public` contains no `public.<table>`
    // token, so it evades every "exactly two tables" check by construction.
    expect(CODE_FLAT).not.toMatch(/all tables in schema/i);
    expect(CODE_FLAT).not.toMatch(/all sequences in schema/i);
    expect(CODE_FLAT).not.toMatch(/all functions in schema/i);
    expect(CODE_FLAT).not.toMatch(/default privileges/i);
  });

  it("every executable statement is one of the shapes this migration is allowed to contain", () => {
    // A whitelist, so a statement TYPE nobody anticipated fails rather than
    // slipping between the negative guards.
    const ALLOWED = [
      /^begin$/i,
      /^set local lock_timeout = '5s'$/i,
      /^revoke\b/i,
      /^drop policy if exists\b/i,
      /^create policy\b/i,
      /^commit$/i,
    ];
    for (const s of STATEMENTS) {
      expect(
        ALLOWED.some((re) => re.test(s)),
        `unexpected statement shape: ${s.slice(0, 120)}`,
      ).toBe(true);
    }
  });

  it("targets ONLY public.appointments and public.appointment_audit", () => {
    const targets = [...CODE.matchAll(/on table public\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(targets)].sort()).toEqual([...TABLES].sort());
  });

  it("exactly two tables appear anywhere in the executable SQL", () => {
    // Catches a stray `public.appointment_payments` or
    // `public.studio_calendar_reservations` creeping in, all three are
    // deliberately out of scope and get their own hygiene migration.
    const referenced = [...CODE.matchAll(/public\.(\w+)/g)]
      .map((m) => m[1])
      // is_studio_member is the policy predicate, not a table.
      .filter((n) => n !== "is_studio_member");
    expect([...new Set(referenced)].sort()).toEqual([...TABLES].sort());
  });

  it("every revocation targets anon or authenticated and NOTHING else", () => {
    const grantees = REVOKES.flatMap((r) => {
      const m = r.match(/from\s+([^;]+);/);
      return m ? m[1].split(",").map((s) => s.trim()) : [];
    });
    expect(new Set(grantees)).toEqual(new Set(["anon", "authenticated"]));
  });
});

describe("0172: service_role, postgres and PUBLIC are untouched", () => {
  it("NEVER revokes anything from service_role", () => {
    // The governed command layer executes as service_role. Revoking here would
    // be an outage, and this is the single most important negative in the file.
    expect(CODE_FLAT, "service_role must never be a grantee").not.toMatch(
      /\bfrom\s+[^;]*service_role/i,
    );
    expect(CODE_FLAT).not.toMatch(/\bservice_role\b/i);
  });

  it("NEVER revokes anything from postgres or PUBLIC", () => {
    // `public.` in `on table public.x` is a SCHEMA qualifier, not a role, so
    // the grantee position is matched specifically.
    for (const role of ["postgres", "public"]) {
      expect(CODE_FLAT, `${role} must not be a grantee`).not.toMatch(
        new RegExp(`\\bfrom\\s+[^;]*\\b${role}\\b`, "i"),
      );
    }
  });
});

describe("0172: SELECT is retained and REVOKE ALL is forbidden", () => {
  it("never uses REVOKE ALL", () => {
    // REVOKE ALL would take SELECT with it, breaking ~22 authenticated read
    // sites, and would silently absorb any future privilege type instead of
    // naming exactly the verbs this cutover is about.
    expect(CODE_FLAT).not.toMatch(/revoke\s+all/i);
  });

  it("no revocation names SELECT", () => {
    for (const line of REVOKES) {
      expect(line, line).not.toMatch(/\bselect\b/i);
    }
  });

  it("contains NO grant statement at all", () => {
    expect(CODE_FLAT).not.toMatch(/\bgrant\b/i);
  });
});

describe("0172, GROUP 3: the policy replacement", () => {
  it("drops appointments_member_all", () => {
    expect(CODE).toMatch(
      /^drop policy if exists "appointments_member_all" on public\.appointments;$/m,
    );
  });

  it("creates a SELECT-only appointments_member_select reusing the membership predicate verbatim", () => {
    expect(CODE_FLAT).toMatch(
      /create policy "appointments_member_select" on public\.appointments for select to authenticated using \(public\.is_studio_member\(studio_id\)\);/,
    );
  });

  it("the replacement policy carries NO with check clause", () => {
    // A SELECT policy cannot have one, and its absence is the point: there is
    // no write path left to check.
    const stmt = CODE_FLAT.match(/create policy "appointments_member_select"[^;]+;/)?.[0] ?? "";
    expect(stmt).not.toMatch(/with check/i);
  });

  it("the DROPs and the CREATE are adjacent, inside the one transaction", () => {
    // Dropping appointments_member_all WITHOUT its replacement has exactly the
    // same blast radius as REVOKE ALL: no permissive SELECT policy, so every
    // practitioner read returns zero rows.
    const lines = CODE.split("\n").map((l) => l.trim()).filter(Boolean);
    const dropIdx = lines.findIndex((l) => l.startsWith('drop policy if exists "appointments_member_all"'));
    const createIdx = lines.findIndex((l) => l.startsWith('create policy "appointments_member_select"'));
    expect(dropIdx, "drop present").toBeGreaterThan(-1);
    // drop member_all -> drop member_select -> create member_select
    expect(createIdx, "create immediately follows the two drops").toBe(dropIdx + 2);
  });

  it("the replacement policy is itself dropped first, so a re-run cannot abort 42710", () => {
    // Repository convention (docs/09_DATABASE_AND_RLS.md) and push safety: a
    // bare CREATE POLICY on a pre-existing table aborts with 42710 if a policy
    // of that name already exists in the target database.
    expect(CODE).toMatch(
      /^drop policy if exists "appointments_member_select" on public\.appointments;$/m,
    );
    const lines = CODE.split("\n").map((l) => l.trim()).filter(Boolean);
    const dropSelf = lines.findIndex((l) =>
      l.startsWith('drop policy if exists "appointments_member_select"'),
    );
    const create = lines.findIndex((l) => l.startsWith('create policy "appointments_member_select"'));
    expect(dropSelf, "self-drop present").toBeGreaterThan(-1);
    expect(create, "self-drop immediately precedes the create").toBe(dropSelf + 1);
  });

  it("every CREATE POLICY in this file is preceded by a same-name DROP", () => {
    const created = [...CODE.matchAll(/create policy "([^"]+)"/g)].map((m) => m[1]);
    for (const name of created) {
      expect(CODE, `${name} must be dropped before it is created`).toMatch(
        new RegExp(`^drop policy if exists "${name}" on `, "m"),
      );
    }
  });

  it("drops appointment_audit_member_insert", () => {
    expect(CODE).toMatch(
      /^drop policy if exists "appointment_audit_member_insert" on public\.appointment_audit;$/m,
    );
  });

  it("does NOT touch appointment_audit_member_read: its studio_id redesign is B5/0174", () => {
    expect(CODE_FLAT).not.toMatch(/appointment_audit_member_read/);
  });

  it("does not rewrite is_studio_member", () => {
    expect(CODE_FLAT).not.toMatch(/function public\.is_studio_member/i);
  });

  it("declares exactly one policy and drops exactly three", () => {
    // drops: appointments_member_all, appointments_member_select (the
    // push-safety self-drop), appointment_audit_member_insert.
    expect(CODE.match(/^[ \t]*create policy /gm) ?? []).toHaveLength(1);
    expect(CODE.match(/^[ \t]*drop policy /gm) ?? []).toHaveLength(3);
  });
});

describe("0172: replaces no function, and no trigger function above all", () => {
  it("contains NO function statement of any kind", () => {
    // STANDING PROHIBITION. Production's snapshot_appointment_buffer() carries
    // an out-of-band GUC behaviour that exists in NO migration in this repo, so
    // a `create or replace function` emitted from repo source would silently
    // delete a live production behaviour.
    expect(CODE_FLAT).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
    expect(CODE_FLAT).not.toMatch(/drop\s+function/i);
    expect(CODE_FLAT).not.toMatch(/alter\s+function/i);
  });

  it("never names snapshot_appointment_buffer in executable SQL", () => {
    expect(CODE_FLAT).not.toMatch(/snapshot_appointment_buffer/i);
  });

  it("revokes no function EXECUTE", () => {
    expect(CODE_FLAT).not.toMatch(/on function/i);
    expect(CODE_FLAT).not.toMatch(/execute/i);
  });
});

describe("0172: changes no schema and no data", () => {
  it("makes no table, column, index, trigger, constraint or ownership change", () => {
    for (const forbidden of [
      /create table/i,
      /alter table/i,
      /drop table/i,
      /create trigger/i,
      /drop trigger/i,
      /alter trigger/i,
      /create index/i,
      /drop index/i,
      /owner to/i,
      /add constraint/i,
      /create extension/i,
    ]) {
      expect(CODE_FLAT, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("writes, deletes or repairs no row", () => {
    for (const forbidden of [
      /\binsert into\b/i,
      /\bupdate\s+public\./i,
      /\bdelete from\b/i,
      /\btruncate\s+table\b/i,
    ]) {
      expect(CODE_FLAT, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("does not disturb row level security enablement", () => {
    expect(CODE_FLAT).not.toMatch(/row level security/i);
  });
});

describe("0172: transaction and lock discipline", () => {
  it("opens its OWN transaction and commits it", () => {
    // `supabase db push` does not wrap a migration file in a transaction.
    expect(SQL).toMatch(/^begin;$/m);
    expect(SQL).toMatch(/^commit;$/m);
  });

  it("arms lock_timeout INSIDE the transaction, not before it", () => {
    // A bare SET LOCAL outside a transaction emits 25P01 and never arms, the
    // 0159 lesson, recorded verbatim at 0169:70-76.
    const lines = CODE.split("\n").map((l) => l.trim()).filter(Boolean);
    const begin = lines.findIndex((l) => l === "begin;");
    const lock = lines.findIndex((l) => /^set local lock_timeout\s*=\s*'5s';$/.test(l));
    const commit = lines.findIndex((l) => l === "commit;");
    expect(begin, "begin; present").toBe(0);
    expect(lock, "lock_timeout armed").toBeGreaterThan(begin);
    expect(commit, "commit; last").toBe(lines.length - 1);
    expect(lock).toBeLessThan(commit);
  });

  it("every executable statement lives inside the single transaction", () => {
    const lines = CODE.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines.filter((l) => l === "begin;")).toHaveLength(1);
    expect(lines.filter((l) => l === "commit;")).toHaveLength(1);
    expect(CODE_FLAT).not.toMatch(/rollback/i);
  });
});

describe("0172: the doctrine the file must carry for the next reader", () => {
  it("records that service_role must remain unchanged", () => {
    expect(PROSE).toMatch(/service_role/);
    expect(PROSE).toMatch(/MUST REMAIN UNCHANGED/i);
  });

  it("records the rollback path and the do-not-edit rule", () => {
    expect(PROSE).toMatch(/ROLLBACK/i);
    expect(PROSE).toMatch(/Do not edit this file after it is applied/i);
  });

  it("records WHY SELECT is retained", () => {
    expect(PROSE).toMatch(/SELECT/);
    expect(PROSE).toMatch(/REVOKE ALL/i);
  });

  it("records the zero-application-change census that makes this safe", () => {
    expect(PROSE).toMatch(/appointment-direct-dml-guard/);
    expect(PROSE).toMatch(/postcare_email_/);
  });

  it("records the standing prohibition on replacing snapshot_appointment_buffer", () => {
    expect(PROSE).toMatch(/snapshot_appointment_buffer/);
  });

  it("states the PROVENANCE of the production figures honestly", () => {
    // The boundary audit that specifies these probes is UNMERGED and its §13.2
    // is a specification, not a result set. A reader must not be sent to a
    // document they cannot open and told it contains the measurement.
    expect(PROSE).toMatch(/PROVENANCE/i);
    expect(PROSE).toMatch(/UNMERGED/i);
    expect(PROSE).toMatch(/RE-CONFIRMED|re-confirmed/);
    expect(PROSE).toMatch(/Probe 6 was NOT run/i);
  });

  it("discloses the policy ROLE narrowing rather than burying it", () => {
    // appointments_member_all had no TO clause (PUBLIC); the replacement is
    // TO authenticated. "The predicate is verbatim" must not be allowed to
    // imply "nothing else changed".
    expect(PROSE).toMatch(/TO` clause|TO clause|role clause|ROLE CLAUSE/i);
    expect(PROSE).toMatch(/INERT|inert/);
  });

  it("records the FK referential-action residue it does NOT close", () => {
    // A referential action runs as the constraint's owner and consults neither
    // the ACL nor RLS. The file must not read as "no member can cause a write".
    expect(PROSE).toMatch(/REFERENTIAL ACTIONS|referential action/i);
    expect(PROSE).toMatch(/ON DELETE SET NULL/i);
    expect(PROSE).toMatch(/services_member_all/);
    expect(PROSE).toMatch(/CASCADE/);
  });

  it("explains why 0170 and 0171 are superseded rather than edited", () => {
    // Their post-apply verification comments say "EXPECT both roles still TRUE".
    // docs/production/migration-state.json records the sha256 of the exact 0171
    // bytes applied to production, so editing them would falsify that record.
    expect(PROSE).toMatch(/0170/);
    expect(PROSE).toMatch(/0171/);
    expect(PROSE).toMatch(/f4e8535093721c6fb9c677925a3e4a8f202e3f2ad56b6d6208da608f5d2a62e6/);
  });
});

describe("0172: the two applied migrations it supersedes are left byte-identical", () => {
  // An applied migration is not edited. If either of these hashes changes, a
  // recorded production apply fact has been falsified.
  it("0171 still hashes to the sha256 recorded in migration-state.json as applied", async () => {
    const { createHash } = await import("node:crypto");
    const bytes = readFileSync(
      join(__dirname, "..", "..", "supabase/migrations/0171_public_reschedule_command_v2.sql"),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "f4e8535093721c6fb9c677925a3e4a8f202e3f2ad56b6d6208da608f5d2a62e6",
    );
    const rec = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "docs/production/migration-state.json"), "utf8"),
    );
    expect(rec.hosted_note).toContain(
      "f4e8535093721c6fb9c677925a3e4a8f202e3f2ad56b6d6208da608f5d2a62e6",
    );
  });
});

describe("0172: its production apply remains a frozen historical fact", () => {
  // HISTORY OF THIS BLOCK. It first asserted hosted_migration_max === "0171"
  // ("truth is NOT advanced by this PR"). After the authorized 0172 apply it was
  // inverted to "0172". 0173 has since been applied too, so the CURRENT hosted
  // state is no longer this migration's to pin, that moved to
  // tests/migrations/0173-appointment-repair-commands.test.ts, matching the
  // CLAUDE.md §2 rule that only the current maximum carries current-state pins.
  //
  // What survives here is the part that must NEVER decay: 0172's apply is a
  // recorded production fact, and its bytes are frozen. If either changes, a
  // production apply record has been falsified.
  const rec = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "docs/production/migration-state.json"), "utf8"),
  );

  it("0172's applied bytes are frozen and still recorded in the hosted record", async () => {
    const { createHash } = await import("node:crypto");
    const bytes = readFileSync(join(__dirname, "..", "..", FILE));
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(sha).toBe("b89b0d47a70ea2d4a7574bcc4223081cfe1d527394b3ef8b6d4c82bb090f42f1");
    // The record carries it forward as a superseded-but-frozen apply fact.
    expect(rec.hosted_note).toContain(sha);
  });

  it("0172 is applied, and is no longer claimed as the hosted maximum", () => {
    // Applied: so the record must never regress below it...
    expect(Number(rec.hosted_migration_max)).toBeGreaterThanOrEqual(172);
    // ...but 0173 superseded it, so this file must not pin the current max.
    expect(rec.hosted_migration_max).not.toBe("0171");
  });
});
