import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// 0178 — PRACTITIONER IDENTITY BOUNDARY source contract.
//
// Byte-level properties of the migration; behaviour lives in
// tests/db/practitioner-identity-boundary.db.test.ts.
// ===========================================================================

const FILE = "supabase/migrations/0178_practitioner_identity_boundary.sql";
const SQL = readFileSync(join(__dirname, "..", "..", FILE), "utf8");

/** Executable SQL only. The header discusses every forbidden pattern at length. */
const CODE = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");
const CODE_FLAT = CODE.replace(/\s+/g, " ");
const PROSE = SQL.split("\n")
  .filter((l) => l.trimStart().startsWith("--"))
  .join(" ");

// Leading whitespace is consumed deliberately: an indented statement is
// invisible to a `^`-anchored match, and that exact evasion was demonstrated
// against 0172's suite.
const REVOKES = CODE.match(/^[ \t]*revoke\b[^;]+;/gm) ?? [];
const STATEMENTS = CODE.split(";").map((s) => s.trim()).filter(Boolean);

const COMMANDS = [
  "set_own_practitioner_display_name",
  "set_own_practitioner_color",
  "rotate_own_calendar_feed_token",
  "clear_own_calendar_feed_token",
] as const;

describe("0178 — migration state", () => {
  // Only the current maximum migration's own test carries this (CLAUDE.md §2).
  it("is the current repository maximum", () => {
    expect(isRepoMax("0178")).toBe(true);
    expect(versionsAbove("0178")).toEqual([]);
  });
});

describe("0178 — the revocation surface", () => {
  it("revokes INSERT, UPDATE and DELETE from BOTH browser roles", () => {
    for (const role of ["authenticated", "anon"]) {
      expect(CODE).toMatch(
        new RegExp(
          `^revoke insert, update, delete on table public\\.practitioners from ${role};$`,
          "m",
        ),
      );
    }
  });

  it("revokes TRUNCATE, REFERENCES, TRIGGER and MAINTAIN", () => {
    expect(CODE).toMatch(
      /^revoke truncate, references, trigger on table public\.practitioners from anon, authenticated;$/m,
    );
    expect(CODE).toMatch(
      /^revoke maintain on table public\.practitioners from anon, authenticated;$/m,
    );
  });

  it("NEVER revokes SELECT, and never uses REVOKE ALL", () => {
    // 31 authenticated read sites depend on SELECT.
    for (const line of REVOKES) {
      expect(line, line).not.toMatch(/\bselect\b/i);
    }
    expect(CODE_FLAT).not.toMatch(/revoke\s+all\s+on\s+table/i);
  });

  it("the REVOKE extraction is complete — nothing can hide from it", () => {
    // Guard on the guard: every `revoke` token must belong to an extracted
    // statement, so an indented or reformatted one cannot slip past.
    const tokens = (CODE.match(/\brevoke\b/gi) ?? []).length;
    expect(tokens).toBe(REVOKES.length);
  });

  it("touches exactly ONE table: public.practitioners", () => {
    const tables = [...CODE.matchAll(/on table public\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(tables)]).toEqual(["practitioners"]);
  });

  it("never re-grants broad table DML to authenticated later in the file", () => {
    // The failure mode this pins: revoke at the top, quietly grant back below.
    expect(CODE_FLAT).not.toMatch(/grant[^;]*\b(insert|update|delete|truncate)\b[^;]*on table/i);
    expect(CODE_FLAT).not.toMatch(/grant all/i);
  });

  it("does not touch service_role or postgres TABLE privileges", () => {
    // Scoped to `on table` revokes. The function-EXECUTE revokes legitimately
    // name service_role — that is the 0164 lesson, asserted separately below.
    const tableRevokes = REVOKES.filter((r) => /on table/i.test(r));
    expect(tableRevokes.length).toBeGreaterThan(0);
    for (const line of tableRevokes) {
      expect(line, line).not.toMatch(/\bservice_role\b/);
      expect(line, line).not.toMatch(/\bpostgres\b/);
    }
  });
});

describe("0178 — dead write policies are removed, the read policy is preserved", () => {
  it("drops the owner insert and owner update policies", () => {
    for (const p of ["practitioners: owners insert", "practitioners: owners update"]) {
      expect(CODE).toMatch(
        new RegExp(`^drop policy if exists "${p}" on public\\.practitioners;$`, "m"),
      );
    }
  });

  it("does NOT touch the members read policy", () => {
    expect(CODE_FLAT).not.toMatch(/practitioners: members read/);
  });

  it("creates no policy at all — the command boundary replaces them", () => {
    expect(CODE.match(/^[ \t]*create policy /gm) ?? []).toHaveLength(0);
  });

  it("does not disturb row level security enablement", () => {
    expect(CODE_FLAT).not.toMatch(/row level security/i);
  });
});

describe("0178 — the four self-service commands", () => {
  it.each(COMMANDS)("%s is declared exactly once", (fn) => {
    const decls = CODE.match(new RegExp(`create or replace function public\\.${fn}\\(`, "g")) ?? [];
    expect(decls).toHaveLength(1);
  });

  it("declares ONLY those four functions", () => {
    const declared = [...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map(
      (m) => m[1],
    );
    expect(declared.sort()).toEqual([...COMMANDS].sort());
  });

  it("every command is SECURITY DEFINER with a pinned EMPTY search_path", () => {
    const bodies = CODE.split("create or replace function public.").slice(1);
    expect(bodies).toHaveLength(4);
    for (const b of bodies) {
      const head = b.slice(0, b.indexOf("as $$"));
      expect(head, b.slice(0, 60)).toMatch(/security definer/);
      expect(head, b.slice(0, 60)).toMatch(/set search_path = ''/);
    }
  });

  it("NO command trusts a caller-supplied identity — each proves user_id = auth.uid()", () => {
    // The core of A-P1-01: p_practitioner_id is a LOCATOR, never authority.
    const bodies = CODE.split("create or replace function public.").slice(1);
    for (const b of bodies) {
      const name = b.slice(0, b.indexOf("("));
      expect(b, `${name} must read the actor from auth.uid()`).toMatch(/auth\.uid\(\)/);
      expect(b, `${name} must compare the row owner to the actor`).toMatch(
        /v_owner is distinct from v_actor/,
      );
      expect(b, `${name} must refuse a null actor`).toMatch(/not authenticated/);
      // Ownership must NEVER be the authority for a self-service command.
      expect(b, `${name} must not consult studio ownership`).not.toMatch(/is_studio_owner/);
    }
  });

  it("each command writes exactly ONE named column, and never an identity column", () => {
    const sets = [...CODE.matchAll(/update public\.practitioners\s+set ([^\n]+)/g)].map((m) => m[1]);
    expect(sets).toHaveLength(4);
    const written = sets.map((s) => s.split("=")[0].trim()).sort();
    expect(written).toEqual([
      "calendar_feed_token_hash",
      "calendar_feed_token_hash",
      "color",
      "display_name",
    ]);
    for (const s of sets) {
      expect(s, s).not.toMatch(/\b(user_id|role|active|studio_id|created_at)\b/);
      // One assignment per statement — no comma-separated second column.
      expect(s.split(",")).toHaveLength(1);
    }
  });

  it("there is NO generic arbitrary-column patch command", () => {
    // An update_practitioner(jsonb) would rebuild the vulnerability behind a
    // function name.
    expect(CODE_FLAT).not.toMatch(/function public\.(update|patch|set)_practitioner\b/i);
    expect(CODE_FLAT).not.toMatch(/jsonb/i);
    expect(CODE_FLAT).not.toMatch(/execute format/i);
    expect(CODE_FLAT).not.toMatch(/quote_ident/i);
  });

  it("preserves the product's own validation contracts", () => {
    expect(CODE).toMatch(/name is required/i); // blank display name refused
    expect(CODE).toMatch(/\^\[a-f0-9\]\{64\}\$/); // hash-only at rest
    expect(CODE).toMatch(/Inactive practitioners cannot manage feeds/); // feed active gate
  });

  it("the feed commands gate on active; the name/color commands deliberately do not", () => {
    // Preserving the pre-0178 contract exactly: only the FEED actions checked
    // `practitioner.active`. Broadening it would remove a capability.
    const bodies = Object.fromEntries(
      CODE.split("create or replace function public.")
        .slice(1)
        .map((b) => [b.slice(0, b.indexOf("(")), b]),
    );
    expect(bodies["rotate_own_calendar_feed_token"]).toMatch(/v_active is not true/);
    expect(bodies["clear_own_calendar_feed_token"]).toMatch(/v_active is not true/);
    expect(bodies["set_own_practitioner_display_name"]).not.toMatch(/v_active/);
    expect(bodies["set_own_practitioner_color"]).not.toMatch(/v_active/);
  });
});

describe("0178 — EXECUTE grants are exact", () => {
  it("revokes EXECUTE from public, anon AND service_role for every command", () => {
    // Supabase grants EXECUTE to all three at create time; missing one is the
    // 0129 (anon) and 0164 (service_role) mistake.
    for (const fn of COMMANDS) {
      expect(CODE, fn).toMatch(
        new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\)\\s+from public, anon, service_role;`),
      );
    }
  });

  it("grants EXECUTE ONLY to authenticated, for exactly those four", () => {
    const grants = [...CODE.matchAll(/grant execute on function public\.(\w+)\([^)]*\)\s+to (\w+);/g)];
    expect(grants).toHaveLength(4);
    for (const g of grants) {
      expect(COMMANDS).toContain(g[1] as (typeof COMMANDS)[number]);
      expect(g[2]).toBe("authenticated");
    }
  });

  it("every command carries a comment documenting its contract", () => {
    for (const fn of COMMANDS) {
      expect(CODE, fn).toMatch(new RegExp(`comment on function public\\.${fn}\\(`));
    }
  });
});

describe("0178 — scope: nothing else is touched", () => {
  it("names no appointment object — B3/0172 and B4/0173 are untouched", () => {
    expect(CODE_FLAT).not.toMatch(/appointment/i);
  });

  it("changes no other table, trigger, constraint, column or index", () => {
    for (const forbidden of [
      /create table/i,
      /alter table/i,
      /drop table/i,
      /create trigger/i,
      /drop trigger/i,
      /create index/i,
      /drop index/i,
      /add constraint/i,
      /drop constraint/i,
      /owner to/i,
      /create extension/i,
    ]) {
      expect(CODE_FLAT, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("writes, deletes or repairs no row", () => {
    for (const forbidden of [/\binsert into\b/i, /\bdelete from\b/i, /\btruncate table\b/i]) {
      expect(CODE_FLAT, String(forbidden)).not.toMatch(forbidden);
    }
    // The only UPDATEs are the four inside the command bodies.
    expect((CODE.match(/update public\./g) ?? []).length).toBe(4);
  });

  it("touches no other table's RLS or grants", () => {
    const tables = [...CODE.matchAll(/public\.(\w+)/g)].map((m) => m[1]);
    const nonFn = tables.filter((t) => !COMMANDS.includes(t as (typeof COMMANDS)[number]));
    expect([...new Set(nonFn)]).toEqual(["practitioners"]);
  });
});

describe("0178 — transaction and lock discipline", () => {
  it("opens its OWN transaction with lock_timeout armed INSIDE it", () => {
    const lines = CODE.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines[0]).toBe("begin;");
    expect(lines[lines.length - 1]).toBe("commit;");
    const lock = lines.findIndex((l) => /^set local lock_timeout\s*=\s*'5s';$/.test(l));
    expect(lock).toBeGreaterThan(0);
    expect(STATEMENTS.filter((s) => s === "begin")).toHaveLength(1);
    expect(STATEMENTS.filter((s) => s === "commit")).toHaveLength(1);
  });
});

describe("0178 — the doctrine the file must carry", () => {
  it("records that the finding was REVALIDATED, not inherited from the audit", () => {
    expect(PROSE).toMatch(/REVALIDATED AT PRODUCTION/i);
    expect(PROSE).toMatch(/UPDATE 1/);
  });

  it("records what the audit got WRONG about DELETE", () => {
    // 0173 already closed it; claiming otherwise would misinform the next reader.
    expect(PROSE).toMatch(/0173/);
    expect(PROSE).toMatch(/NO LONGER TRUE/i);
  });

  it("records the clinical-note FK as DEFERRED, with its reason", () => {
    expect(PROSE).toMatch(/client_clinical_notes/);
    expect(PROSE).toMatch(/DEFERRED/i);
  });

  it("records that SELECT is preserved and why", () => {
    expect(PROSE).toMatch(/SELECT/);
    expect(PROSE).toMatch(/read sites/i);
  });

  it("records the non-owner silent-failure this also fixes", () => {
    expect(PROSE).toMatch(/UPDATE 0/);
  });
});

describe("0178 — production truth is NOT advanced by this PR", () => {
  it("the canonical hosted record still reads 0173 — 0178 is UNAPPLIED", () => {
    const rec = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "docs/production/migration-state.json"), "utf8"),
    );
    expect(rec.hosted_migration_max).toBe("0173");
  });
});
