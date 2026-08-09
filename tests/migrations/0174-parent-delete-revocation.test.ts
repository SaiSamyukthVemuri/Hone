import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// 0174 — APPOINTMENT BOUNDARY B4 companion (L23) source contract.
//
// Behaviour lives in tests/db/appointment-parent-delete-boundary.db.test.ts,
// including the two-way self-test that proves the L23 hazard was real. This
// file pins byte-level properties: exactly which privileges move, which are
// never named, and that no FK semantics are altered.
//
// Cloned from tests/migrations/0172-appointment-dml-revocation.test.ts.
// ===========================================================================

const FILE =
  "supabase/migrations/0174_revoke_parent_delete_appointment_lineage.sql";
const SQL = readFileSync(join(__dirname, "..", "..", FILE), "utf8");

const CODE = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const PROSE = SQL.split("\n")
  .filter((l) => l.trimStart().startsWith("--"))
  .join(" ");

/**
 * Every executable REVOKE, whole. NOT `^revoke` — see the 0172 test: anchoring
 * at column 0 makes a single-space-indented statement invisible to this list
 * and to every guard built on it, and an adversarial pass found four mutants
 * that survived a full suite that way.
 */
const REVOKES = CODE.match(/^[ \t]*revoke\b[^;]+;/gm) ?? [];

const STATEMENTS = CODE.split(";")
  .map((s) => s.trim())
  .filter(Boolean);

const PARENTS = ["services", "practitioners"] as const;

// ---------------------------------------------------------------------------

describe("0174 — migration state", () => {
  // The CENTRAL tripwire, moved here from
  // tests/migrations/0172-appointment-dml-revocation.test.ts when B4 landed.
  // Only the current maximum migration's own test carries it (CLAUDE.md §2);
  // an older per-migration test that keeps the pin turns every subsequent
  // migration into a mechanical sweep, which is exactly how 0163, 0164 and 0165
  // each went red after push. When 0175 lands, this block moves there and this
  // file drops it.
  it("is the current repository maximum", () => {
    expect(isRepoMax("0174")).toBe(true);
    expect(versionsAbove("0174")).toEqual([]);
  });
});

describe("0174 — the privilege change is exactly DELETE on exactly two tables", () => {
  it.each(PARENTS)("%s: DELETE revoked from anon AND authenticated", (table) => {
    const re = new RegExp(
      `revoke\\s+delete\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+anon,\\s*authenticated\\s*;`,
    );
    expect(CODE).toMatch(re);
  });

  it("revokes exactly two things", () => {
    expect(REVOKES).toHaveLength(2);
  });

  it("NO revocation names SELECT, INSERT or UPDATE", () => {
    // The whole point: the settings pages keep working. A revoke that reached
    // SELECT would take the services list down with it.
    for (const stmt of REVOKES) {
      const s = stmt.toLowerCase();
      const verbs = s.slice(s.indexOf("revoke"), s.indexOf(" on "));
      expect(verbs).not.toMatch(/\bselect\b/);
      expect(verbs).not.toMatch(/\binsert\b/);
      expect(verbs).not.toMatch(/\bupdate\b/);
    }
  });

  it("contains no `revoke all`", () => {
    for (const stmt of STATEMENTS) {
      expect(stmt.toLowerCase()).not.toMatch(/revoke\s+all\b/);
    }
  });

  it("NEVER revokes from service_role or postgres", () => {
    for (const stmt of REVOKES) {
      const s = stmt.toLowerCase();
      expect(s, "service_role maintenance must survive").not.toContain(
        "service_role",
      );
      expect(s).not.toMatch(/\bpostgres\b/);
    }
  });

  it("touches no table other than services and practitioners", () => {
    for (const stmt of STATEMENTS) {
      const s = stmt.toLowerCase();
      if (/^(grant|revoke)\b/.test(s) && /\bon\s+table\b/.test(s)) {
        const target = s.slice(s.indexOf(" on table ") + 10).split(/\s+/)[0];
        expect(["public.services", "public.practitioners"]).toContain(target);
      }
    }
  });

  it("does NOT touch clients or studios — already default-denied", () => {
    for (const stmt of STATEMENTS) {
      const s = stmt.toLowerCase();
      if (/^(grant|revoke|drop policy|create policy)/.test(s)) {
        expect(s).not.toMatch(/public\.(clients|studios)\b/);
      }
    }
    // The reasoning must still be recorded for the next reader.
    expect(PROSE).toMatch(/clients/i);
    expect(PROSE).toMatch(/studios/i);
  });
});

describe("0174 — the policy residue", () => {
  it("drops the standalone practitioners DELETE policy outright", () => {
    expect(CODE).toMatch(
      /drop policy if exists "practitioners: owners delete" on public\.practitioners\s*;/,
    );
    // No replacement: after the revoke it would permit an unreachable action.
    expect(CODE).not.toMatch(/create policy[^;]*practitioners[^;]*for delete/i);
  });

  it("replaces the services FOR ALL policy with select/insert/update only", () => {
    expect(CODE).toMatch(
      /drop policy if exists "services_member_all" on public\.services\s*;/,
    );
    for (const cmd of ["select", "insert", "update"]) {
      expect(CODE).toMatch(
        new RegExp(
          `create policy "services_member_${cmd}"\\s+on public\\.services for ${cmd} to authenticated`,
        ),
      );
    }
  });

  it("creates NO delete policy on either parent", () => {
    const creates = CODE.match(/create policy[^;]+;/g) ?? [];
    for (const c of creates) {
      expect(c.toLowerCase()).not.toMatch(/\bfor delete\b/);
    }
  });

  it("the DROP and its replacements are inside ONE transaction", () => {
    // Dropping services_member_all without its replacement in the same
    // transaction has the same blast radius as revoking SELECT.
    const begin = CODE.indexOf("begin;");
    const commit = CODE.indexOf("commit;");
    const drop = CODE.indexOf('drop policy if exists "services_member_all"');
    const lastCreate = CODE.lastIndexOf('create policy "services_member_update"');
    expect(begin).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(begin);
    expect(lastCreate).toBeGreaterThan(drop);
    expect(commit).toBeGreaterThan(lastCreate);
  });

  it("reuses is_studio_member VERBATIM and does not redefine it", () => {
    const creates = CODE.match(/create policy[^;]+;/g) ?? [];
    for (const c of creates) {
      expect(c).toContain("public.is_studio_member(studio_id)");
    }
    expect(CODE).not.toMatch(/create or replace function public\.is_studio_member/);
  });

  it("every replacement policy is TO authenticated, never PUBLIC", () => {
    const creates = CODE.match(/create policy[^;]+;/g) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const c of creates) {
      expect(c).toMatch(/\bto authenticated\b/);
    }
  });
});

describe("0174 — what it must not do", () => {
  it("alters NO foreign key or referential action", () => {
    for (const stmt of STATEMENTS) {
      const s = stmt.toLowerCase();
      expect(s).not.toMatch(/^alter\s+table/);
      expect(s).not.toContain("on delete set null");
      expect(s).not.toContain("on delete cascade");
    }
    // The decision to leave FK semantics alone must be recorded.
    expect(PROSE.toLowerCase()).toContain("on delete set null");
  });

  it("creates, replaces or drops NO function or trigger", () => {
    for (const stmt of STATEMENTS) {
      const s = stmt.toLowerCase();
      expect(s).not.toMatch(/^create\s+(or\s+replace\s+)?function/);
      expect(s).not.toMatch(/^create\s+(or\s+replace\s+)?trigger/);
      expect(s).not.toMatch(/^drop\s+(function|trigger)/);
    }
    expect(CODE).not.toContain("snapshot_appointment_buffer");
    expect(PROSE).toContain("snapshot_appointment_buffer");
  });

  it("writes no row", () => {
    for (const stmt of STATEMENTS) {
      expect(stmt.toLowerCase()).not.toMatch(/^(insert|update|delete)\b/);
    }
  });

  it("adds no repair command (that is 0173)", () => {
    expect(CODE).not.toContain("revert_appointment_outcome");
    expect(CODE).not.toContain("set_appointment_notes");
  });
});

describe("0174 — transaction and lock discipline", () => {
  it("opens its own transaction (db push does not wrap the file)", () => {
    expect(CODE).toMatch(/^\s*begin\s*;/m);
    expect(CODE).toMatch(/^\s*commit\s*;/m);
  });

  it("arms lock_timeout inside that transaction", () => {
    expect(CODE).toMatch(/set\s+local\s+lock_timeout\s*=\s*'5s'/);
  });
});

describe("0174 — the census that authorises it is recorded", () => {
  it("records the FK census, the runtime delete census and the deactivation workflow", () => {
    const p = PROSE.toLowerCase();
    expect(p).toContain("services.active");
    expect(p).toContain("practitioners.active");
    expect(p).toMatch(/zero hard-delete/);
    // The 0087 precedent this migration follows.
    expect(p).toContain("0087");
    // The reason both layers move rather than only the privilege.
    expect(p).toContain("0172");
  });
});
