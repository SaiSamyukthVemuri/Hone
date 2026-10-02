import { randomUUID } from "node:crypto";
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
// the SHAPE of the migration — one default, two comments, zero DML — and
// deliberately proves nothing about behaviour, because SQL text is not a
// running database. This file is the other half.
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

describe("0205 does NOT backfill, and an explicit NULL still means legacy", () => {
  it("an insert that explicitly names set_at NULL keeps NULL", async () => {
    // THE MECHANISM THAT PROTECTS EVERY PRE-FIX ROW. A column default applies
    // only when the INSERT omits the column; it never overrides a value the
    // insert supplies, and `ALTER COLUMN SET DEFAULT` never rewrites a row that
    // already exists. This is why the production census could find five
    // legitimately-NULL legacy studios and this migration could leave all five
    // alone — including the one deliberately-persisted WAITLIST studio, which
    // carries its own owner stamp and no DML in this migration can reach.
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
  // byte-for-byte unchanged. Two facts carry that, and neither is a grep:
  //
  //   1. 0205 contains ZERO DML — asserted in the migration's source contract,
  //      so no row anywhere can be rewritten by the apply;
  //   2. the default cannot reach an existing row at all, and an ordinary
  //      studios UPDATE still does not disturb the admission fields.
  //
  // This exercises (2) on a local analogue of that studio.
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
