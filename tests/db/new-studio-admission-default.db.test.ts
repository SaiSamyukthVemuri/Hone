import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  adminQuery,
  adminTx,
  asUser,
  seedStudio,
  type SeededStudio,
} from "@/tests/db/helpers/harness";

// ===========================================================================
// Migration 0205 — a NEW studio is born with its admission authority already
// initialized.
//
// THE REGRESSION. 0204 defaulted `new_client_admission_mode` to 'open' but left
// `new_client_admission_mode_set_at` with no default, while reading
// `set_at IS NULL` as the marker for an UNSTAMPED PRE-0204 LEGACY row. A studio
// created after 0204 was therefore born open/NULL, indistinguishable from a
// legacy row, and `set_new_client_admission_mode` answered
// `legacy_waitlist_cutover_required` when its brand-new owner selected Open or
// Closed. The owner was told to "choose Waitlist first" — a cutover ceremony
// that belongs only to studios that really did predate 0204.
//
// WHY THESE ASSERTIONS LIVE AGAINST A REAL DATABASE. The fix is a column
// DEFAULT, and a default is only observable on an actual INSERT. The source
// contract in tests/migrations/0205-new-studio-admission-default.test.ts proves
// the SHAPE of the migration — one default, two comments, and TWO
// `update public.studios` statements per candidate: the unpermitted guard PROBE
// and the permitted REPAIR — and deliberately proves nothing about behaviour,
// because SQL text is not a running database. This file is the other half, and
// it is where the repair's actual effect on rows is established.
//
// THE DEFAULT IS EXERCISED, NOT DESCRIBED. `seedStudio` inserts
// `(id, name, owner_email)` and names no admission field at all, which is
// exactly what the admin studio wizard does
// (app/admin/studios/new/actions.ts). So every seeded studio here is a genuine
// "new studio created through the only insert path's column set", and the
// assertions read what the database chose on its own.
// ===========================================================================

/** A studio inserted the way the product inserts one: no admission field named. */
async function insertBareStudio(label: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.studios (id, name, owner_email) values ($1, $2, $3)`,
    [id, `Bare ${label}`, `bare-${id.slice(0, 8)}@harness.local`],
  );
  return id;
}

async function admissionRow(studioId: string) {
  const { rows } = await adminQuery(
    `select new_client_admission_mode              as mode,
            new_client_admission_mode_set_at       as set_at,
            new_client_admission_mode_set_by       as set_by,
            created_at
       from public.studios
      where id = $1`,
    [studioId],
  );
  return rows[0] as {
    mode: string;
    set_at: Date | null;
    set_by: string | null;
    created_at: Date;
  };
}

describe("0205: a studio created now is SYSTEM-INITIALIZED, not legacy", () => {
  let studioId: string;

  beforeAll(async () => {
    studioId = await insertBareStudio("sysinit");
  });

  it("A. a bare insert yields mode=open, set_at NON-NULL, set_by NULL", async () => {
    const row = await admissionRow(studioId);
    expect(row.mode, "the product ruling is that a new studio starts OPEN").toBe("open");
    expect(row.set_at, "set_at must be stamped at creation by the 0205 default").not.toBeNull();
    expect(
      row.set_by,
      "set_by must stay NULL: the owner practitioner does not exist at insert time",
    ).toBeNull();
  });

  it("A2. the stamp comes from the DATABASE clock, in the insert's own transaction", async () => {
    // `now()` is transaction-start, and created_at carries the same default, so
    // the two are the SAME instant rather than two values that merely look
    // alike. A literal or an application-supplied timestamp would drift.
    const row = await admissionRow(studioId);
    expect(row.set_at!.getTime()).toBe(row.created_at.getTime());
  });

  it("the three fields together read as SYSTEM-INITIALIZED, the new middle state", async () => {
    // set_at NULL              -> never initialized (pre-0204 legacy)
    // set_at set, set_by NULL  -> initialized by the system at creation  <-- here
    // set_at set, set_by set   -> an owner changed it
    const row = await admissionRow(studioId);
    expect({ stamped: row.set_at !== null, ownerChanged: row.set_by !== null }).toEqual({
      stamped: true,
      ownerChanged: false,
    });
  });
});

describe("the shipped column comments are what the catalog actually holds", () => {
  // THE CATALOG IS THE ONLY AUTHORITY FOR THIS METADATA, and this suite is now
  // the only place it is checked. A source-contract test used to reconstruct
  // these two strings by parsing the migration file, and review defeated that
  // FOUR times running - a quoted phrase inside an SQL comment; a `';` inside a
  // comment terminating the statement early; statement-head discovery matching
  // a commented-out head; and NESTED block comments, which PostgreSQL supports
  // and a non-greedy `*/` does not. Each repair was beaten by the next finding,
  // because every one of them needed lexical context that was established too
  // late. Rather than write a fifth SQL parser, the reconstruction was DELETED.
  //
  // col_description() cannot be fooled by source layout at all: it returns what
  // the server stored after applying the migration. These two strings become
  // pg_description rows, so psql \d+ and every introspection tool read them
  // first, and set_by's used to present an unvalidated uuid as resolved audit
  // provenance.
  //
  // THIS ALSO FAILS IF 0205 GOES AWAY. With the migration absent the catalog
  // keeps 0204's text, which says "no owner has chosen a mode", never says
  // "initialized", and carries no INSERT disclaimer - so the positives and the
  // negative below both trip. Proven by mutation, not assumed.
  const description = async (column: string): Promise<string> => {
    const { rows } = await adminQuery(
      `select col_description(a.attrelid, a.attnum) as d
         from pg_attribute a
        where a.attrelid = 'public.studios'::regclass
          and a.attname = $1`,
      [column],
    );
    expect(rows.length, `${column} is not a column of public.studios`).toBe(1);
    const d = rows[0].d as string | null;
    expect(d, `${column} carries no catalog comment`).toBeTruthy();
    return d!;
  };

  // THE EXACT CATALOG VALUE, PINNED. The semantic assertions below are
  // ENUMERATIVE: each names one way the text has been wrong. Review showed that
  // is not the same as enforcing the invariant - "These are the only writers"
  // or "there are three writers" would be equally false and would satisfy every
  // pattern, because a pattern list can only recognise the phrasings someone
  // already thought of. That is the same instrument failure that defeated four
  // source parsers on this branch.
  //
  // So the complete check is equality against the approved value. ANY edit to
  // either comment fails here until the expectation is updated in the same
  // commit, which puts a reviewer in front of the new wording - the only
  // mechanism that has actually caught this defect, five times now.
  //
  // These strings are NOT derived from the migration file. Deriving them is
  // exactly the parsing that was deleted; this is an independent expectation
  // compared against what the server stored. To change a comment deliberately,
  // apply the migration locally and read the value back:
  //   select col_description(a.attrelid, a.attnum) from pg_attribute a
  //    where a.attrelid = 'public.studios'::regclass and a.attname = '<col>';
  const EXPECTED: Readonly<Record<string, string>> = {
    new_client_admission_mode_set_at: "When the persisted new-client admission authority was last initialized or changed. NON-NULL means the authority IS initialized - by the system at studio creation (0205 column default, new_client_admission_mode_set_by NULL), or by an owner choosing a mode through set_new_client_admission_mode (set_by non-null). Written by either of those product paths the value is the DATABASE clock. NULL means it was never initialized: a pre-0204 row still carrying 0204's backfill default, for which the legacy/unstamped transition rule applies - as it does to a row whose INSERT supplied NULL explicitly, which is possible for the reason given below. Read set_by to tell system initialization from an owner's change - this column alone no longer distinguishes them. NOT VALIDATED AT INSERT: public.studios has no INSERT trigger, so a direct INSERT may write any value in either column and nothing checks it. The guard polices UPDATE only, so this description covers the product paths named above - not an exhaustive account of what the column can hold.",
    new_client_admission_mode_set_by: "WHO set the mode. For a value written through set_new_client_admission_mode - which RESOLVES this value from auth.uid() rather than accepting one - this is the practitioner the DATABASE resolved from auth.uid() at that moment, never an id the browser supplied. NULL means no owner has changed the mode: either the row was system-initialized at studio creation (set_at non-null) or it predates 0204 entirely (set_at NULL), and set_at is what separates those two. NOT VALIDATED AT INSERT, AND THIS MATTERS FOR AUDIT: there is no foreign key and no INSERT trigger on public.studios, so a direct INSERT may write any uuid here - one identifying no practitioner, or a practitioner of another studio - and nothing refuses it. A non-null value is trustworthy provenance only for a row whose mode was set through that command; the scoped permit guard polices UPDATE, not creation. Deliberately NOT a foreign key: a second studios<->practitioners relationship would make the established practitioners -> studio:studios(*) PostgREST embed ambiguous. Integrity for owner changes comes from set_new_client_admission_mode plus that guard, not from a constraint, and the value outlives the practitioner row.",
  };

  // FOUR PHRASINGS OF ONE DEFECT, all withdrawn after review, pinned together
  // by MEANING rather than by whichever one I happen to remember. The class is
  // a quantified claim about writers, and it has come back in a new disguise
  // every time it was fixed: "cannot be anything but NULL", "the only writer
  // that sets it", "the only UPDATE the guard admits", "two writers, not one".
  // None may return to either comment, because both comments document an
  // INSERT that nothing guards.
  const MONOPOLY: readonly [RegExp, string][] = [
    [/cannot be anything but null/i, "calls the NULL structurally forced"],
    [/only writer that sets it/i, "claims a single-writer monopoly"],
    [/only update the guard admits/i, "claims a monopoly on admitted UPDATEs"],
    // No scoping exemption. An earlier version of this entry tried to allow
    // "two writers" when "product" followed it, which (a) rejected the equally
    // correct wording that puts the scope FIRST, and (b) kept alive the idea
    // that a count is fine if qualified. The ruling is no count claim at all,
    // so the catalog states paths, never a number.
    [/\btwo writers\b/i, "makes a writer-count claim at all"],
  ];

  const expectNoMonopoly = (column: string, d: string): void => {
    for (const [pattern, why] of MONOPOLY) {
      expect(d, `${column} ${why}: ${pattern}`).not.toMatch(pattern);
    }
  };

  // THE WHOLE COMMENT SURFACE OF public.studios, PINNED BY DIGEST.
  //
  // Two review passes converged on the same hole from opposite sides. The
  // denylist below recognises four remembered phrasings; the exact-value pins
  // cover two columns. So a false exhaustive claim could still ship by (a) using
  // wording nobody had imagined, or (b) landing on any OTHER column of this
  // table. Independent verification demonstrated both at once, passing 42/42
  // with this text on `public.studios.slug`:
  //
  //   "INJECTED FALSE CLAIM: public.set_new_client_admission_mode is the sole
  //    writer of this studio's admission authority, no other path can ever set
  //    those columns, and the guard admits exactly one UPDATE per studio. There
  //    are precisely three writers of studios rows ..."
  //
  // Every clause false, and it carries a writer count - the exact thing the
  // ruling bans. Review independently asked for the same fix: pin the inventory
  // rather than bless whatever the catalog happens to hold.
  //
  // So: the SET of commented columns is exact, and each one's text is pinned by
  // digest. Any addition, removal, reword or rewrite on this table fails here.
  // That is deliberate friction on a table that carries the admission authority
  // - a comment change here should meet a reviewer. The two columns 0205 owns
  // are ALSO pinned verbatim above, because those are the ones under scrutiny
  // and a digest diff is not readable.
  //
  // To change one deliberately, apply locally and read the digest back:
  //   select a.attname,
  //          encode(sha256(col_description(a.attrelid,a.attnum)::bytea),'hex')
  //     from pg_attribute a
  //    where a.attrelid = 'public.studios'::regclass and a.attnum > 0
  //      and col_description(a.attrelid, a.attnum) is not null order by 1;
  //
  // KNOWN FALSE, PINNED AS TRACKED DEBT rather than blessed: 0204's comment on
  // `new_client_admission_mode` claims "no role holds direct UPDATE on this
  // table", and verification measured anon, authenticated, service_role and
  // postgres all holding UPDATE on that column. Its guard function also raises
  // "new-client admission has exactly one writer" - the same banned count, on an
  // operator-visible surface. 0204 is applied and FROZEN, so both need a forward
  // migration with its own authorization and are raised separately. Pinning the
  // digest records the debt and stops it drifting further.
  const COMMENT_INVENTORY: Readonly<Record<string, string>> = {
    clinical_corrections_enabled:
      "3b8c4165432a7fd5927868371a95ecfa97371e7a72872ba00e82f8ff79156d93",
    clinical_finalization_enabled:
      "a2d9e5b5b61f58a366b26f995d73b1983a1be23dc204019b8ccee24c6ca75d2b",
    new_client_admission_mode:
      "5c1b48c3cc5f16135eb06e5467dc206210462bf397a73359e83c9a8ddf04ccc7",
    new_client_admission_mode_set_at:
      "29446438ca37fd699cb4236db723dff886af71ea7a9664f0f8fcf43ae657ff36",
    new_client_admission_mode_set_by:
      "513cea62d9707129b193abd53dd819ec7c61230a2542313b9bbd6f4c94a8c69e",
    postcare_delivery_mode:
      "d857913bed26e5c61ec91162bf59d1a8680edd88605ba179861df3bcf0e0af56",
    send_intake_reminders:
      "8b925c11f89dd93809b01711a25199fa3526ee61ac9ffeeb2c38d6fe5d616cf6",
    time_format_preference:
      "bb4f8a9f352072719fa9155f9301c0b59c5171de48e8913eedad7a70d65a8f0a",
  };

  it("public.studios carries NO table-level comment, so one cannot be added unnoticed", async () => {
    // Review's example was `COMMENT ON TABLE public.studios IS '…'`, which
    // changes no COLUMN digest and so left the column inventory green. The
    // catalog answers it directly: there is no table-level description today,
    // and adding one fails here regardless of how the SQL was written - no
    // keyword matching involved.
    //
    // WHAT IS NOT COVERED, scoped on review's recommendation rather than
    // defended further. An earlier version of this note said a COMMENT on an
    // UNRELATED object is "caught by the applied-statement count". Too broad:
    // that count sees LITERAL TOP-LEVEL statements only, and
    //   execute 'COM' || 'MENT ON FUNCTION public.f() IS ...'
    // inside the existing PL/pgSQL block passes both construction guards, shows
    // no `comment on` in the applied text, and touches nothing on
    // public.studios. The source contract already concedes that split dynamic
    // SQL defeats token assertions; this note had not.
    //
    // Review's own judgement, which I asked for and am taking: "not worth
    // another parser-hardening round; scope the guarantee". So the guarantee IS
    // scoped - literal top-level COMMENT statements, plus the full catalog
    // surface of public.studios - and a comment reaching an unrelated object
    // through dynamic SQL is OUT OF SCOPE here, not silently covered. Closing
    // it would mean pinning every pg_description row in the database, which
    // would red on every unrelated migration that adds a comment anywhere.
    const { rows } = await adminQuery(
      `select count(*)::int as n
         from pg_description
        where objoid = 'public.studios'::regclass
          and classoid = 'pg_class'::regclass
          and objsubid = 0`,
    );
    expect(
      rows[0].n,
      "a table-level comment appeared on public.studios; 0205 ships column comments only",
    ).toBe(0);
  });

  it("the commented-column inventory of public.studios is exactly the approved one", async () => {
    const { rows } = await adminQuery(
      `select a.attname as col,
              encode(sha256(col_description(a.attrelid, a.attnum)::bytea), 'hex') as digest
         from pg_attribute a
        where a.attrelid = 'public.studios'::regclass
          and a.attnum > 0
          and not a.attisdropped
          and col_description(a.attrelid, a.attnum) is not null
        order by a.attname`,
    );
    const actual = Object.fromEntries(
      rows.map((r) => [r.col as string, r.digest as string]),
    );
    expect(
      Object.keys(actual).sort(),
      "the SET of commented columns on public.studios changed: a comment was added or removed",
    ).toEqual(Object.keys(COMMENT_INVENTORY).sort());
    for (const [col, digest] of Object.entries(COMMENT_INVENTORY)) {
      expect(
        actual[col],
        `public.studios.${col}'s comment text changed; if that was deliberate, update its digest in the same commit`,
      ).toBe(digest);
    }
  });

  it("APPLIED 0205 ships exactly two COMMENT statements, on exactly the two approved columns", async () => {
    // Review asked for the migration's exact COMMENT count and target columns to
    // be pinned, rather than treating whatever the catalog holds as approved.
    // This does it against the APPLIED SQL recorded in schema_migrations, so it
    // is immune to source layout - the thing that defeated four source parsers.
    //
    // Why count here and not in the source contract: a source-level inventory is
    // satisfiable by a commented-out statement, which is exactly why the old one
    // was deleted. The applied text is what the server actually ran.
    //
    // RESIDUAL, stated rather than papered over: this cannot detect a migration
    // FILE edited after the last apply - it reads what was applied. Only a fresh
    // reset reconciles file and catalog, which is what CI's db lane does on every
    // run; `npm run verify:changed` against a stale local stack will not.
    const { rows } = await adminQuery(
      `select array_to_string(statements, E'\n') as sql
         from supabase_migrations.schema_migrations
        where version = $1`,
      ["0205"],
    );
    expect(rows.length, "migration 0205 is not recorded as applied").toBe(1);
    // Strip `--` lines: the applied text carries this migration's prose too, and
    // a header that merely MENTIONS a comment statement must not count as one.
    // Sound here because a sibling source assertion forbids block comments.
    const appliedCode = (rows[0].sql as string)
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    // CASE-INSENSITIVE AND WHITESPACE-TOLERANT, because SQL is. The first
    // version of these two matchers was lowercase-and-single-space, so an
    // ordinary `COMMENT ON TABLE public.studios IS '...'` would execute and not
    // be counted - review's finding. This is not another attempt at parsing SQL;
    // it is a regex that was simply wrong about the language, since PostgreSQL
    // keywords are case-insensitive and any run of whitespace separates them.
    const targets = [
      ...appliedCode.matchAll(
        /\bcomment\s+on\s+column\s+public\.studios\.(\w+)\s+is\b/gi,
      ),
    ].map((m) => m[1]);
    expect(
      targets,
      "applied 0205 must COMMENT exactly the two admission-provenance columns, in order",
    ).toEqual([
      "new_client_admission_mode_set_at",
      "new_client_admission_mode_set_by",
    ]);
    expect(
      [...appliedCode.matchAll(/\bcomment\s+on\b/gi)].length,
      "applied 0205 must ship no OTHER literal COMMENT statement - a table, a function, or another column - in any letter case. Scoped to literal top-level statements: dynamic SQL built by concatenation is out of scope and is documented as such above",
    ).toBe(2);
  });

  it("NO column comment on public.studios carries the withdrawn claim family", async () => {
    // F4 from independent verification. The two tests below read only the two
    // columns they name, so a comment injected on a THIRD column shipped
    // unguarded - the demonstrated case added
    // `comment on column public.studios.new_client_admission_mode is
    //  'INJECTED: ... the only writer that sets it and cannot be anything but
    //  null.'` and every assertion still passed.
    //
    // This sweeps the whole table instead of enumerating columns, so a new
    // column or a new comment is covered the moment it exists.
    //
    // KNOWN EXCEPTION, deliberately not pinned here: 0204's comment on
    // new_client_admission_mode claims "no role holds direct UPDATE on this
    // table", which is measurably FALSE - anon, authenticated, service_role and
    // postgres all hold UPDATE on that column. 0204 is applied and frozen, so
    // correcting it needs its own forward migration; it is raised separately and
    // is out of this change's scope. None of the patterns below match it, so
    // this guard does not red on it.
    const { rows } = await adminQuery(
      `select a.attname as col, col_description(a.attrelid, a.attnum) as d
         from pg_attribute a
        where a.attrelid = 'public.studios'::regclass
          and a.attnum > 0
          and not a.attisdropped
          and col_description(a.attrelid, a.attnum) is not null
        order by a.attname`,
    );
    expect(
      rows.length,
      "public.studios should carry commented columns; zero means this sweep is vacuous",
    ).toBeGreaterThan(0);
    for (const row of rows) {
      expectNoMonopoly(`studios.${row.col as string}`, row.d as string);
    }
  });

  it("set_at describes INITIALIZED state, with no owner-choice and no exhaustive origin claim", async () => {
    const d = await description("new_client_admission_mode_set_at");
    // The complete check. Everything after it is a better error message.
    expect(d, "set_at's catalog comment is not the approved value").toBe(
      EXPECTED.new_client_admission_mode_set_at,
    );
    // Truthful about what non-null now means. 0204's text says none of this.
    expect(d, "set_at must describe initialization").toMatch(/initialized/i);
    expect(d, "set_at must name set_by as the discriminator").toMatch(
      /new_client_admission_mode_set_by/,
    );
    // 0204's retired claim, which is exactly what survives if 0205 is absent.
    expect(
      d,
      "non-null set_at must NOT be described as an owner's choice",
    ).not.toMatch(/no owner has\s+chosen a mode/i);
    // INSERT-time limitation stated, not implied.
    expect(d, "set_at must disclaim INSERT-time validation").toMatch(
      /NOT VALIDATED AT INSERT/,
    );
    expect(d, "set_at must name the missing INSERT trigger").toMatch(
      /no INSERT trigger/i,
    );
    expectNoMonopoly("set_at", d);
  });

  it("set_by scopes auth.uid() provenance to the command and claims no monopoly", async () => {
    const d = await description("new_client_admission_mode_set_by");
    // The complete check. Everything after it is a better error message.
    expect(d, "set_by's catalog comment is not the approved value").toBe(
      EXPECTED.new_client_admission_mode_set_by,
    );
    // RESTORED after review. The deleted source tests asserted these two and
    // the first replacement did not, so they could have regressed silently:
    // set_by must still distinguish system initialization from a pre-0204 row,
    // and must name the missing INSERT trigger rather than only disclaim
    // validation generically.
    expect(d, "set_by must distinguish system initialization").toMatch(
      /system-initialized|system initialization/i,
    );
    expect(d, "set_by must still identify the pre-0204 legacy case").toMatch(
      /predates 0204|set_at NULL/i,
    );
    expect(d, "set_by must name the missing INSERT trigger").toMatch(
      /no INSERT trigger/i,
    );
    // The provenance is a property of the COMMAND, not of the column.
    expect(d, "set_by must name set_new_client_admission_mode").toMatch(
      /set_new_client_admission_mode/,
    );
    expect(d, "set_by must say that command RESOLVES the value").toMatch(/resolves/i);
    expect(d, "set_by must attribute the value to auth.uid()").toMatch(/auth\.uid\(\)/);
    // No FK, and no INSERT-time validation - both acknowledged.
    expect(d, "set_by must record that it is not a foreign key").toMatch(
      /not a foreign key/i,
    );
    expect(d, "set_by must disclaim INSERT-time validation").toMatch(
      /NOT VALIDATED AT INSERT/,
    );
    expect(d, "set_by must say the guard polices UPDATE, not creation").toMatch(
      /polices UPDATE, not creation/,
    );
    // The lesson 0204 recorded after CI run 36729106946 must survive a rewrite.
    expect(d, "set_by must keep the no-foreign-key rationale").toMatch(
      /PostgREST embed ambiguous/,
    );
    expectNoMonopoly("set_by", d);
  });
});

describe("the DEFAULT cannot backfill, and an explicit NULL still means legacy", () => {
  it("an insert that explicitly names set_at NULL keeps NULL", async () => {
    // WHAT THE DEFAULT ALONE CANNOT DO. A column default applies only when the
    // INSERT omits the column; it never overrides a value the insert supplies,
    // and `ALTER COLUMN SET DEFAULT` never rewrites a row that already exists.
    // So the default cannot reach a pre-existing row, which is why the five
    // legitimately-NULL legacy studios the census found keep their NULL.
    //
    // THE DEFAULT IS NOT THE WHOLE MIGRATION ANY MORE, and this comment used to
    // read as though it were — it claimed "no DML in this migration can reach"
    // the owner-stamped WAITLIST studio, which stopped being true when the
    // census-to-apply repair was added. The repair DOES write rows. What keeps
    // that studio and the five legacy rows out of its way is its PREDICATE and
    // its CENSUS SET, not an absence of DML, and those are proved by the window
    // blocks below rather than asserted here.
    const id = randomUUID();
    await adminQuery(
      `insert into public.studios
         (id, name, owner_email, new_client_admission_mode_set_at)
       values ($1, $2, $3, null)`,
      [id, "Explicit legacy", `legacy-${id.slice(0, 8)}@harness.local`],
    );
    const row = await admissionRow(id);
    expect(row.mode).toBe("open");
    expect(row.set_at, "an explicitly-NULL set_at must survive the default").toBeNull();
    expect(row.set_by).toBeNull();
  });
});

describe("the fresh owner may choose ANY mode immediately — no cutover ceremony", () => {
  let studio: SeededStudio;

  beforeAll(async () => {
    // seedStudio names no admission field, so this studio is born stamped by
    // the 0205 default exactly like one the admin wizard creates — and unlike
    // the harness's own pre-0205 behaviour, which produced a legacy-looking row.
    studio = await seedStudio("admission-fresh");
  });

  const choose = (mode: string) =>
    asUser(studio.userId, (query) =>
      query("select * from public.set_new_client_admission_mode($1, $2)", [
        studio.studioId,
        mode,
      ]),
    );

  it("C1. Open is accepted directly — the regression this migration closes", async () => {
    // THE EXACT FAILING CASE. Before 0205 this returned
    // `legacy_waitlist_cutover_required`, because the brand-new row's
    // `set_at` was NULL and the command could not tell it from a 2026-05 studio.
    const { rows } = await choose("open");
    expect(rows[0].outcome, "a NEW studio must never be told to choose Waitlist first").toBe(
      "ok",
    );
    expect(rows[0].outcome).not.toBe("legacy_waitlist_cutover_required");
    expect(rows[0].mode).toBe("open");
  });

  it("C2. Closed is accepted directly too", async () => {
    const { rows } = await choose("closed");
    expect(rows[0].outcome).toBe("ok");
    expect(rows[0].mode).toBe("closed");
  });

  it("E. Waitlist works normally and records the OWNER in set_by", async () => {
    const { rows } = await choose("waitlist");
    expect(rows[0].outcome).toBe("ok");
    expect(rows[0].mode).toBe("waitlist");

    const row = await admissionRow(studio.studioId);
    expect(row.mode).toBe("waitlist");
    expect(row.set_at).not.toBeNull();
    expect(
      row.set_by,
      "an OWNER change must record the practitioner the database resolved",
    ).toBe(studio.practitionerId);
  });

  it("F. Waitlist -> Open works, and set_by stays the owner", async () => {
    await choose("waitlist");
    const { rows } = await choose("open");
    expect(rows[0].outcome).toBe("ok");
    expect(rows[0].mode).toBe("open");

    const row = await admissionRow(studio.studioId);
    expect(row.mode).toBe("open");
    expect(row.set_by).toBe(studio.practitionerId);
  });

  it("set_by moving from NULL to the owner is what marks the hand-over", async () => {
    // The row started system-initialized (set_by NULL) and is now owner-owned.
    // That transition is the one `set_by` exists to record, and it is the only
    // thing distinguishing the two stamped states.
    const row = await admissionRow(studio.studioId);
    expect(row.set_by).not.toBeNull();
  });
});

describe("D. the legacy transition guard is UNCHANGED for genuinely unstamped rows", () => {
  let studio: SeededStudio;

  beforeAll(async () => {
    studio = await seedStudio("admission-legacy");
    // Manufacture the pre-0204 shape.
    //
    // This needs the row-scoped permit, because `studios_admission_mode_guard`
    // (BEFORE UPDATE) refuses any update touching the three admission fields
    // without one. Arming it here is not a bypass and not a global disable: it
    // is transaction-local and names exactly this studio, which is the same
    // mechanism `set_new_client_admission_mode` itself uses. It is also the only
    // honest way to manufacture a legacy row on a database where 0205 has
    // already run — and manufacturing one is required, because the entire point
    // of the fix is that the two shapes behave DIFFERENTLY.
    await adminQuery(
      `do $$
       begin
         perform set_config('hone.admission_mode_studio_id', '${studio.studioId}', true);
         update public.studios
            set new_client_admission_mode        = 'open',
                new_client_admission_mode_set_at = null,
                new_client_admission_mode_set_by = null
          where id = '${studio.studioId}';
       end $$;`,
    );
  });

  it("the row really is unstamped before the assertions below", async () => {
    // Non-vacuity: if the setup silently failed, every refusal below would be a
    // pass for the wrong reason.
    const row = await admissionRow(studio.studioId);
    expect(row.set_at, "setup did not produce an unstamped row").toBeNull();
  });

  const choose = (mode: string) =>
    asUser(studio.userId, (query) =>
      query("select * from public.set_new_client_admission_mode($1, $2)", [
        studio.studioId,
        mode,
      ]),
    );

  it("D1. a pre-0204 row still CANNOT move directly to Open", async () => {
    const { rows } = await choose("open");
    expect(rows[0].outcome).toBe("legacy_waitlist_cutover_required");
  });

  it("D2. a pre-0204 row still CANNOT move directly to Closed", async () => {
    const { rows } = await choose("closed");
    expect(rows[0].outcome).toBe("legacy_waitlist_cutover_required");
  });

  it("D3. Waitlist is still the way out, and it stamps the row", async () => {
    const { rows } = await choose("waitlist");
    expect(rows[0].outcome).toBe("ok");
    const row = await admissionRow(studio.studioId);
    expect(row.set_at).not.toBeNull();
    expect(row.set_by).toBe(studio.practitionerId);
  });

  it("D4. and after that cutover write, Open is available — unchanged behaviour", async () => {
    const { rows } = await choose("open");
    expect(rows[0].outcome).toBe("ok");
  });
});

describe("G. an owner-stamped WAITLIST studio is untouched by any of this", () => {
  // The production studio deliberately persisted at WAITLIST must remain
  // byte-for-byte unchanged.
  //
  // THIS BLOCK USED TO ARGUE THAT 0205 CONTAINS NO DML, WHICH IS NO LONGER
  // TRUE: the census-to-apply repair performs a bounded UPDATE. The conclusion
  // survives, but the reason had to be replaced, and the replacement is
  // stronger because it is specific rather than global. Three facts carry it,
  // and the apply is excluded by any ONE of them:
  //
  //   1. the repair's predicate requires `new_client_admission_mode_set_by IS
  //      NULL`, and that studio carries an owner stamp, so it is not selected;
  //   2. it is a MEMBER OF THE CENSUS SET, which the predicate excludes by id,
  //      so it is out of scope independently of (1) — and because the evidence
  //      is an id rather than a timestamp, no mutation of its own columns can
  //      move it into scope;
  //   3. the column default cannot reach an existing row at all, and an
  //      ordinary studios UPDATE does not disturb the admission fields.
  //
  // (1) and (2) are each proved directly, on local analogues, by the
  // out-of-window block above — an owner-stamped non-census row is left
  // byte-for-byte alone, and a census row stays unstamped even when its
  // created_at is forward-dated a year. This block exercises (3).
  let studio: SeededStudio;

  beforeAll(async () => {
    studio = await seedStudio("admission-willow-analogue");
    await asUser(studio.userId, (query) =>
      query("select * from public.set_new_client_admission_mode($1, $2)", [
        studio.studioId,
        "waitlist",
      ]),
    );
  });

  it("stays persisted WAITLIST across an unrelated studios update", async () => {
    const before = await admissionRow(studio.studioId);
    expect(before.mode).toBe("waitlist");

    // An ordinary field, with no admission permit armed. The guard must allow
    // this and must not let it alter the three admission fields.
    await adminQuery(`update public.studios set name = $2 where id = $1`, [
      studio.studioId,
      "Renamed, admission untouched",
    ]);

    const after = await admissionRow(studio.studioId);
    expect(after.mode).toBe("waitlist");
    expect(after.set_at!.getTime()).toBe(before.set_at!.getTime());
    expect(after.set_by).toBe(before.set_by);
  });
});

// ===========================================================================
// THE CENSUS-TO-APPLY GAP.
//
// The column default only helps inserts that happen AFTER it. 0204 is applied
// to production while 0205 is not, so a studio created in the window BETWEEN
// the census and this apply is born `open` / NULL and would keep that NULL
// forever — read as a pre-0204 legacy row, and handed the cutover ceremony 0205
// exists to remove. Section 3 of the migration repairs exactly that window.
//
// THESE TESTS RUN THE MIGRATION'S OWN BYTES. The repair block is extracted from
// the .sql file between its markers and executed here, rather than being
// re-written in TypeScript. A re-written copy would be a second implementation
// that can drift from the one production actually applies — and it would keep
// passing after the real block was broken, which is the one failure a
// regression test for an apply-time repair must not have.
// ===========================================================================

const MIGRATION_SQL = readFileSync(
  path.join(process.cwd(), "supabase/migrations/0205_new_studio_admission_default.sql"),
  "utf8",
);

/** The repair block, verbatim, between the markers the migration declares. */
const REPAIR_SQL = (() => {
  const m = /-- >>> 0205 APPLY-TIME REPAIR BEGIN\n([\s\S]*?)-- <<< 0205 APPLY-TIME REPAIR END/.exec(
    MIGRATION_SQL,
  );
  if (!m) throw new Error("0205: the apply-time repair markers are gone from the migration");
  return m[1];
})();

/**
 * The census set, READ FROM THE MIGRATION so the test cannot pin a stale list.
 *
 * Membership is the eligibility evidence, and it is by ID on purpose:
 * `studios.created_at` is mutable by the row's own owner, so a timestamp
 * boundary could be defeated by forward-dating a genuine legacy studio past it.
 * An id cannot be rewritten by its owner.
 */
const CENSUS_IDS: string[] = (() => {
  const block = /k_census constant uuid\[\] := array\[([\s\S]*?)\];/.exec(MIGRATION_SQL);
  if (!block) throw new Error("0205: the census id set is gone from the migration");
  const ids = [...block[1].matchAll(/'([0-9a-f-]{36})'::uuid/g)].map((m) => m[1]);
  if (ids.length === 0) throw new Error("0205: the census id set is empty");
  return ids;
})();

/**
 * Install the census lineage: every `k_census` id present in `public.studios`.
 *
 * REQUIRED BY EVERY TEST THAT RUNS THE REPAIR. Since the lineage gate was added,
 * the block ABORTS on a non-empty database that is missing any census id — which
 * is exactly what a local test database is by default. So the lineage is
 * installed once, up front, and the gate's own tests remove a member
 * deliberately and put it back.
 *
 * Delete-then-insert, so the file is re-runnable against a database that was not
 * reset: these are FIXED ids, and a bare INSERT raises `studios_pkey` the second
 * time. (Learned twice in this file already.) The rows are inserted STAMPED, so
 * they are census members that the repair must skip on membership grounds rather
 * than on shape.
 */
async function installCensusLineage(): Promise<void> {
  for (const id of CENSUS_IDS) {
    await adminQuery(`delete from public.studios where id = $1`, [id]);
    await adminQuery(
      `insert into public.studios (id, name, owner_email) values ($1, $2, $3)`,
      [id, `Census ${id.slice(0, 8)}`, `census-${id.slice(0, 8)}@harness.local`],
    );
  }
}

/** Remove ONE census member, so the lineage is provably incomplete. */
async function dropCensusMember(id: string): Promise<void> {
  await adminQuery(`delete from public.studios where id = $1`, [id]);
}

/** Set the guard's firing mode. ALTER TABLE spellings, not a pg_trigger UPDATE. */
async function setGuardMode(mode: "O" | "A" | "R" | "D"): Promise<void> {
  const verb = {
    O: "enable trigger",
    A: "enable always trigger",
    R: "enable replica trigger",
    D: "disable trigger",
  }[mode];
  await adminQuery(`alter table public.studios ${verb} studios_admission_mode_guard`);
}

/** The guard's exact CREATE TRIGGER statement, for byte-faithful restoration. */
async function guardDef(): Promise<string> {
  const { rows } = await adminQuery(
    `select pg_get_triggerdef(t.oid) as def
       from pg_trigger t
      where t.tgrelid = 'public.studios'::regclass
        and t.tgname = 'studios_admission_mode_guard'
        and not t.tgisinternal`,
  );
  return rows[0].def as string;
}

/**
 * Replace the guard with an IMPOSTER under the same name.
 *
 * `timing` is the full event clause, so the same helper covers "right name,
 * wrong function" and "right function, wrong event".
 */
async function installImposterGuard(
  timing: string,
  fn: "imposter" | "real",
  whenClause = "",
): Promise<void> {
  await adminQuery(
    `create or replace function public.__hone_imposter_guard() returns trigger
       language plpgsql as $$ begin return new; end $$`,
  );
  await adminQuery(`drop trigger studios_admission_mode_guard on public.studios`);
  const target =
    fn === "real" ? "public.studios_admission_mode_guard()" : "public.__hone_imposter_guard()";
  await adminQuery(
    `create trigger studios_admission_mode_guard ${timing} on public.studios
       for each row ${whenClause} execute function ${target}`,
  );
}

/** Put the real guard back from its own captured definition. */
async function restoreGuard(def: string): Promise<void> {
  await adminQuery(
    `drop trigger if exists studios_admission_mode_guard on public.studios`,
  );
  await adminQuery(def);
  await adminQuery(`drop function if exists public.__hone_imposter_guard()`);
}

async function censusPresent(): Promise<number> {
  const { rows } = await adminQuery(
    `select count(*)::int as n from public.studios where id = any($1::uuid[])`,
    [CENSUS_IDS],
  );
  return rows[0].n as number;
}

// The lineage must exist before ANY block below runs the repair.
beforeAll(installCensusLineage);

/** Force a studio into the repairable shape: unstamped, open, no recorded actor. */
async function makeWindowRow(studioId: string): Promise<void> {
  // The permit is required for the admission fields and is transaction-local,
  // naming exactly this studio — the same mechanism the supported command uses.
  //
  // What makes a row REPAIRABLE is now membership, not time: a seeded studio has
  // a random id and is therefore not a census member, so once it is unstamped it
  // is exactly the post-census shape the repair exists for. `created_at` plays no
  // part in that and needs no permit.
  await adminQuery(
    `do $$
     begin
       perform set_config('hone.admission_mode_studio_id', '${studioId}'::uuid::text, true);
       update public.studios
          set new_client_admission_mode        = 'open',
              new_client_admission_mode_set_at = null,
              new_client_admission_mode_set_by = null
        where id = '${studioId}'::uuid;
     end $$;`,
  );
}

describe("the apply-time repair closes the census-to-apply window", () => {
  let studio: SeededStudio;

  beforeAll(async () => {
    studio = await seedStudio("admission-window");
    await makeWindowRow(studio.studioId);
  });

  const choose = (mode: string) =>
    asUser(studio.userId, (query) =>
      query("select * from public.set_new_client_admission_mode($1, $2)", [
        studio.studioId,
        mode,
      ]),
    );

  it("the census set is read from the migration, not pinned here", () => {
    expect(CENSUS_IDS.length, "the census enumerated seven studios").toBe(7);
    for (const id of CENSUS_IDS) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it("RED BEFORE: the window row is misclassified as legacy and refuses Open", async () => {
    // The defect itself, reproduced. This studio was created long after 0204,
    // but carries a NULL set_at because 0205 had not landed when it was
    // inserted — so the command cannot tell it from a 2026-05 studio.
    const row = await admissionRow(studio.studioId);
    expect(row.set_at, "setup did not produce the window shape").toBeNull();
    expect(
      CENSUS_IDS,
      "a seeded studio must NOT be a census member — that is what makes it eligible",
    ).not.toContain(studio.studioId);

    const { rows } = await choose("open");
    expect(rows[0].outcome).toBe("legacy_waitlist_cutover_required");
  });

  it("GREEN AFTER: the migration's own repair block stamps it, and Open is accepted", async () => {
    await adminQuery(REPAIR_SQL);

    const row = await admissionRow(studio.studioId);
    expect(row.set_at, "the repair must stamp the window row").not.toBeNull();
    expect(
      row.set_at!.getTime(),
      "set_at must be the row's creation instant, not the apply instant",
    ).toBe(row.created_at.getTime());
    expect(row.set_by, "a system repair records no actor").toBeNull();
    expect(row.mode).toBe("open");

    const { rows } = await choose("open");
    expect(rows[0].outcome, "the new owner must now be able to choose Open").toBe("ok");
  });

  it("IDEMPOTENT: a second run changes nothing it already did", async () => {
    // The owner has since chosen `open` through the command, so the row now
    // carries THEIR stamp. Re-running must not reach it at all.
    const before = await admissionRow(studio.studioId);
    await adminQuery(REPAIR_SQL);
    const after = await admissionRow(studio.studioId);
    expect(after.set_at!.getTime()).toBe(before.set_at!.getTime());
    expect(after.set_by).toBe(before.set_by);
    expect(after.mode).toBe(before.mode);
  });
});

// ===========================================================================
// THE ENVIRONMENT / LINEAGE GATE.
//
// `k_census` distinguishes production's known rows only on a database descended
// from the census that produced it. On any other NON-EMPTY database — Hone
// Staging, or an older production backup being restored and migrated — none of
// those ids exist, so every ordinary open/unstamped row would read as post-0204
// and be stamped, silently losing the legacy cutover. The shape check cannot
// catch it: those rows ARE the expected shape.
//
// This was MEASURED before it was fixed. Simulating three genuine legacy rows on
// a non-census database and running the extracted repair stamped all three.
//
// THE EMPTY-DATABASE CASE IS PROVED BY THE APPLY ITSELF, not here: on every
// fresh chain `studios` is empty when 0205 runs, and the migration emits
// "studios is empty; nothing to repair, and neither the lineage gate nor the guard probe is applicable" followed
// by "stamped 0 studio(s)". That is visible in `supabase db reset` output and in
// CI's db lane. It cannot be staged in this file, because `studios` cannot be
// emptied even transactionally — `appointment_audit_studio_fk` refuses.
// ===========================================================================
// ===========================================================================
// FAIL CLOSED #2 — THE GUARD IS PROVED BEHAVIOURALLY, NOT FROM pg_trigger.
//
// WHY ONE BLOCK NOW. Earlier revisions asked the catalog four separate
// questions: does the guard exist, is it enabled, does the session role let it
// fire, is the named trigger really that function at BEFORE UPDATE ROW. Each
// was correct and each left an adjacent gap, and review found five in a row.
// The last two were `tgattr` and `tgqual` — `BEFORE UPDATE OF name` and
// `BEFORE UPDATE ... WHEN (false)` both carry the right tgfoid, the right
// tgtype bits and an enabled mode, and neither fires for an update of the
// admission columns. Enumerating ways a trigger can fail to fire was not
// converging.
//
// The migration now asks the DATABASE: for EACH candidate, it attempts the
// repair's OWN mutation — same column, same value, same row — without arming the
// permit, and requires that to be refused. Every shape below is therefore ONE
// mechanism's worth of coverage rather than four.
//
// PER-CANDIDATE, AND THE SAME MUTATION, both for a measured reason. A first
// version probed once before the loop by changing `set_by` on the lowest-id
// studio, and review produced the counterexample now last in this list: a guard
// with `WHEN (new.set_by IS DISTINCT FROM old.set_by)` invokes the real function
// and refuses THAT probe while never firing for a `set_at` change. The probe
// passed and every candidate would have been written unguarded.
//
// Each case asserts the repair candidate is untouched, so "aborts" is a row and
// not just a message. Trigger definition and session role are restored in
// `finally`, and the closing control proves the guard is byte-identical.
// ===========================================================================
describe("FAIL CLOSED #2: an unpermitted admission write must be REFUSED", () => {
  let candidate: SeededStudio;
  let realDef: string;

  beforeAll(async () => {
    await installCensusLineage();
    candidate = await seedStudio("admission-guard-probe");
    realDef = await guardDef();
  });

  beforeEach(async () => {
    await setGuardMode("O");
    await makeWindowRow(candidate.studioId);
  });

  const repairAsRole = (role: "origin" | "replica" | "local") =>
    adminTx(async (q) => {
      await q(`set local session_replication_role = '${role}'`);
      return q(REPAIR_SQL);
    });

  const PROBE_REFUSAL = /was NOT refused|not being policed/i;

  /** Every shape that leaves the guard unable to police the repair's own UPDATE. */
  const defeated: ReadonlyArray<{
    name: string;
    arrange: () => Promise<void>;
    run: () => Promise<unknown>;
  }> = [
    {
      name: "DISABLED trigger",
      arrange: () => setGuardMode("D"),
      run: () => adminQuery(REPAIR_SQL),
    },
    {
      name: "REPLICA-only trigger under an origin session",
      arrange: () => setGuardMode("R"),
      run: () => adminQuery(REPAIR_SQL),
    },
    {
      name: "ordinary trigger under a REPLICA session",
      arrange: async () => undefined,
      run: () => repairAsRole("replica"),
    },
    {
      name: "same name, DIFFERENT FUNCTION",
      arrange: () => installImposterGuard("before update", "imposter"),
      run: () => adminQuery(REPAIR_SQL),
    },
    {
      name: "real function, WRONG EVENT (after insert)",
      arrange: () => installImposterGuard("after insert", "real"),
      run: () => adminQuery(REPAIR_SQL),
    },
    {
      // tgattr. Invisible to tgfoid + tgtype + tgenabled, which all match.
      name: "real function scoped to OTHER COLUMNS (update of name)",
      arrange: () => installImposterGuard("before update of name", "real"),
      run: () => adminQuery(REPAIR_SQL),
    },
    {
      // tgqual. Likewise invisible to every catalog check that preceded this.
      name: "real function with WHEN (false)",
      arrange: () => installImposterGuard("before update", "real", "when (false)"),
      run: () => adminQuery(REPAIR_SQL),
    },
    {
      // THE SHAPE THAT DEFEATED THE SINGLE PRE-LOOP PROBE, and the reason the
      // probe is now per-candidate against the repair's own mutation.
      //
      // This guard invokes the REAL function and genuinely refuses a change to
      // `set_by` — so a probe that changed `set_by` on some other row was
      // refused, concluded the guard was live, and let the repair write `set_at`
      // on every candidate completely unguarded. Probing the actual mutation on
      // the actual row is what closes it: this guard never fires for a `set_at`
      // change, so the repair's own unpermitted write succeeds and is caught.
      name: "real function firing ONLY on set_by changes (WHEN on the wrong column)",
      arrange: () =>
        installImposterGuard(
          "before update",
          "real",
          "when (new.new_client_admission_mode_set_by is distinct from old.new_client_admission_mode_set_by)",
        ),
      run: () => adminQuery(REPAIR_SQL),
    },
  ];

  for (const shape of defeated) {
    it(`aborts and writes nothing: ${shape.name}`, async () => {
      try {
        await shape.arrange();
        await expect(shape.run()).rejects.toThrow(PROBE_REFUSAL);
        expect(
          (await admissionRow(candidate.studioId)).set_at,
          "the repair must write nothing when the guard cannot police it",
        ).toBeNull();
      } finally {
        await restoreGuard(realDef);
      }
    });
  }

  it("the shipped guard PASSES the probe, and the repair proceeds", async () => {
    await expect(adminQuery(REPAIR_SQL)).resolves.toBeDefined();
    expect((await admissionRow(candidate.studioId)).set_at).not.toBeNull();
  });

  it("an ALWAYS trigger passes even under a replica session", async () => {
    try {
      await setGuardMode("A");
      await expect(repairAsRole("replica")).resolves.toBeDefined();
      expect((await admissionRow(candidate.studioId)).set_at).not.toBeNull();
    } finally {
      await setGuardMode("O");
    }
  });

  it("a WIDER guard that also fires on insert passes, not refused", async () => {
    // The probe only asks whether the admission write is policed. A guard that
    // additionally fires on insert still polices it, so it must be accepted —
    // strictness with no safety behind it would be a different defect.
    try {
      await installImposterGuard("before insert or update", "real");
      await expect(adminQuery(REPAIR_SQL)).resolves.toBeDefined();
      expect((await admissionRow(candidate.studioId)).set_at).not.toBeNull();
    } finally {
      await restoreGuard(realDef);
    }
  });

  it("ZERO candidates: no probe runs, and nothing is written", async () => {
    // The probe lives inside the repair loop, so with no candidates it never
    // executes - and that is correct rather than a gap: the guard needs proving
    // for the writes this migration makes, and here it makes none.
    //
    // Proved by DEFEATING the guard and showing the repair still succeeds. With
    // a candidate present this exact arrangement aborts (see the shapes above);
    // with none it must not, because no probe and no write occur.
    await adminQuery(REPAIR_SQL); // drain any outstanding candidate
    const { rows: before } = await adminQuery(
      `select count(*)::int as n from public.studios
        where new_client_admission_mode_set_at is null
          and new_client_admission_mode_set_by is null
          and new_client_admission_mode = 'open'`,
    );
    expect(before[0].n, "the suite must be drained for this case to mean anything").toBe(0);

    try {
      await installImposterGuard("before update", "real", "when (false)");
      await expect(
        adminQuery(REPAIR_SQL),
        "with no candidates there is nothing to probe and nothing to guard",
      ).resolves.toBeDefined();
    } finally {
      await restoreGuard(realDef);
    }
  });

  it("the probe leaves NO trace: the guard is byte-identical and no row was written", async () => {
    // Non-vacuity for every `finally` above, and for the probe's own promise
    // that its write never persists. The probe changes `set_by` on the
    // lowest-id studio inside a subtransaction; if that ever survived, this
    // would catch it.
    expect(await guardDef()).toBe(realDef);

    // The probe now writes the repair's OWN value, so there is no sentinel to
    // look for — the observable promise is instead that a REFUSED candidate is
    // left unstamped, which every defeat case above asserts directly. What is
    // checked here is that no candidate was stamped WITHOUT an actor by anything
    // other than the repair: a probe write that escaped its subtransaction would
    // show up as a stamped row in a run whose repair aborted.
    await makeWindowRow(candidate.studioId);
    try {
      await installImposterGuard("before update", "real", "when (false)");
      await expect(adminQuery(REPAIR_SQL)).rejects.toThrow(PROBE_REFUSAL);
    } finally {
      await restoreGuard(realDef);
    }
    expect(
      (await admissionRow(candidate.studioId)).set_at,
      "a probe write must not survive the subtransaction that refused the apply",
    ).toBeNull();
  });
});


describe("the lineage gate refuses a database that is not the census's", () => {
  it("2. an EXACT census lineage passes the gate", async () => {
    expect(await censusPresent()).toBe(CENSUS_IDS.length);
    await expect(adminQuery(REPAIR_SQL)).resolves.toBeDefined();
  });

  it("3. a NON-EMPTY database missing even ONE census id fails closed", async () => {
    const dropped = CENSUS_IDS[CENSUS_IDS.length - 1];
    try {
      await dropCensusMember(dropped);
      expect(await censusPresent()).toBe(CENSUS_IDS.length - 1);

      await expect(adminQuery(REPAIR_SQL)).rejects.toThrow(
        /NOT the 2026-10-01 census lineage/i,
      );
    } finally {
      // finally, for the reason recorded on the anomaly test below: a half-torn
      // lineage makes the repair raise for EVERY later caller in this file.
      await installCensusLineage();
    }
    expect(await censusPresent()).toBe(CENSUS_IDS.length);
  });

  it("4. a staging/backup-like legacy row CANNOT be stamped with the lineage absent", async () => {
    // The defect itself, as a row rather than as an error message. This is the
    // shape a genuine pre-0204 studio has on a restored backup: non-census,
    // unstamped, open, system default — indistinguishable by shape from a real
    // post-census creation, and distinguishable only by lineage.
    const legacyish = await seedStudio("admission-staging-legacy");
    await makeWindowRow(legacyish.studioId);
    const dropped = CENSUS_IDS[0];
    try {
      await dropCensusMember(dropped);
      await expect(adminQuery(REPAIR_SQL)).rejects.toThrow(/census lineage/i);

      // AND IT WROTE NOTHING. The gate runs before any DML, so the row that
      // would have been wrongly stamped is untouched.
      expect(
        (await admissionRow(legacyish.studioId)).set_at,
        "a legacy-shaped row must survive an apply attempt on the wrong database",
      ).toBeNull();
    } finally {
      await installCensusLineage();
    }

    // CONTROL: with the lineage restored, that same row IS repaired — so the
    // refusal above was about the DATABASE, not about this row.
    await adminQuery(REPAIR_SQL);
    expect(
      (await admissionRow(legacyish.studioId)).set_at,
      "with a valid lineage the same row must be repaired, or test 4 proves nothing",
    ).not.toBeNull();
  });
});

describe("the repair touches NOTHING outside its window", () => {
  it("a CENSUS studio keeps its NULL and its ceremony — and FORWARD-DATING cannot change that", async () => {
    // THE P2 THIS CLOSES. The predicate used to be `created_at > boundary`, and
    // `studios.created_at` is MUTABLE by the row's own owner: RLS policy
    // "studios: owners update" permits the UPDATE, `authenticated` holds column
    // privilege on created_at, and the admission guard covers only the three
    // admission fields. So an owner of a genuine legacy studio could forward-date
    // past the boundary, qualify for the repair, be stamped, and silently lose
    // the cutover. Identity is the id now, and this proves the mutation is inert.
    const censusId = CENSUS_IDS[0];

    // The lineage installer already created this row. Put it into the UNSTAMPED
    // legacy shape — the state a real pre-0204 census studio is in — so the only
    // thing keeping it out of the repair is its MEMBERSHIP, not its shape.
    await makeWindowRow(censusId);

    // Forward-date it hard — far past any plausible boundary, and past now().
    await adminQuery(
      `update public.studios set created_at = now() + interval '365 days' where id = $1`,
      [censusId],
    );

    await adminQuery(REPAIR_SQL);

    const row = await admissionRow(censusId);
    expect(
      row.set_at,
      "a census member must stay unstamped however its created_at is moved",
    ).toBeNull();

    // IN-TEST CONTROL. Without it this passes whenever the repair does nothing
    // at all, and would assert "nothing happened" rather than "membership
    // discriminates". A non-census row of the SAME shape must be repaired.
    const control = await seedStudio("admission-non-census");
    await makeWindowRow(control.studioId);
    expect(CENSUS_IDS).not.toContain(control.studioId);
    await adminQuery(REPAIR_SQL);
    expect(
      (await admissionRow(control.studioId)).set_at,
      "a NON-census unstamped system-default row MUST be repaired — otherwise the " +
        "exclusion above proves nothing",
    ).not.toBeNull();

    // And the census row still behaves as legacy: the ceremony is intact.
    const { rows } = await adminQuery(
      `select public.effective_new_client_admission($1, true) as mode`,
      [censusId],
    );
    expect(rows[0].mode, "an unstamped census row still answers through the bridge").toBe(
      "waitlist",
    );
  });

  it("an OWNER-STAMPED non-census row is left byte-for-byte alone", async () => {
    const owned = await seedStudio("admission-owner-stamped");
    await asUser(owned.userId, (query) =>
      query("select * from public.set_new_client_admission_mode($1, $2)", [
        owned.studioId,
        "waitlist",
      ]),
    );
    const before = await admissionRow(owned.studioId);
    expect(before.mode).toBe("waitlist");
    expect(before.set_by).toBe(owned.practitionerId);

    await adminQuery(REPAIR_SQL);

    const after = await admissionRow(owned.studioId);
    expect(after.mode, "an owner's choice must survive the repair").toBe("waitlist");
    expect(after.set_at!.getTime()).toBe(before.set_at!.getTime());
    expect(after.set_by).toBe(before.set_by);
  });
});

describe("the repair FAILS CLOSED rather than writing under a wrong model", () => {
  it("refuses to run when an unstamped NON-CENSUS row is not a plain system default", async () => {
    // mode='waitlist' with a NULL set_at cannot arise through any supported
    // path. If it exists, the model behind the repair is wrong, and writing
    // under a wrong model is exactly what must not happen.
    const odd = await seedStudio("admission-anomalous");
    await adminQuery(
      `do $$
       begin
         perform set_config('hone.admission_mode_studio_id', '${odd.studioId}'::uuid::text, true);
         update public.studios
            set new_client_admission_mode        = 'waitlist',
                new_client_admission_mode_set_at = null,
                new_client_admission_mode_set_by = null
          where id = '${odd.studioId}'::uuid;
       end $$;`,
    );

    // try/FINALLY, NOT A TRAILING CLEANUP. An anomalous non-census row
    // makes the repair refuse for EVERY caller, so if an assertion here throws
    // and the cleanup is skipped, this one row reds every other repair test in
    // the file — and on a database that is not reset between runs, it keeps
    // doing so. That is not hypothetical: it happened while developing this
    // file, and the four failures it caused looked like a broken repair rather
    // than a leaked fixture.
    try {
      await expect(adminQuery(REPAIR_SQL)).rejects.toThrow(
        /do not match the system-default shape|refusing to repair/i,
      );

      // And it wrote nothing on the way out.
      const row = await admissionRow(odd.studioId);
      expect(row.set_at).toBeNull();
    } finally {
      await adminQuery(
        `do $$
         begin
           perform set_config('hone.admission_mode_studio_id', '${odd.studioId}'::uuid::text, true);
           update public.studios
              set new_client_admission_mode        = 'open',
                  new_client_admission_mode_set_at = now()
            where id = '${odd.studioId}'::uuid;
         end $$;`,
      );
    }
  });

  it("the repair is available again once the anomaly is gone", async () => {
    // Proves the refusal above was about the DATA, not a permanently broken
    // block — and that the cleanup in `finally` actually restored the model.
    await expect(adminQuery(REPAIR_SQL)).resolves.toBeDefined();
  });
});
