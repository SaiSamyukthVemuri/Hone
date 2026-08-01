import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { SERVICE_COLOR_KEYS, SERVICE_COLOR_KEYS_0153 } from "@/lib/calendar/service-colors";

// Migration 0161 — deterministic service ordering + a wider, separable colour set.
//
// This test carries the REPO migration-max pin (it moved off the 0160 test when
// 0161 landed). 0161 was APPLIED to production 2026-07-30T23:38:07Z→23:38:16Z:
// repo max and hosted max are both 0161, and the file is now IMMUTABLE.

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0161_")) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");
const FLAT = SQL.replace(/\s+/g, " ");
// PROSE view: comment markers stripped, so a rationale sentence that wraps
// across lines still reads as one sentence.
const PROSE = SQL.replace(/^\s*--\s?/gm, "").replace(/\s+/g, " ");
// CODE view: comments removed entirely, so a rationale that NAMES a forbidden
// construct cannot be mistaken for the construct itself.
const CODE = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");
const CODE_FLAT = CODE.replace(/\s+/g, " ");

// Statement-level view for the transaction assertions.
const statements = CODE.split(";")
  .map((s) => s.trim())
  .filter(Boolean);

// NOTE: the REPO migration-max tripwire has MOVED to the 0162 test, following
// the house convention that it always lives with the NEWEST migration's test
// (it moved off 0160 when 0161 landed, and off 0161 when 0162 landed).
// 0161 keeps its own ordinal + frozen-checksum protections, because it is
// APPLIED in production and must never be edited.
describe("0161 — service order + colours (applied, checksum frozen)", () => {
  it("is present, 0160 precedes it, and there is exactly one 0161", () => {
    expect(FILE).toMatch(/^0161_.*\.sql$/);
    const files = readdirSync(MIG_DIR);
    expect(files.some((f) => f.startsWith("0160_"))).toBe(true);
    expect(files.filter((f) => /^0161_/.test(f))).toHaveLength(1);
    const nums = files
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .map((f) => parseInt(f.slice(0, 4), 10))
      .sort((a, b) => a - b);
    // 0161 is no longer the max — 0162 is — but the chain must stay dense and
    // duplicate-free, and 0161 must still be in it.
    expect(nums).toContain(161);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it("is APPLIED in production, so its checksum is frozen", () => {
    // An applied migration must never be edited — its recorded checksum has to
    // keep describing the file on disk. Behaviour changes need a new migration
    // (0162). This is the same protection 0159 and 0160 carry.
    expect(
      createHash("sha256").update(SQL).digest("hex"),
      "0161 is APPLIED in production with this checksum. Never edit an applied " +
        "migration — write a new one (0162).",
    ).toBe("e2a3e4a770c79799042b542d9f2fcbdc13d2a9f1e30774221c1777ccbae33a46");
    const ledger = readFileSync(join(process.cwd(), "docs/production/migration-ledger.md"), "utf8");
    expect(ledger, "the ledger must carry 0161's COMPLETE sha256").toContain("e2a3e4a770c79799042b542d9f2fcbdc13d2a9f1e30774221c1777ccbae33a46");
    expect(ledger, "the ledger must record 0161 as applied").toMatch(/0161[\s\S]{0,240}APPLIED 2026-07-30/);
  });

  it("declares its dependencies and its migration-max transition", () => {
    expect(PROSE).toMatch(/DEPENDS ON: 0021[\s\S]{0,60}0153/i);
    expect(PROSE).toMatch(/Migration max 0160 -> 0161/i);
  });
});

describe("transaction + lock safety (the 0159/0160 lesson)", () => {
  it("opens and closes exactly one explicit transaction", () => {
    expect(statements.filter((s) => s.toLowerCase() === "begin")).toHaveLength(1);
    expect(statements.filter((s) => s.toLowerCase() === "commit")).toHaveLength(1);
    expect(statements.filter((s) => /^rollback/i.test(s))).toEqual([]);
  });

  it("arms a SET LOCAL lock_timeout INSIDE that transaction", () => {
    const beginAt = SQL.indexOf("\nbegin;");
    const lockAt = SQL.indexOf("set local lock_timeout");
    const commitAt = SQL.lastIndexOf("\ncommit;");
    expect(beginAt).toBeGreaterThan(-1);
    expect(lockAt).toBeGreaterThan(beginAt);
    expect(commitAt).toBeGreaterThan(lockAt);
    expect(SQL).toMatch(/set local lock_timeout = '5s'/);
  });

  it("never uses a session-global SET lock_timeout", () => {
    // A global SET would leak a modified lock_timeout into the pooled connection
    // that runs the NEXT migration.
    expect(statements.filter((s) => /^set\s+lock_timeout/i.test(s))).toEqual([]);
  });

  it("uses no transaction-forbidden statement", () => {
    expect(CODE).not.toMatch(/create\s+index\s+concurrently/i);
    expect(CODE).not.toMatch(/alter\s+type[\s\S]{0,40}add\s+value/i);
    expect(CODE).not.toMatch(/\bvacuum\b/i);
  });

  it("explains WHY it opens its own transaction (so the lesson is not re-lost)", () => {
    expect(PROSE).toMatch(/does NOT wrap a migration file in an explicit transaction/i);
    expect(PROSE).toMatch(/25P01/);
  });
});

describe("no business-row rewrite at apply time", () => {
  it("contains no UPDATE or DELETE against services outside the RPC bodies", () => {
    // Every UPDATE in the file must be inside a function body ($$ … $$), i.e.
    // executed only when an owner taps a move control — never at apply time.
    const bodies = SQL.split("$$");
    // Odd indices are function bodies; even indices are top-level SQL.
    const topLevel = bodies.filter((_, i) => i % 2 === 0).join("\n");
    expect(topLevel).not.toMatch(/^\s*update\s+public\./im);
    expect(topLevel).not.toMatch(/^\s*delete\s+from\s+public\./im);
    expect(topLevel).not.toMatch(/^\s*insert\s+into\s+public\./im);
  });

  it("does not add a uniqueness constraint on sort_order", () => {
    // Deliberate: hidden services keep stale values, and a hard constraint would
    // make an un-hide FAIL rather than re-slot. The RPC normalizes instead.
    expect(CODE).not.toMatch(/unique[\s\S]{0,40}sort_order/i);
  });
});

describe("the atomic reorder RPC", () => {
  const body = SQL.slice(
    SQL.indexOf("create or replace function public.reorder_studio_service"),
    SQL.indexOf("comment on function public.reorder_studio_service"),
  );

  it("is SECURITY DEFINER with a pinned search_path", () => {
    expect(body).toMatch(/security definer/);
    expect(body).toMatch(/set search_path = pg_catalog, pg_temp/);
  });

  it("is OWNER-authorized, not merely member-authorized", () => {
    expect(body).toMatch(/if not public\.is_studio_owner\(p_studio_id\)/);
    expect(body).toMatch(/errcode = '42501'/);
  });

  it("orders by the TOTAL key (sort_order, name, id) — the fix for the tie", () => {
    expect(body).toMatch(/order by sort_order asc, name asc, id asc/);
  });

  it("locks the studio's visible services for the transaction", () => {
    expect(body).toMatch(/for update/);
  });

  it("supports all four moves plus a pure normalize, and rejects anything else", () => {
    expect(body).toMatch(/p_move not in \('top', 'up', 'down', 'bottom', 'none'\)/);
    expect(body).toMatch(/when 'top'\s+then 1/);
    expect(body).toMatch(/when 'bottom' then v_len/);
    // 'none' normalizes WITHOUT moving — how show_studio_service stays
    // idempotent when the service was already visible.
    expect(body).toMatch(/when 'none'\s+then v_idx/);
  });

  it("normalizes to 10, 20, 30 … in ONE pass", () => {
    expect(body).toMatch(/sort_order = i \* 10/);
    expect(body).toMatch(/sort_order is distinct from i \* 10/);
  });

  it("carries an optimistic-concurrency token that refuses a stale move", () => {
    expect(body).toMatch(/p_expected_position is not null and p_expected_position <> \(v_idx - 1\)/);
    expect(body).toMatch(/errcode = '40001'/);
  });

  it("is scoped to the caller's studio on every write", () => {
    const updates = body.match(/update public\.services[\s\S]*?;/g) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u).toMatch(/studio_id = p_studio_id/);
  });

  it("is revoked from anon and granted only to authenticated + service_role", () => {
    expect(FLAT).toMatch(
      /revoke all on function public\.reorder_studio_service\(uuid, uuid, text, integer\) from public, anon/,
    );
    expect(FLAT).toMatch(
      /grant execute on function public\.reorder_studio_service\(uuid, uuid, text, integer\) to authenticated, service_role/,
    );
  });
});

describe("the show helper closes the un-hide collision", () => {
  it("re-slots a re-shown service at the end and renormalizes, owner-only", () => {
    const body = SQL.slice(
      SQL.indexOf("create or replace function public.show_studio_service"),
      SQL.indexOf("comment on function public.show_studio_service"),
    );
    expect(body).toMatch(/if not public\.is_studio_owner\(p_studio_id\)/);
    expect(body).toMatch(/sort_order = v_max \+ 10/);
    expect(body).toMatch(/reorder_studio_service\(p_studio_id, p_service_id, 'bottom'\)/);
    // IDEMPOTENT: the re-slot UPDATE only fires for a row that was actually
    // hidden. Without this predicate, a stale tab re-submitting "Show" silently
    // moved an already-visible service to the BOTTOM of the menu.
    expect(body).toMatch(/and active = false;/);
    expect(body).toMatch(/reorder_studio_service\(p_studio_id, p_service_id, 'none'\)/);
    expect(FLAT).toMatch(
      /revoke all on function public\.show_studio_service\(uuid, uuid\) from public, anon/,
    );
  });
});

describe("the colour CHECK is WIDENED, never narrowed", () => {
  const NEW_KEYS = ["orange", "lime", "fuchsia", "slate"];

  it("keeps every 0153 key legal", () => {
    for (const key of SERVICE_COLOR_KEYS_0153) {
      expect(FLAT, `${key} must remain allowed`).toContain(`'${key}'`);
    }
  });

  it("adds exactly the four chosen families", () => {
    for (const key of NEW_KEYS) expect(FLAT).toContain(`'${key}'`);
  });

  it("the DB allowlist and the app allowlist are the same ten keys", () => {
    const start = CODE_FLAT.indexOf("check (calendar_color in (");
    const check = CODE_FLAT.slice(start, CODE_FLAT.indexOf("))", start));
    const inSql = [...check.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(new Set(inSql)).toEqual(new Set(SERVICE_COLOR_KEYS));
    expect(inSql).toHaveLength(SERVICE_COLOR_KEYS.length);
  });

  it("NEVER allows red, rose or pink — reserved for allergy / clinical cautions", () => {
    const start = CODE_FLAT.indexOf("check (calendar_color in (");
    const check = CODE_FLAT.slice(start, CODE_FLAT.indexOf("))", start));
    for (const banned of ["'red'", "'rose'", "'pink'"]) {
      expect(check, `${banned} must not be allowed`).not.toContain(banned);
    }
    expect(PROSE).toMatch(/red, rose[\s\S]{0,40}RESERVED, permanently, for allergies/i);
  });

  it("avoids the crowded blue band Chloe reported as unreadable", () => {
    const start = CODE_FLAT.indexOf("check (calendar_color in (");
    const check = CODE_FLAT.slice(start, CODE_FLAT.indexOf("))", start));
    expect(check).not.toContain("'blue'");
    expect(check).not.toContain("'cyan'");
  });

  it("swaps the constraint with NOT VALID + VALIDATE (short ACCESS EXCLUSIVE hold)", () => {
    expect(CODE_FLAT).toMatch(/add constraint services_calendar_color_allowed[\s\S]*?not valid/i);
    expect(CODE_FLAT).toMatch(/validate constraint services_calendar_color_allowed/i);
  });
});

describe("migration-first mixed-version safety is stated and true", () => {
  it("documents why applying before the deploy is safe in both directions", () => {
    expect(PROSE).toMatch(/MIGRATION-FIRST MIXED-VERSION SAFETY/i);
    expect(PROSE).toMatch(/currently deployed app never calls `reorder_studio_service`/i);
    expect(PROSE).toMatch(/only WIDENED/i);
  });

  it("carries a rollback section that is honest about the colour caveat", () => {
    expect(PROSE).toMatch(/ROLLBACK/);
    expect(PROSE).toMatch(/narrow rollback FAILS if any service has already been saved/i);
  });

  it("carries read-only operator verification", () => {
    expect(PROSE).toMatch(/Operator verification \(READ-ONLY; run after apply\)/i);
    expect(PROSE).toMatch(/has_function_privilege\('anon'/);
  });
});
