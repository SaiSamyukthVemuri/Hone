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
// the SHAPE of the migration — one default, two comments, and ONE BOUNDED
// `update public.studios` — and deliberately proves nothing about behaviour,
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
// "studios is empty; lineage gate not applicable and nothing to repair" followed
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
// The migration now asks the DATABASE: it attempts a real admission-field write
// WITHOUT arming the permit and requires it to be refused. Every shape below is
// therefore ONE mechanism's worth of coverage rather than four, and the two that
// no catalog check caught are in the same list as the ones that were.
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

  it("the probe leaves NO trace: the guard is byte-identical and no row was written", async () => {
    // Non-vacuity for every `finally` above, and for the probe's own promise
    // that its write never persists. The probe changes `set_by` on the
    // lowest-id studio inside a subtransaction; if that ever survived, this
    // would catch it.
    expect(await guardDef()).toBe(realDef);
    const { rows } = await adminQuery(
      `select count(*)::int as n from public.studios
        where new_client_admission_mode_set_by in
              ('00000000-0000-0000-0000-000000000000'::uuid,
               '11111111-1111-1111-1111-111111111111'::uuid)`,
    );
    expect(rows[0].n, "the probe's sentinel actor must never be committed").toBe(0);
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
