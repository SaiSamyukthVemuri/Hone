import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0205 — a NEW studio is born with its admission authority already
// initialized.
//
// THE REGRESSION THIS CLOSES. 0204 gave `new_client_admission_mode` a correct
// `not null default 'open'` but left `new_client_admission_mode_set_at` with no
// default, while simultaneously reading `set_at IS NULL` as the authoritative
// marker for an UNSTAMPED PRE-0204 LEGACY row. A studio created after 0204 was
// therefore born `open` / NULL — indistinguishable from a legacy row — and its
// brand-new owner was told `legacy_waitlist_cutover_required` on selecting Open
// or Closed.
//
// WHAT THIS FILE PROVES, AND WHAT IT DELIBERATELY DOES NOT.
//
// This is the SOURCE CONTRACT: it reads the migration text and asserts the
// shape of the change — one default, two comments, no DML, no logic edit. It
// cannot prove behaviour, because SQL text is not a running database. The
// behavioural claims (a fresh insert is stamped, a fresh owner may choose any
// mode immediately, a legacy row still cannot) are proved against a real
// database in tests/db/new-studio-admission-default.db.test.ts, and the
// resolution claim in tests/lib/booking/new-client-admission.test.ts.
//
// The division matters: an earlier instinct was to assert the behaviour here by
// grepping for the words. A grep that "proves" an INSERT is stamped is a grep
// that stays green when the default is removed from a column it never read.
// ===========================================================================

const VERSION = "0205";
const FILE = "0205_new_studio_admission_default.sql";
const SQL = readFileSync(
  path.join(process.cwd(), "supabase/migrations", FILE),
  "utf8",
);

/** The file with every `--` comment line removed, so prose cannot satisfy a claim. */
const CODE = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("0205 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this — see
    // CLAUDE.md §2. The "nothing above me" tripwire is served centrally for
    // every older migration, which is why none of them repeats it.
    expect(isRepoMax(VERSION), "0205 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION), "something was added above 0205").toEqual([]);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("opens its own transaction with a lock timeout", () => {
    // `supabase db push` does NOT wrap a file in a transaction, so a bare
    // `SET LOCAL` emits 25P01 and never arms. See CLAUDE.md §5.
    expect(CODE).toMatch(/^begin;/m);
    expect(CODE).toMatch(/^commit;/m);
    expect(CODE).toMatch(/set local lock_timeout = '5s';/);
    expect(CODE.indexOf("begin;")).toBeLessThan(CODE.indexOf("set local lock_timeout"));
  });
});

describe("the fix is ONE default on the column that was missing one", () => {
  it("sets a default on new_client_admission_mode_set_at", () => {
    expect(CODE).toMatch(
      /alter table public\.studios\s+alter column new_client_admission_mode_set_at set default now\(\)/,
    );
  });

  it("uses now(), the same default public.studios.created_at already carries", () => {
    // So a studio's creation instant and its admission-initialization instant
    // are ONE transaction timestamp rather than two that merely look alike.
    expect(CODE).toMatch(/set default now\(\)/);
    expect(CODE, "a literal or a non-database clock would drift from created_at").not.toMatch(
      /set default '[^']*'::timestamptz/,
    );
  });

  it("does NOT restate the two defaults that are already correct", () => {
    // `mode` already defaults 'open' from 0204 and `set_by` already has none.
    // Re-asserting them would add statements to a production apply for no
    // behavioural change. The full three-column shape is asserted by the DB
    // test instead, which is where it is actually observable.
    expect(CODE).not.toMatch(/alter column new_client_admission_mode set default/);
    expect(CODE).not.toMatch(/alter column new_client_admission_mode_set_by set default/);
  });
});

describe("it CANNOT backfill, and that is the point", () => {
  it("uses ALTER COLUMN SET DEFAULT, which never rewrites an existing row", () => {
    // The distinction is load-bearing. `ADD COLUMN ... DEFAULT` populates
    // existing rows in PostgreSQL 11+; `ALTER COLUMN ... SET DEFAULT` records a
    // default for FUTURE inserts only. Pre-fix studios must keep set_at NULL and
    // keep their legacy semantics.
    expect(CODE).toMatch(/alter column new_client_admission_mode_set_at set default/);
    expect(CODE).not.toMatch(/add column[^;]*new_client_admission_mode_set_at/);
  });

  it("contains ZERO data manipulation of any kind", () => {
    // The production census found no studio created after the 0204 apply
    // boundary, so there was nothing to repair. A migration that repairs
    // nothing must contain no repair.
    for (const verb of [/\binsert\s+into\b/i, /\bupdate\s+public\./i, /\bdelete\s+from\b/i, /\btruncate\b/i]) {
      expect(CODE, `0205 must carry no DML; found ${verb}`).not.toMatch(verb);
    }
  });

  it("arms no admission permit, because it writes no admission field", () => {
    // The row-scoped permit exists for UPDATEs. With no UPDATE there is nothing
    // to permit, and setting one would be the global bypass the guard forbids.
    expect(CODE).not.toMatch(/hone\.admission_mode_studio_id/);
    expect(CODE).not.toMatch(/set_config/);
  });
});

describe("it does not touch the legacy transition guard", () => {
  it("redefines no function and no trigger", () => {
    // The whole fix is that `set_at IS NULL` keeps meaning exactly what it
    // meant; a new row simply is not null any more. Nothing about the rule
    // changes, so nothing about the rule is rewritten.
    expect(CODE).not.toMatch(/create or replace function/i);
    expect(CODE).not.toMatch(/create trigger/i);
    expect(CODE).not.toMatch(/drop trigger/i);
  });

  it("never mentions the legacy refusal, let alone relaxes it", () => {
    expect(CODE).not.toMatch(/legacy_waitlist_cutover_required/);
  });

  it("alters only `studios`", () => {
    const altered = [...CODE.matchAll(/alter table (?:if exists )?(\S+)/gi)].map((m) =>
      m[1].replace(/;$/, ""),
    );
    expect(altered.length).toBeGreaterThan(0);
    expect([...new Set(altered)]).toEqual(["public.studios"]);
  });

  it("adds no column, index, constraint or grant", () => {
    for (const verb of [/\badd column\b/i, /create (unique )?index/i, /\badd constraint\b/i, /^\s*grant /im, /^\s*revoke /im]) {
      expect(CODE, `0205 is a default + comments only; found ${verb}`).not.toMatch(verb);
    }
  });
});

describe("the comments stop defining non-null set_at as an owner's choice", () => {
  it("rewrites both column comments forward, because 0204 is frozen", () => {
    const comments = [...SQL.matchAll(/comment on column public\.studios\.(\w+) is/g)].map(
      (m) => m[1],
    );
    expect(new Set(comments)).toEqual(
      new Set(["new_client_admission_mode_set_at", "new_client_admission_mode_set_by"]),
    );
  });

  it("set_at's comment says INITIALIZED, and names set_by as the discriminator", () => {
    const c = /comment on column public\.studios\.new_client_admission_mode_set_at is([\s\S]*?);/.exec(
      SQL,
    );
    expect(c, "set_at has no comment").toBeTruthy();
    const body = c![1];
    expect(body).toMatch(/initialized/i);
    expect(body).toMatch(/new_client_admission_mode_set_by/);
    // And it must NOT still claim non-null means an owner chose.
    expect(body).not.toMatch(/no owner has\s+'?\s*'?chosen a mode/i);
  });

  it("set_by's comment distinguishes system initialization from an owner change", () => {
    const c = /comment on column public\.studios\.new_client_admission_mode_set_by is([\s\S]*?);/.exec(
      SQL,
    );
    expect(c, "set_by has no comment").toBeTruthy();
    const body = c![1];
    expect(body).toMatch(/system-initialized|system initialization/i);
    expect(body).toMatch(/predates 0204|set_at NULL/i);
  });

  it("keeps the reason there is no foreign key on set_by", () => {
    // 0204 recorded it after CI run 36729106946: a second
    // studios<->practitioners relationship breaks the PostgREST embed. Replacing
    // the comment must not drop the lesson.
    const c = /comment on column public\.studios\.new_client_admission_mode_set_by is([\s\S]*?);/.exec(
      SQL,
    );
    expect(c![1]).toMatch(/PostgREST embed ambiguous|NOT a foreign key/i);
  });
});
