import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool } from "./helpers/harness";

// 0190 — A LEGAL TRANSITION IS NOT A LICENCE TO REWRITE HISTORY.
//
// THE DEFECT THIS FILE EXISTS TO KEEP CLOSED. 0188's transition guard has two
// branches. When `status` does NOT change it freezes every evidence column.
// When `status` DOES change it validated only that the `(old.status,
// new.status)` PAIR was legal — and then let the same statement write anything
// it liked to evidence the transition does not own.
//
// Reproduced on this schema before the repair: one legal `claimed -> released`
// statement moved `claimed_at` back ten days AND replaced
// `claimed_by_practitioner_id` with a different practitioner. The row was
// accepted, and the append-only event log then recorded the SUBSTITUTED
// practitioner as the actor of the release.
//
// WHO CAN REACH THIS. Only the table owner holds UPDATE on
// new_client_waitlist_entries — `authenticated` has SELECT alone and `anon` and
// `service_role` have nothing. So these tests write as the owner, which is
// exactly the actor the guard is the last defence against: the commands
// themselves, a migration, or a console session.
//
// THE MODEL THE REPAIR ENCODES is derived from the commands, not from prose —
// the `set` clause of every UPDATE of this table across the deployed functions.
// Requeue is the case that makes a blanket freeze wrong: it is the one
// transition that legitimately clears earned evidence.

const EN_T = "public.new_client_waitlist_entries";
const EV_T = "public.new_client_waitlist_entry_events";
const US = `'YYYY-MM-DD"T"HH24:MI:SS.USOF'`;

type Fixture = {
  studioId: string;
  userId: string;
  practitionerId: string;
  impostorId: string;
  entryId: string;
  clientId: string;
};

async function seed(label: string): Promise<Fixture> {
  const studioId = randomUUID();
  const userId = randomUUID();
  const practitionerId = randomUUID();
  const uniq = randomUUID().slice(0, 8);
  const mail = `${label}-${uniq}@harness.local`;
  await adminQuery(
    `insert into auth.users (id, email, aud, role) values ($1,$2,'authenticated','authenticated')`,
    [userId, mail],
  );
  await adminQuery(
    `insert into public.studios (id, name, slug, timezone, owner_email) values ($1,$2,$3,'UTC',$4)`,
    [studioId, `${label} ${uniq}`, `${label}-${uniq}`, mail],
  );
  await adminQuery(
    `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
     values ($1,$2,$3,$4,$5,'owner',true)`,
    [practitionerId, studioId, userId, `Owner ${uniq}`, mail],
  );
  // A SECOND practitioner in the same studio — the substitute a rewrite would
  // credit. Same studio, so the same-studio FK cannot be what refuses.
  const impostorUser = randomUUID();
  const impostorId = randomUUID();
  const impostorMail = `imp-${uniq}@harness.local`;
  await adminQuery(
    `insert into auth.users (id, email, aud, role) values ($1,$2,'authenticated','authenticated')`,
    [impostorUser, impostorMail],
  );
  await adminQuery(
    `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
     values ($1,$2,$3,$4,$5,'owner',true)`,
    [impostorId, studioId, impostorUser, `Impostor ${uniq}`, impostorMail],
  );
  const clientId = randomUUID();
  await adminQuery(
    `insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`,
    [clientId, studioId, `C ${uniq}`, `c-${uniq}@harness.local`],
  );
  const j = await adminQuery(
    `select entry_id from public.join_new_client_waitlist($1,$2,$3,null)`,
    [studioId, `P ${uniq}`, `p-${uniq}@harness.local`],
  );
  return { studioId, userId, practitionerId, impostorId, entryId: j.rows[0].entry_id as string, clientId };
}

const claim = (f: Fixture) =>
  adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3) as r`, [
    f.studioId,
    f.entryId,
    f.userId,
  ]).then((x) => x.rows[0].r as string);

const issue = (f: Fixture) =>
  adminQuery(`select result from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`, [
    f.studioId,
    f.entryId,
    f.userId,
  ]).then((x) => x.rows[0].result as string);

const release = (f: Fixture) =>
  adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3) as r`, [
    f.studioId,
    f.entryId,
    f.userId,
  ]).then((x) => x.rows[0].r as string);

/** Every evidence column, as full-precision text, in one row. JS never compares
 *  two stored timestamps: node-postgres truncates microseconds to JS ms. */
async function evidenceOf(entryId: string): Promise<Record<string, string | null>> {
  const r = await adminQuery(
    `select to_char(claimed_at,   ${US}) as claimed_at,
            claimed_by_practitioner_id::text as claimed_by_practitioner_id,
            to_char(invited_at,   ${US}) as invited_at,
            to_char(expired_at,   ${US}) as expired_at,
            to_char(released_at,  ${US}) as released_at,
            to_char(converted_at, ${US}) as converted_at,
            converted_client_id::text as converted_client_id,
            to_char(removed_at,   ${US}) as removed_at,
            removed_by_practitioner_id::text as removed_by_practitioner_id,
            status
       from ${EN_T} where id = $1`,
    [entryId],
  );
  expect(r.rows, "the entry disappeared").toHaveLength(1);
  return r.rows[0] as Record<string, string | null>;
}

/**
 * A legal transition that ALSO tries to rewrite evidence it does not own must
 * be refused as a check violation, and must leave the row exactly as it was.
 */
async function expectEvidenceRewriteRefused(
  entryId: string,
  sql: string,
  params: readonly unknown[],
  expectedColumns: readonly string[],
): Promise<void> {
  const before = await evidenceOf(entryId);
  let code: string | undefined;
  let message = "";
  try {
    await adminQuery(sql, [...params]);
  } catch (e) {
    code = (e as { code?: string }).code;
    message = (e as Error).message;
  }
  expect(code, `the rewrite was ACCEPTED: ${JSON.stringify(before)}`).toBe("23514");
  for (const column of expectedColumns) {
    expect(message, `the refusal does not name ${column}`).toContain(column);
  }
  // Refused means nothing moved — including the status the statement was
  // otherwise entitled to change.
  expect(await evidenceOf(entryId), "the row changed despite the refusal").toEqual(before);
}

afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
describe("A — claimed -> released may not re-attribute the claim", () => {
  it("refuses the exact statement that used to succeed", async () => {
    const f = await seed("tev-a");
    expect(await claim(f)).toBe("claimed");
    await expectEvidenceRewriteRefused(
      f.entryId,
      `update ${EN_T}
          set status = 'released',
              released_at = clock_timestamp(),
              claimed_at = claimed_at - interval '10 days',
              claimed_by_practitioner_id = $2
        where id = $1`,
      [f.entryId, f.impostorId],
      ["claimed_at", "claimed_by_practitioner_id"],
    );
  });

  it("refuses a re-attribution even when the timestamp is left alone", async () => {
    // The two limbs are independent; a guard that only checked the stamp would
    // still let the actor be swapped.
    const f = await seed("tev-a2");
    expect(await claim(f)).toBe("claimed");
    await expectEvidenceRewriteRefused(
      f.entryId,
      `update ${EN_T}
          set status = 'released', released_at = clock_timestamp(),
              claimed_by_practitioner_id = $2
        where id = $1`,
      [f.entryId, f.impostorId],
      ["claimed_by_practitioner_id"],
    );
  });

  it("still performs the legitimate release, and the claim survives it", async () => {
    const f = await seed("tev-a3");
    expect(await claim(f)).toBe("claimed");
    const before = await evidenceOf(f.entryId);
    expect(await release(f)).toBe("released");
    const after = await evidenceOf(f.entryId);
    expect(after.status).toBe("released");
    expect(after.released_at, "the release stamped nothing").not.toBeNull();
    expect(after.claimed_at, "the claim stamp moved").toBe(before.claimed_at);
    expect(
      after.claimed_by_practitioner_id,
      "the claim was re-attributed by a legitimate release",
    ).toBe(before.claimed_by_practitioner_id);
    // The event log credits the genuine actor.
    const ev = await adminQuery(
      `select actor_practitioner_id::text as actor from ${EV_T}
        where entry_id = $1 and to_status = 'released'`,
      [f.entryId],
    );
    expect(ev.rows, "no release event").toHaveLength(1);
    expect(ev.rows[0].actor, "the release event credits the wrong practitioner").toBe(
      f.practitionerId,
    );
  });
});

// ---------------------------------------------------------------------------
describe("B — claimed -> invited may not touch the claim either", () => {
  it("refuses backdating the claim while issuing", async () => {
    const f = await seed("tev-b");
    expect(await claim(f)).toBe("claimed");
    await expectEvidenceRewriteRefused(
      f.entryId,
      `update ${EN_T}
          set status = 'invited', invited_at = clock_timestamp(),
              claimed_at = claimed_at - interval '3 days'
        where id = $1`,
      [f.entryId],
      ["claimed_at"],
    );
  });
});

// ---------------------------------------------------------------------------
describe("C — invited -> expired may not rewrite the invitation's own history", () => {
  it("refuses moving invited_at while expiring", async () => {
    const f = await seed("tev-c");
    expect(await claim(f)).toBe("claimed");
    expect(await issue(f)).toBe("invited");
    await expectEvidenceRewriteRefused(
      f.entryId,
      `update ${EN_T}
          set status = 'expired', expired_at = clock_timestamp(),
              invited_at = invited_at - interval '2 days'
        where id = $1`,
      [f.entryId],
      ["invited_at"],
    );
  });
});

// ---------------------------------------------------------------------------
describe("D — a terminal removal may not rewrite the cycle it ends", () => {
  it("refuses re-attributing the release while removing", async () => {
    const f = await seed("tev-d");
    expect(await claim(f)).toBe("claimed");
    expect(await release(f)).toBe("released");
    await expectEvidenceRewriteRefused(
      f.entryId,
      `update ${EN_T}
          set status = 'removed', removed_at = clock_timestamp(),
              removed_by_practitioner_id = $2,
              released_at = released_at - interval '1 day'
        where id = $1`,
      [f.entryId, f.practitionerId],
      ["released_at"],
    );
  });
});

// ---------------------------------------------------------------------------
describe("E — REQUEUE still clears exactly the cycle it is entitled to clear", () => {
  it("clears the five cycle columns, and the command still succeeds", async () => {
    // The case a blanket "earned evidence is immutable" rule would have broken.
    const f = await seed("tev-e");
    expect(await claim(f)).toBe("claimed");
    expect(await issue(f)).toBe("invited");
    expect(await release(f)).toBe("released");
    const r = await adminQuery(
      `select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`,
      [f.studioId, f.entryId, f.userId],
    );
    expect(r.rows[0].r).toBe("requeued");
    const after = await evidenceOf(f.entryId);
    expect(after.status).toBe("waiting");
    for (const column of [
      "claimed_at",
      "claimed_by_practitioner_id",
      "invited_at",
      "expired_at",
      "released_at",
    ]) {
      expect(after[column], `requeue failed to clear ${column}`).toBeNull();
    }
  });

  it("may NOT reach past the cycle into terminal evidence", async () => {
    // requeue owns the five cycle columns and nothing else: converted_* and
    // removed_* are terminal and belong to no cycle.
    const f = await seed("tev-e2");
    expect(await claim(f)).toBe("claimed");
    expect(await release(f)).toBe("released");
    await expectEvidenceRewriteRefused(
      f.entryId,
      `update ${EN_T}
          set status = 'waiting',
              claimed_at = null, claimed_by_practitioner_id = null,
              invited_at = null, expired_at = null, released_at = null,
              removed_at = clock_timestamp()
        where id = $1`,
      [f.entryId],
      ["removed_at"],
    );
  });
});

// ---------------------------------------------------------------------------
describe("F — what the repair did NOT change", () => {
  it("still refuses an illegal transition, by its own message", async () => {
    const f = await seed("tev-f");
    expect(await claim(f)).toBe("claimed");
    await expect(
      adminQuery(`update ${EN_T} set status = 'removed', removed_at = clock_timestamp() where id = $1`, [
        f.entryId,
      ]),
      "a claimed entry was removed without being released",
    ).rejects.toThrow(/illegal lifecycle transition/);
  });

  it("still freezes evidence when the status does not change at all", async () => {
    const f = await seed("tev-f2");
    expect(await claim(f)).toBe("claimed");
    await expect(
      adminQuery(`update ${EN_T} set claimed_at = claimed_at - interval '1 day' where id = $1`, [
        f.entryId,
      ]),
      "evidence moved without a transition",
    ).rejects.toThrow(/evidence changes only in the statement that performs a legal transition/);
  });

  it("still holds identity and contact details immutable", async () => {
    const f = await seed("tev-f3");
    await expect(
      adminQuery(`update ${EN_T} set joined_at = joined_at - interval '1 day' where id = $1`, [
        f.entryId,
      ]),
    ).rejects.toThrow(/joined_at and source are immutable/);
    await expect(
      adminQuery(`update ${EN_T} set email = 'moved@harness.local' where id = $1`, [f.entryId]),
    ).rejects.toThrow(/contact details are immutable/);
  });

  it("lets every command drive its own transition end to end", async () => {
    // The whole legal path still works: nothing the guard now refuses is
    // something a real command does.
    const f = await seed("tev-f4");
    expect(await claim(f)).toBe("claimed");
    expect(await issue(f)).toBe("invited");
    expect(
      (
        await adminQuery(
          `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
          [f.studioId, f.entryId, f.userId],
        )
      ).rows[0].r,
    ).toBe("not_expired");
    expect(await release(f)).toBe("released");
    expect(
      (
        await adminQuery(`select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`, [
          f.studioId,
          f.entryId,
          f.userId,
        ])
      ).rows[0].r,
    ).toBe("requeued");
    expect(await claim(f)).toBe("claimed");
    expect(await issue(f)).toBe("invited");
    const token = (
      await adminQuery(
        `select raw_token from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`,
        [f.studioId, f.entryId, f.userId],
      )
    ).rows[0];
    void token;
    expect((await evidenceOf(f.entryId)).status).toBe("invited");
  });
});
