import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  seedMember,
  seedSession,
  seedStudio,
} from "./helpers/harness";

// ===========================================================================
// A1b — WHO CAN SEE A TREATMENT-AREA CREATE CLAIM.
//
// *** UNEXECUTED. *** Written against the A1b head with no database
// available; it has never run. It is queued for the shared heavy slot behind
// Photos, General, Team and Insurance. Saying so is the point: 0204 shipped a
// command writing to a column that did not exist, applied clean, passed its
// source contract, and had never once succeeded — a source test cannot see a
// policy's actual effect.
//
// WHY THIS FILE EXISTS. A1b makes the application READ
// `treatment_area_create_claims` for the first time, to answer "did my save
// commit?" after a reload. 0223 granted exactly that:
//
//   grant select on public.treatment_area_create_claims to authenticated;
//   create policy treatment_area_create_claims_member_select
//     for select to authenticated
//     using (public.is_studio_member(studio_id));
//
// Reading the policy is necessary but is NOT proof. The risk if it is wrong is
// specific: the lookup takes a session id and a caller-supplied key and
// reports whether a row exists, so an unscoped policy would turn it into an
// oracle for "does this studio hold a claim under this key" — answerable by
// anyone signed in anywhere. What the application does on top (the route's own
// lineage check) is asserted in the unit lane; THIS asserts the database would
// refuse even if the application did not.
//
// THE CLAIM ROW IS SEEDED ADMINISTRATIVELY, not through
// `create_block_with_initial_setup`. The command's own behaviour is proved in
// machine-initial-save.db.test.ts; this file is about VISIBILITY of a row that
// exists, so standing one up directly keeps the subject single. Direct DML as
// a runtime role is separately asserted to be refused below, so the seeding
// route is not a capability anyone has in production.
// ===========================================================================

afterAll(async () => {
  await closePool();
});

/** A claim row for this session under this key, inserted as the superuser. */
async function seedClaim(
  studioId: string,
  sessionId: string,
  blockId: string,
  key: string,
) {
  const id = randomUUID();
  await adminQuery(
    `insert into public.treatment_area_create_claims
       (id, studio_id, session_id, idempotency_key, payload_digest, block_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [id, studioId, sessionId, key, "0".repeat(32), blockId],
  );
  return id;
}

/** The lookup A1b performs, as a given signed-in user. */
async function lookupAs(userId: string, sessionId: string, key: string) {
  return asUser(userId, async (query) => {
    const r = await query(
      `select block_id from public.treatment_area_create_claims
        where session_id = $1 and idempotency_key = $2`,
      [sessionId, key],
    );
    return r.rows as Array<{ block_id: string }>;
  });
}

describe("a create claim is visible only inside its own studio", () => {
  it("the studio's own member sees the claim, and another studio's sees NOTHING", async () => {
    const a = await seedStudio("claim-a");
    const b = await seedStudio("claim-b");
    const sessionA = await seedSession(a);
    const KEY = randomUUID();
    await seedClaim(a.studioId, sessionA.sessionId, sessionA.blockId, KEY);

    // THE OWNER OF THE STUDIO THAT OWNS THE SESSION.
    const own = await lookupAs(a.userId, sessionA.sessionId, KEY);
    expect(own, "the studio's own owner could not see its claim").toHaveLength(1);
    expect(own[0]!.block_id).toBe(sessionA.blockId);

    // THE POLICY IS `is_studio_member`, NOT "owner", so a non-owner member of
    // the same studio sees it too. Asserted because the policy's scope is the
    // thing under test, not a convenient subset of it.
    const member = await seedMember(a, "claim-a-member");
    const asMember = await lookupAs(member.userId, sessionA.sessionId, KEY);
    expect(asMember, "a member of the owning studio could not see it").toHaveLength(1);

    // ANOTHER STUDIO, HOLDING THE EXACT SESSION ID AND KEY. This is the whole
    // point of the file: with the session id and the key in hand — both of
    // which travel in a URL — a signed-in practitioner elsewhere must learn
    // nothing.
    const foreign = await lookupAs(b.userId, sessionA.sessionId, KEY);
    expect(
      foreign,
      "ANOTHER STUDIO SAW THIS CLAIM — the lookup is a cross-studio oracle",
    ).toHaveLength(0);
  });

  it("CONTROL: that studio CAN see its own claim, so the denial is scoping and not blindness", async () => {
    // Without this, the assertion above would also pass if the policy denied
    // everything — which would break A1b rather than secure it.
    const b = await seedStudio("claim-b-own");
    const sessionB = await seedSession(b);
    const KEY = randomUUID();
    await seedClaim(b.studioId, sessionB.sessionId, sessionB.blockId, KEY);

    const own = await lookupAs(b.userId, sessionB.sessionId, KEY);
    expect(own).toHaveLength(1);
  });

  it("an absent key reads as NO ROWS, not as an error", async () => {
    // A1b distinguishes "no claim" from "could not check", and the first of
    // those has to be an ordinary empty result for that distinction to mean
    // anything.
    const a = await seedStudio("claim-absent");
    const sessionA = await seedSession(a);
    const rows = await lookupAs(a.userId, sessionA.sessionId, randomUUID());
    expect(rows).toHaveLength(0);
  });

  it("anon sees nothing at all", async () => {
    const a = await seedStudio("claim-anon");
    const sessionA = await seedSession(a);
    const KEY = randomUUID();
    await seedClaim(a.studioId, sessionA.sessionId, sessionA.blockId, KEY);

    const rows = await asRole("anon", async (query) => {
      const r = await query(
        `select block_id from public.treatment_area_create_claims
          where session_id = $1 and idempotency_key = $2`,
        [sessionA.sessionId, KEY],
      );
      return r.rows;
    }).catch(() => "refused" as const);
    // Either a privilege refusal or an empty result is correct; what must not
    // happen is a row.
    if (rows !== "refused") expect(rows).toHaveLength(0);
  });

  it("and the READ grant did not widen WRITES — direct DML stays refused", async () => {
    // 0223 revokes all DML from every runtime role: the command is the only
    // writer. A1b adds a read, and this pins that it added only a read, so a
    // caller cannot forge a claim and have a later reload answered with
    // someone else's area.
    const a = await seedStudio("claim-dml");
    const sessionA = await seedSession(a);
    const KEY = randomUUID();
    await seedClaim(a.studioId, sessionA.sessionId, sessionA.blockId, KEY);

    for (const [label, sql, params] of [
      [
        "insert",
        `insert into public.treatment_area_create_claims
           (studio_id, session_id, idempotency_key, payload_digest, block_id)
         values ($1, $2, $3, $4, $5)`,
        [a.studioId, sessionA.sessionId, randomUUID(), "0".repeat(32), sessionA.blockId],
      ],
      [
        "update",
        `update public.treatment_area_create_claims set block_id = $1
          where session_id = $2`,
        [sessionA.blockId, sessionA.sessionId],
      ],
      [
        "delete",
        `delete from public.treatment_area_create_claims where session_id = $1`,
        [sessionA.sessionId],
      ],
    ] as Array<[string, string, unknown[]]>) {
      const outcome = await asUser(a.userId, (query) =>
        query(sql, params).then(
          () => "allowed" as const,
          () => "refused" as const,
        ),
      );
      expect(outcome, `${label} on a create claim was ALLOWED`).toBe("refused");
    }
  });
});
