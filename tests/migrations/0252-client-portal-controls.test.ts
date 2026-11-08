import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0252 — HON-47 studio client portal access control. SOURCE
// CONTRACT.
//
// Behaviour (the default, owner-only persistence through RLS, the 23514 guard
// on both credential tables, the revoked EXECUTE, independence from 0204's
// admission mode and from 0234's two flags) is proved against a real database
// in tests/db/client-portal-controls.db.test.ts. This file pins what that
// test cannot see: the file is the reviewed draft byte for byte, it carries its
// own transaction and lock timeout, it writes no data, its one routine is
// revoked from all three API roles by name (0129/0164), and it references no
// column from 0234, so it applies with or without it.
// ===========================================================================

const VERSION = "0252";
const FILE = `${VERSION}_client_portal_controls.sql`;
const SQL = readFileSync(path.join(process.cwd(), "supabase/migrations", FILE), "utf8");
// LINE comments first: a comment must never satisfy a code assertion.
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
// String literals blanked too, for the "references" checks: the column COMMENT
// names 0234's flags in prose, which is documentation, not a dependency.
const CODE_NO_STRINGS = CODE.replace(/'(?:[^']|'')*'/g, "''");

describe(`${VERSION} is allocated correctly in the migration sequence`, () => {
  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("is no longer the repository maximum: newer migrations sit above it", () => {
    // Only the CURRENT maximum migration's own test may assert isRepoMax (CLAUDE.md
    // section 2). 0252 is numbered below migrations that already exist, so the
    // tripwire is derived, not pinned.
    expect(isRepoMax(VERSION)).toBe(false);
    const above = versionsAbove(VERSION);
    expect(above.length, "nothing sits above 0252").toBeGreaterThan(0);
    expect(above.every((v) => Number(v) > Number(VERSION))).toBe(true);
  });
});

describe(`${VERSION} is the reviewed draft`, () => {
  it("is byte-identical to willow/HON-47-DRAFT-client-portal-controls.sql", () => {
    expect(createHash("sha256").update(SQL, "utf8").digest("hex")).toBe(
      "d83df9aa30910d28597e218247aa081a999d2c57a1781a3fb66d1dabf971c4da",
    );
  });
});

describe(`${VERSION} leaves every applied migration it relies on untouched`, () => {
  // studios and its "studios: owners update" policy (0001); the two portal
  // credential tables and their studio_id NOT NULL (0052).
  const APPLIED: ReadonlyArray<readonly [string, string]> = [
    ["0001_init.sql", "34994656f9f1062d9c220492971d3adcce9b2437e096c353d9dd6ba33aeb2b2a"],
    ["0052_client_portal_foundation.sql", "390d8f2aa71f93bf84cc95dedc529a1b6878a6dc472336a16a48d4992e52a1cc"],
  ];
  it.each(APPLIED)("%s is unchanged", (file, sha) => {
    const body = readFileSync(path.join(process.cwd(), "supabase/migrations", file), "utf8");
    expect(createHash("sha256").update(body, "utf8").digest("hex")).toBe(sha);
  });
});

describe(`${VERSION} is one transaction that arms its own lock timeout`, () => {
  it("opens with begin; and ends with commit;", () => {
    expect(CODE.match(/^begin;\s*$/gm)).toHaveLength(1);
    expect(CODE.match(/^commit;\s*$/gm)).toHaveLength(1);
    expect(CODE.trim().endsWith("commit;")).toBe(true);
  });

  it("sets lock_timeout INSIDE the transaction (a bare SET LOCAL never arms: 25P01)", () => {
    const begin = CODE.indexOf("begin;");
    const timeout = CODE.indexOf("set local lock_timeout");
    expect(timeout).toBeGreaterThan(begin);
  });
});

describe(`${VERSION} is additive and writes no data`, () => {
  it("adds exactly one studios column, idempotently, NOT NULL DEFAULT TRUE", () => {
    const adds = [...CODE.matchAll(/add column if not exists (\w+)/g)].map((m) => m[1]);
    expect(adds).toEqual(["client_portal_enabled"]);
    expect(CODE).toMatch(/add column if not exists client_portal_enabled boolean not null default true;/);
    expect(CODE).not.toMatch(/alter table (?!public\.studios)/);
  });

  it("drops, renames, rewrites and deletes nothing at top level", () => {
    expect(CODE).not.toMatch(/\bdrop\s+(table|column|constraint|policy|function)\b/i);
    expect(CODE).not.toMatch(/\brename\b/i);
    expect(CODE).not.toMatch(/alter\s+column/i);
    expect(CODE).not.toMatch(/^\s*(update|delete|insert)\b/im);
  });

  it("references no 0234 column and does not read new_client_admission_mode", () => {
    expect(CODE_NO_STRINGS).not.toMatch(/client_cancellation_enabled|client_reschedule_enabled/);
    expect(CODE_NO_STRINGS).not.toMatch(/new_client_admission_mode/);
  });
});

describe(`${VERSION}'s guard is the only routine, and no API role can call it`, () => {
  it("creates exactly one function, SECURITY DEFINER with a pinned search_path", () => {
    expect(CODE.match(/create\s+(or\s+replace\s+)?function\b/gi)).toHaveLength(1);
    expect(CODE).toMatch(/create or replace function public\.client_portal_access_guard\(\)/);
    expect(CODE).toMatch(/security definer\s+set search_path = pg_catalog, public, pg_temp/);
    expect(CODE).not.toMatch(/create\s+(or\s+replace\s+)?(procedure|view|policy)\b/i);
  });

  it("refuses only when the studio's flag is FALSE, with check_violation", () => {
    expect(CODE).toContain("coalesce(s.client_portal_enabled, true)");
    expect(CODE).toContain("if v_enabled is false then");
    expect(CODE).toContain("errcode = 'check_violation'");
  });

  it("guards BEFORE INSERT on exactly the two credential tables", () => {
    const triggers = [...CODE.matchAll(/before insert on public\.(\w+)/g)].map((m) => m[1]);
    expect(triggers).toEqual(["client_portal_magic_links", "client_portal_sessions"]);
    expect(CODE.match(/execute function public\.client_portal_access_guard\(\);/g)).toHaveLength(2);
  });

  it("revokes from public, anon, authenticated AND service_role by name, and grants nothing", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(`revoke all on function public.client_portal_access_guard() from ${role};`);
    }
    expect(CODE).not.toMatch(/\bgrant\b/i);
  });
});

describe(`${VERSION} applies on the hosted shape`, () => {
  // Hosted applied 0248 out of order with 0247 and the 0249+ drafts absent, and 0252 may be
  // applied before or after any of them. So everything it touches must come from migrations
  // that are not part of that governed range.
  const DIR = path.join(process.cwd(), "supabase/migrations");
  const FILES = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const creator = (table: string): string | undefined =>
    FILES.find((f) =>
      new RegExp(`create table (if not exists )?public\\.${table}\\b`, "i").test(readFileSync(path.join(DIR, f), "utf8")),
    );

  it.each(["studios", "client_portal_magic_links", "client_portal_sessions"])(
    "%s is created below the governed 0247+ range, so 0252 needs none of it",
    (table) => {
      const f = creator(table);
      expect(f, `${table} is created by no migration`).toBeDefined();
      expect(Number((f as string).slice(0, 4))).toBeLessThan(247);
    },
  );

  it("names no object created by a migration at or above 0247", () => {
    const newer = FILES.filter((f) => Number(f.slice(0, 4)) >= 247 && !f.startsWith(VERSION));
    const created = new Set<string>();
    for (const f of newer) {
      for (const m of readFileSync(path.join(DIR, f), "utf8").matchAll(/create (?:or replace )?(?:table|function)(?: if not exists)? public\.(\w+)/gi)) created.add(m[1]);
    }
    const mine = new Set([...CODE_NO_STRINGS.matchAll(/public\.(\w+)/g)].map((m) => m[1]));
    mine.delete("client_portal_access_guard"); // this file's own function
    const clash = [...mine].filter((n) => created.has(n));
    expect(clash).toEqual([]);
  });
});
