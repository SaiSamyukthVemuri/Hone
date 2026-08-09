import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// 0173 GROUP 5 — L23 parent-delete appointment-lineage closure, source contract.
//
// L23 was briefly drafted as a companion migration `0174`. That was wrong: the
// canonical appointment-DML program reserves 0174 for B5 (attribution + audit
// integrity), 0175 for B6, 0176 for B7 and 0177 for B8, so consuming 0174 here
// would have shifted every later boundary migration by one. The closure now
// lives in GROUP 5 of 0173.
//
// It keeps its own test file rather than being merged into
// tests/migrations/0173-appointment-repair-commands.test.ts because it is a
// genuinely separate subject — a privilege/policy change on two OTHER tables —
// and reviewing it on its own terms is the point. Both files are 0173-scoped.
//
// Behaviour lives in tests/db/appointment-parent-delete-boundary.db.test.ts,
// including the two-way self-test that proves the L23 hazard was real before
// this group closed it.
// ===========================================================================

const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");
const FILE = "supabase/migrations/0173_appointment_repair_commands.sql";
const SQL = readFileSync(join(__dirname, "..", "..", FILE), "utf8");

/**
 * GROUP 5 only. The rest of 0173 legitimately creates functions and revokes
 * EXECUTE, so a whole-file scan would make several assertions below meaningless.
 * Anchoring on the banner keeps this contract about the L23 closure alone.
 */
const G5_START = SQL.indexOf("-- GROUP 5 — L23: PARENT-DELETE APPOINTMENT-LINEAGE CLOSURE");
const L23_SECTION = SQL.slice(G5_START);

const L23_CODE = L23_SECTION.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const L23_PROSE = L23_SECTION.split("\n")
  .filter((l) => l.trimStart().startsWith("--"))
  .join(" ");

/**
 * Every executable REVOKE in the WHOLE file, whole. NOT `^revoke` — see the
 * 0172 test: anchoring at column 0 makes a single-space-indented statement
 * invisible to this list and to every guard built on it, and an adversarial
 * pass found four mutants that survived a full suite that way.
 *
 * Whole-file on purpose: it is what proves GROUP 4's EXECUTE revocations (which
 * run through `execute format(...)` inside a DO block) never become table
 * revokes, and that L23's two are the only table revokes in 0173.
 */
const ALL_REVOKES =
  SQL.split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .match(/^[ \t]*revoke\b[^;]+;/gm) ?? [];

const L23_STATEMENTS = L23_CODE.split(";")
  .map((s) => s.trim())
  .filter(Boolean);

const PARENTS = ["services", "practitioners"] as const;

// ---------------------------------------------------------------------------

describe("0173 GROUP 5 — migration ownership", () => {
  it("GROUP 5 exists inside 0173", () => {
    expect(G5_START, "the GROUP 5 banner must be present").toBeGreaterThan(-1);
    expect(L23_CODE.length).toBeGreaterThan(100);
  });

  it("NO 0174 migration exists — that number belongs to B5", () => {
    const files = readdirSync(MIGRATIONS_DIR);
    const zero174 = files.filter((f) => f.startsWith("0174"));
    expect(
      zero174,
      `0174 is reserved for B5 (appointment attribution + audit integrity); found: ${zero174.join(", ")}`,
    ).toEqual([]);
    expect(
      existsSync(
        join(MIGRATIONS_DIR, "0174_revoke_parent_delete_appointment_lineage.sql"),
      ),
      "the withdrawn 0174 companion must not exist",
    ).toBe(false);
  });

  it("the file records WHY L23 lives here rather than in its own migration", () => {
    expect(L23_PROSE).toMatch(/0174/);
    expect(L23_PROSE.toLowerCase()).toContain("b5");
  });
});

describe("0173 GROUP 5 — the privilege change is exactly DELETE on exactly two tables", () => {
  it.each(PARENTS)("%s: DELETE revoked from anon AND authenticated", (table) => {
    const re = new RegExp(
      `revoke\\s+delete\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+anon,\\s*authenticated\\s*;`,
    );
    expect(L23_CODE).toMatch(re);
  });

  it("0173 contains exactly two TABLE revokes in total, both in GROUP 5", () => {
    // GROUP 4's EXECUTE revocations go through `execute format(...)` inside a DO
    // block, so they are string literals and must not appear here.
    expect(ALL_REVOKES).toHaveLength(2);
    for (const stmt of ALL_REVOKES) {
      expect(L23_CODE).toContain(stmt.trim());
    }
  });

  it("NO revocation names SELECT, INSERT or UPDATE", () => {
    // The whole point: the settings pages keep working. A revoke that reached
    // SELECT would take the services list down with it.
    for (const stmt of ALL_REVOKES) {
      const s = stmt.toLowerCase();
      const verbs = s.slice(s.indexOf("revoke"), s.indexOf(" on "));
      expect(verbs).not.toMatch(/\bselect\b/);
      expect(verbs).not.toMatch(/\binsert\b/);
      expect(verbs).not.toMatch(/\bupdate\b/);
    }
  });

  it("contains no `revoke all` anywhere in 0173", () => {
    expect(SQL.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n").toLowerCase())
      .not.toMatch(/revoke\s+all\b/);
  });

  it("NEVER revokes from service_role or postgres", () => {
    for (const stmt of ALL_REVOKES) {
      const s = stmt.toLowerCase();
      expect(s, "service_role maintenance must survive").not.toContain(
        "service_role",
      );
      expect(s).not.toMatch(/\bpostgres\b/);
    }
  });

  it("touches no table other than services and practitioners", () => {
    for (const stmt of L23_STATEMENTS) {
      const s = stmt.toLowerCase();
      if (/^(grant|revoke)\b/.test(s) && /\bon\s+table\b/.test(s)) {
        const target = s.slice(s.indexOf(" on table ") + 10).split(/\s+/)[0];
        expect(["public.services", "public.practitioners"]).toContain(target);
      }
    }
  });

  it("does NOT touch clients or studios — already default-denied", () => {
    for (const stmt of L23_STATEMENTS) {
      const s = stmt.toLowerCase();
      if (/^(grant|revoke|drop policy|create policy)/.test(s)) {
        expect(s).not.toMatch(/public\.(clients|studios)\b/);
      }
    }
    // The reasoning must still be recorded for the next reader.
    expect(L23_PROSE).toMatch(/clients/i);
    expect(L23_PROSE).toMatch(/studios/i);
  });
});

describe("0173 GROUP 5 — the policy residue", () => {
  it("drops the standalone practitioners DELETE policy outright", () => {
    expect(L23_CODE).toMatch(
      /drop policy if exists "practitioners: owners delete" on public\.practitioners\s*;/,
    );
    expect(L23_CODE).not.toMatch(
      /create policy[^;]*practitioners[^;]*for delete/i,
    );
  });

  it("leaves the other practitioners policies alone", () => {
    // members read / owners insert / owners update are 0001's and must survive.
    for (const p of [
      "practitioners: members read",
      "practitioners: owners insert",
      "practitioners: owners update",
    ]) {
      expect(L23_CODE, `${p} must not be dropped or recreated`).not.toContain(p);
    }
  });

  it("replaces the services FOR ALL policy with select/insert/update only", () => {
    expect(L23_CODE).toMatch(
      /drop policy if exists "services_member_all" on public\.services\s*;/,
    );
    for (const cmd of ["select", "insert", "update"]) {
      expect(L23_CODE).toMatch(
        new RegExp(
          `create policy "services_member_${cmd}"\\s+on public\\.services for ${cmd} to authenticated`,
        ),
      );
    }
  });

  it("creates NO delete policy on either parent", () => {
    const creates = L23_CODE.match(/create policy[^;]+;/g) ?? [];
    expect(creates.length).toBe(3);
    for (const c of creates) {
      expect(c.toLowerCase()).not.toMatch(/\bfor delete\b/);
    }
  });

  it("the DROP and its replacements are inside 0173's ONE transaction", () => {
    // Dropping services_member_all without its replacement in the same
    // transaction has the same blast radius as revoking SELECT.
    const begin = SQL.indexOf("\nbegin;");
    const commit = SQL.lastIndexOf("\ncommit;");
    const drop = SQL.indexOf('drop policy if exists "services_member_all"');
    const lastCreate = SQL.lastIndexOf('create policy "services_member_update"');
    expect(begin).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(begin);
    expect(lastCreate).toBeGreaterThan(drop);
    expect(commit).toBeGreaterThan(lastCreate);
  });

  it("reuses is_studio_member VERBATIM and does not redefine it", () => {
    const creates = L23_CODE.match(/create policy[^;]+;/g) ?? [];
    for (const c of creates) {
      expect(c).toContain("public.is_studio_member(studio_id)");
    }
    expect(SQL).not.toMatch(
      /create or replace function public\.is_studio_member/,
    );
  });

  it("every replacement policy is TO authenticated, never PUBLIC", () => {
    const creates = L23_CODE.match(/create policy[^;]+;/g) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const c of creates) {
      expect(c).toMatch(/\bto authenticated\b/);
    }
  });
});

describe("0173 GROUP 5 — what it must not do", () => {
  it("alters NO foreign key or referential action", () => {
    for (const stmt of L23_STATEMENTS) {
      const s = stmt.toLowerCase();
      expect(s).not.toMatch(/^alter\s+table/);
      expect(s).not.toContain("on delete set null");
      expect(s).not.toContain("on delete cascade");
    }
    // The decision to leave FK semantics alone must be recorded.
    expect(L23_PROSE.toLowerCase()).toContain("on delete set null");
  });

  it("creates, replaces or drops NO function or trigger", () => {
    for (const stmt of L23_STATEMENTS) {
      const s = stmt.toLowerCase();
      expect(s).not.toMatch(/^create\s+(or\s+replace\s+)?function/);
      expect(s).not.toMatch(/^create\s+(or\s+replace\s+)?trigger/);
      expect(s).not.toMatch(/^drop\s+(function|trigger)/);
    }
  });

  it("writes no row", () => {
    for (const stmt of L23_STATEMENTS) {
      expect(stmt.toLowerCase()).not.toMatch(/^(insert|update|delete)\b/);
    }
  });

  it("grants nothing to a browser role — B3's boundary is untouched", () => {
    for (const stmt of L23_STATEMENTS) {
      const s = stmt.toLowerCase();
      if (/^grant\b/.test(s)) {
        expect(s).not.toMatch(/\b(anon|authenticated)\b/);
      }
    }
  });
});

describe("0173 GROUP 5 — the census that authorises it is recorded", () => {
  it("records the FK census, the runtime delete census and the deactivation workflow", () => {
    const p = L23_PROSE.toLowerCase();
    expect(p).toContain("services.active");
    expect(p).toContain("practitioners.active");
    expect(p).toMatch(/zero hard-delete/);
    // The 0087 precedent this group follows.
    expect(p).toContain("0087");
    // The reason both layers move rather than only the privilege.
    expect(p).toContain("0172");
    // ON UPDATE is the sibling hazard and must be named.
    expect(p).toContain("on update no action");
  });
});
