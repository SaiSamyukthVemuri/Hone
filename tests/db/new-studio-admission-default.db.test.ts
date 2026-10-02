import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { adminQuery, asUser, seedStudio, type SeededStudio } from "@/tests/db/helpers/harness";

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

/** Force a studio into the window shape: unstamped, created above the boundary. */
async function makeWindowRow(studioId: string): Promise<void> {
  // The permit is required for the admission fields and is transaction-local,
  // naming exactly this studio — the same mechanism the supported command uses.
  // `created_at` needs no permit; the guard polices only the three admission
  // fields. A seeded studio's created_at is already `now()`, hence above the
  // boundary, which is precisely the window this simulates.
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

    // RE-RUNNABLE BY CONSTRUCTION. This row uses a FIXED id — that is the whole
    // point, since membership is the evidence — so a bare INSERT fails with
    // `studios_pkey` on the second run against a database that was not reset.
    // CI resets and would never have seen it; a local re-run would. That exact
    // shape already bit this file once, via a fixture whose cleanup was skipped
    // on failure, so it is removed here rather than left to the next person.
    //
    // DELETE-then-INSERT, not ON CONFLICT DO UPDATE: forcing the admission
    // fields back to NULL through an UPDATE would trip
    // `studios_admission_mode_guard` and need a permit, and a fresh INSERT needs
    // none. This id is created only by this test and has no practitioners or
    // clients hanging off it, so the delete cannot cascade into another fixture.
    await adminQuery(`delete from public.studios where id = $1`, [censusId]);
    await adminQuery(
      `insert into public.studios (id, name, owner_email, new_client_admission_mode_set_at)
       values ($1, $2, $3, null)`,
      [censusId, "Census legacy analogue", `census-${censusId.slice(0, 8)}@harness.local`],
    );

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
  it("refuses to run when an unstamped row above the boundary is not a plain default", async () => {
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

    // try/FINALLY, NOT A TRAILING CLEANUP. An anomalous row above the boundary
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
