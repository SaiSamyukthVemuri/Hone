// PRACTITIONER IDENTITY + MUTATION BOUNDARY, behavioural suite for 0178.
//
// WHAT THIS FILE HAS TO PROVE, and why each half is necessary:
//
//   SAFE PATH EXISTS      a practitioner can still manage their own
//                         preferences, including the non-owners for whom the
//                         old owner-gated RLS silently did nothing;
//   ESCAPE HATCH IS GONE  no runtime role can reach the practitioner table
//                         directly any more, by DML *or* by TRUNCATE.
//
// Proving only one half is how a boundary migration passes review and still
// leaves the old door open.
//
// THREE TRAPS THIS SUITE IS BUILT AROUND
//
// 1. A ZERO-ROW WRITE LOOKS LIKE SUCCESS. Under RLS an UPDATE that matches no
//    row returns rowCount 0 with NO error, indistinguishable from a refusal.
//    That is the exact bug 0178 fixes, so the privilege probes below use
//    predicates matching NO row: with the privilege still granted the statement
//    SUCCEEDS and the test fails. A silent pass is impossible.
//
// 2. `limit 1` OVER A GLOBAL MEMBERSHIP SET IS PLANNER-DEPENDENT. The
//    multi-studio cases seed ONE auth user into TWO studios and assert the
//    resolved actor per studio. Under the old helper the answer was whichever
//    row Postgres returned first, so these cases would be flaky rather than
//    cleanly red, which is why they assert the *specific* practitioner id.
//
// 3. NON-DISCLOSURE. A caller who is not a member of the resource's studio must
//    be refused the same way a caller naming a nonexistent resource is refused.
//    The treatment-image cases assert the SHAPE of the refusal, not just that it
//    refused.

import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

afterAll(async () => {
  await closePool();
});

const PALETTE_OK = "teal";

/**
 * A RUN-UNIQUE feed-token hash. `calendar_feed_token_hash` carries a UNIQUE
 * constraint, so a constant literal collides the second time this suite runs
 * against the same database, fixtures isolate by identity here, never by
 * cleanup.
 */
const feedHash = () => createHash("sha256").update(randomUUID()).digest("hex");

/** Add an ACTIVE membership for an EXISTING auth user in another studio. */
async function addMembership(
  studio: SeededStudio,
  userId: string,
  role: "owner" | "practitioner" = "practitioner",
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active)
     values ($1, $2, $3, $4, $5, $6, true)`,
    [id, studio.studioId, userId, `Multi ${role}`, `multi-${id.slice(0, 8)}@harness.local`, role],
  );
  return id;
}

async function row(id: string) {
  const r = await adminQuery(
    `select id, studio_id, user_id, display_name, email, role, active,
            color, calendar_feed_token_hash, default_machine_frequency
       from public.practitioners where id = $1`,
    [id],
  );
  return r.rows[0];
}

/** Call an own-preference command AS a real authenticated user. */
async function callAs(
  userId: string,
  sql: string,
  params: unknown[],
): Promise<unknown> {
  return asUser(userId, async (q) => (await q(sql, params)).rows[0]);
}

const updateProfile = (userId: string, studioId: string, name: string | null, color: string | null) =>
  callAs(userId, `select public.update_own_practitioner_profile($1,$2,$3) as id`, [
    studioId,
    name,
    color,
  ]) as Promise<{ id: string | null }>;

const setFeedHash = (userId: string, studioId: string, hash: string | null) =>
  callAs(userId, `select public.set_own_calendar_feed_token_hash($1,$2) as id`, [
    studioId,
    hash,
  ]) as Promise<{ id: string | null }>;

const setFrequency = (userId: string, studioId: string, freq: string | null) =>
  callAs(userId, `select public.set_own_default_machine_frequency($1,$2) as id`, [
    studioId,
    freq,
  ]) as Promise<{ id: string | null }>;

// ---------------------------------------------------------------------------
// P, PRIVILEGE CLOSURE. The escape hatch must be gone.
// ---------------------------------------------------------------------------
describe("0178: public.practitioners is SELECT-only for runtime roles", () => {
  it.each(["anon", "authenticated", "service_role"] as const)(
    "%s retains SELECT",
    async (role) => {
      const r = await asRole(role, (q) =>
        q(`select has_table_privilege($1,'public.practitioners','SELECT') ok`, [role]),
      );
      expect(r.rows[0].ok).toBe(true);
    },
  );

  it.each(["anon", "authenticated", "service_role"] as const)(
    "%s holds NOTHING but SELECT, every PostgreSQL 17 table privilege enumerated",
    async (role) => {
      // MAINTAIN IS HERE BECAUSE IT WAS MISSED ONCE. An earlier revision revoked
      // a hand-written list of verbs; this database is PostgreSQL 17, which adds
      // MAINTAIN (VACUUM/ANALYZE/CLUSTER/REINDEX/REFRESH/LOCK), and it was held
      // by all three roles before 0178 and SURVIVED that list. The migration now
      // REVOKEs ALL and grants back only SELECT, and this test enumerates the
      // full PG17 set so a future privilege cannot slip through the same gap.
      const r = await asRole(role, (q) =>
        q(
          `select
             has_table_privilege($1,'public.practitioners','SELECT')     sel,
             has_table_privilege($1,'public.practitioners','INSERT')     ins,
             has_table_privilege($1,'public.practitioners','UPDATE')     upd,
             has_table_privilege($1,'public.practitioners','DELETE')     del,
             has_table_privilege($1,'public.practitioners','TRUNCATE')   trunc,
             has_table_privilege($1,'public.practitioners','REFERENCES') refs,
             has_table_privilege($1,'public.practitioners','TRIGGER')    trig,
             has_table_privilege($1,'public.practitioners','MAINTAIN')   maint,
             -- A table-level revoke does not by itself prove no NARROWER
             -- column-level write grant survived.
             has_any_column_privilege($1,'public.practitioners','INSERT')     col_ins,
             has_any_column_privilege($1,'public.practitioners','UPDATE')     col_upd,
             has_any_column_privilege($1,'public.practitioners','REFERENCES') col_refs`,
          [role],
        ),
      );
      expect({ ...r.rows[0] }).toEqual({
        sel: true,
        ins: false, upd: false, del: false, trunc: false, refs: false, trig: false,
        maint: false,
        col_ins: false, col_upd: false, col_refs: false,
      });
    },
  );

  it("PUBLIC holds no practitioner privilege at all", async () => {
    // PUBLIC is a separate principal from the three API roles; a grant to PUBLIC
    // would reach every one of them regardless of their own revokes.
    const r = await adminQuery(
      `select
         has_table_privilege('public','public.practitioners','SELECT')   sel,
         has_table_privilege('public','public.practitioners','INSERT')   ins,
         has_table_privilege('public','public.practitioners','UPDATE')   upd,
         has_table_privilege('public','public.practitioners','MAINTAIN') maint`,
    );
    expect({ ...r.rows[0] }).toEqual({ sel: false, ins: false, upd: false, maint: false });
  });

  it("a REAL authenticated UPDATE is denied by PRIVILEGE, not silently filtered", async () => {
    // The predicate matches NO row on purpose. If UPDATE were still granted this
    // statement would SUCCEED with rowCount 0 and the test would pass vacuously.
    const studio = await seedStudio("p0178-priv");
    await expect(
      asUser(studio.userId, (q) =>
        q(`update public.practitioners set display_name = 'x' where id = $1`, [
          randomUUID(),
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("a REAL authenticated INSERT and TRUNCATE are denied", async () => {
    const studio = await seedStudio("p0178-priv2");
    await expect(
      asUser(studio.userId, (q) =>
        q(
          `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
           values ($1,$2,$3,'X','x@harness.local','owner',true)`,
          [randomUUID(), studio.studioId, studio.userId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    // Transactional and rolled back by asRole; disposable local DB only.
    await expect(
      asRole("authenticated", (q) => q(`truncate table public.practitioners`)),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("the obsolete owner mutation POLICIES are gone, the read policy remains", async () => {
    const r = await adminQuery(
      `select policyname, cmd from pg_policies
        where schemaname='public' and tablename='practitioners' order by policyname`,
    );
    const names = r.rows.map((x: { policyname: string }) => x.policyname);
    expect(names).not.toContain("practitioners: owners insert");
    expect(names).not.toContain("practitioners: owners update");
    expect(names).toContain("practitioners: members read");
  });

  it("no runtime role regains a verb through role membership", async () => {
    const r = await adminQuery(
      `select r.rolname, r.rolinherit,
              coalesce(string_agg(m.rolname, ','), '') member_of
         from pg_roles r
         left join pg_auth_members am on am.member = r.oid
         left join pg_roles m on m.oid = am.roleid
        where r.rolname in ('anon','authenticated','service_role')
        group by r.rolname, r.rolinherit`,
    );
    for (const x of r.rows) expect(x.member_of, `${x.rolname} inherits`).toBe("");
  });
});

// ---------------------------------------------------------------------------
// S, OWN PREFERENCES. The safe path must exist, for NON-OWNERS especially.
// ---------------------------------------------------------------------------
describe("0178: a practitioner manages their OWN preferences", () => {
  it("an ACTIVE NON-OWNER can set name, colour, feed hash and frequency", async () => {
    // This is the bug fix: every one of these was a silent zero-row write for a
    // non-owner before 0178.
    const studio = await seedStudio("p0178-self");
    const member = await seedMember(studio, "p0178-m");

    expect((await updateProfile(member.userId, studio.studioId, "New Name", null)).id)
      .toBe(member.practitionerId);
    expect((await updateProfile(member.userId, studio.studioId, null, PALETTE_OK)).id)
      .toBe(member.practitionerId);
    const hash = feedHash();
    expect((await setFeedHash(member.userId, studio.studioId, hash)).id)
      .toBe(member.practitionerId);
    expect((await setFrequency(member.userId, studio.studioId, "27.12 MHz")).id)
      .toBe(member.practitionerId);

    const after = await row(member.practitionerId);
    expect(after.display_name).toBe("New Name");
    expect(after.color).toBe(PALETTE_OK);
    expect(after.calendar_feed_token_hash).toBe(hash);
    expect(after.default_machine_frequency).toBe("27.12 MHz");
  });

  it("NULL means UNCHANGED for name/colour, and CLEARS for feed hash", async () => {
    const studio = await seedStudio("p0178-null");
    const m = await seedMember(studio, "p0178-null-m");
    await updateProfile(m.userId, studio.studioId, "Keep Me", PALETTE_OK);
    await setFeedHash(m.userId, studio.studioId, feedHash());

    await updateProfile(m.userId, studio.studioId, null, null);
    let after = await row(m.practitionerId);
    expect(after.display_name).toBe("Keep Me");
    expect(after.color).toBe(PALETTE_OK);

    await setFeedHash(m.userId, studio.studioId, null);
    after = await row(m.practitionerId);
    expect(after.calendar_feed_token_hash).toBeNull();
  });

  it("authority fields are UNREACHABLE: they are not parameters at all", async () => {
    const studio = await seedStudio("p0178-auth");
    const m = await seedMember(studio, "p0178-auth-m");
    const before = await row(m.practitionerId);

    await updateProfile(m.userId, studio.studioId, "Renamed", PALETTE_OK);
    const after = await row(m.practitionerId);

    // id / studio_id / user_id / role / active / email survive verbatim. There
    // is no field-name parameter, so no future column becomes writable either.
    expect(after.id).toBe(before.id);
    expect(after.studio_id).toBe(before.studio_id);
    expect(after.user_id).toBe(before.user_id);
    expect(after.role).toBe("practitioner");
    expect(after.active).toBe(true);
    expect(after.email).toBe(before.email);
  });

  it("cannot self-promote to owner, and cannot deactivate themselves", async () => {
    const studio = await seedStudio("p0178-promote");
    const m = await seedMember(studio, "p0178-promote-m");
    // There is no command that accepts a role or an active flag; the only
    // remaining direct path is table DML, which is now a privilege error.
    await expect(
      asUser(m.userId, (q) =>
        q(`update public.practitioners set role='owner' where id=$1`, [m.practitionerId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect((await row(m.practitionerId)).role).toBe("practitioner");
  });

  it("cannot touch a same-studio colleague, and cannot name one", async () => {
    const studio = await seedStudio("p0178-colleague");
    const a = await seedMember(studio, "p0178-a");
    const b = await seedMember(studio, "p0178-b");
    const bBefore = await row(b.practitionerId);

    // A's command resolves to A's OWN row, B is unreachable because no
    // practitioner id crosses the boundary.
    expect((await updateProfile(a.userId, studio.studioId, "Only A", null)).id)
      .toBe(a.practitionerId);
    expect((await row(b.practitionerId)).display_name).toBe(bBefore.display_name);
  });

  it("an INACTIVE membership is refused", async () => {
    const studio = await seedStudio("p0178-inactive");
    const m = await seedMember(studio, "p0178-inactive-m");
    await adminQuery(`update public.practitioners set active=false where id=$1`, [
      m.practitionerId,
    ]);
    expect((await updateProfile(m.userId, studio.studioId, "Nope", null)).id).toBeNull();
    expect((await row(m.practitionerId)).display_name).not.toBe("Nope");
  });

  it("a forged / cross-studio studio id resolves to NULL and mutates nothing", async () => {
    const studio = await seedStudio("p0178-forge");
    const other = await seedStudio("p0178-forge-other");
    const m = await seedMember(studio, "p0178-forge-m");
    const before = await row(m.practitionerId);

    expect((await updateProfile(m.userId, other.studioId, "Forged", null)).id).toBeNull();
    expect((await updateProfile(m.userId, randomUUID(), "Forged", null)).id).toBeNull();
    expect((await row(m.practitionerId)).display_name).toBe(before.display_name);
  });

  it("accepts any well-formed colour token, the palette stays canonical in CODE", async () => {
    // `lib/practitioner-colors.ts` says adding a colour is a pure code change
    // needing no migration, so SQL must NOT enumerate the eight current tokens.
    // A hypothetical future token therefore has to work here today.
    const studio = await seedStudio("p0178-colour");
    const m = await seedMember(studio, "p0178-colour-m");
    expect((await updateProfile(m.userId, studio.studioId, null, PALETTE_OK)).id)
      .toBe(m.practitionerId);
    expect((await updateProfile(m.userId, studio.studioId, null, "chartreuse")).id)
      .toBe(m.practitionerId);
    expect((await row(m.practitionerId)).color).toBe("chartreuse");
  });

  it("still rejects a malformed or oversized colour token, a blank name and bad enums", async () => {
    // The generic shape backstop: length and character class only.
    const studio = await seedStudio("p0178-validate");
    const m = await seedMember(studio, "p0178-validate-m");
    await expect(updateProfile(m.userId, studio.studioId, null, "Not A Token!")).rejects.toThrow();
    await expect(updateProfile(m.userId, studio.studioId, null, "x".repeat(64))).rejects.toThrow();
    await expect(updateProfile(m.userId, studio.studioId, "   ", null)).rejects.toThrow();
    await expect(setFrequency(m.userId, studio.studioId, "42 MHz")).rejects.toThrow();
    await expect(setFeedHash(m.userId, studio.studioId, "not-a-hash")).rejects.toThrow();
  });

  it("imposes NO length ceiling on display_name, the column is `text not null`", async () => {
    // An earlier revision invented a 120-character limit. This migration moves an
    // existing behaviour behind a boundary; narrowing the accepted value domain
    // is a separate product decision needing UI and DB agreement.
    const studio = await seedStudio("p0178-longname");
    const m = await seedMember(studio, "p0178-longname-m");
    const long = "N".repeat(300);
    expect((await updateProfile(m.userId, studio.studioId, long, null)).id).toBe(
      m.practitionerId,
    );
    expect((await row(m.practitionerId)).display_name).toBe(long);
  });
});

// ---------------------------------------------------------------------------
// M, MULTI-STUDIO. One human, two memberships, deterministic per studio.
// ---------------------------------------------------------------------------
describe("0178: multi-studio membership is deterministic", () => {
  it("the SAME auth user resolves to the correct practitioner PER STUDIO", async () => {
    const a = await seedStudio("p0178-multi-a");
    const b = await seedStudio("p0178-multi-b");
    const inB = await addMembership(b, a.userId); // one human, two studios

    expect((await updateProfile(a.userId, a.studioId, "Name In A", null)).id)
      .toBe(a.practitionerId);
    expect((await updateProfile(a.userId, b.studioId, "Name In B", null)).id)
      .toBe(inB);

    // Each write landed on exactly one membership; neither leaked into the other.
    expect((await row(a.practitionerId)).display_name).toBe("Name In A");
    expect((await row(inB)).display_name).toBe("Name In B");
  });

  it("multiple OWNERS remain valid: no singleton-owner assumption", async () => {
    const studio = await seedStudio("p0178-owners");
    const second = await seedMember(studio, "p0178-owner2");
    await adminQuery(`update public.practitioners set role='owner' where id=$1`, [
      second.practitionerId,
    ]);
    // Both owners can manage their own preferences independently.
    expect((await updateProfile(studio.userId, studio.studioId, "Owner One", null)).id)
      .toBe(studio.practitionerId);
    expect((await updateProfile(second.userId, studio.studioId, "Owner Two", null)).id)
      .toBe(second.practitionerId);
    const r = await adminQuery(
      `select count(*)::int n from public.practitioners where studio_id=$1 and role='owner' and active`,
      [studio.studioId],
    );
    expect(r.rows[0].n).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T, TEAM LIFECYCLE. Unchanged by 0178; proved not broken by the revoke.
// ---------------------------------------------------------------------------
describe("0178: the governed team lifecycle still works after the revoke", () => {
  const setActive = (studioId: string, actor: string, target: string, active: boolean) =>
    adminQuery(`select public.set_practitioner_active_locked($1,$2,$3,$4) code`, [
      studioId,
      actor,
      target,
      active,
    ]);

  it("owner A and owner B can BOTH deactivate a member; a non-owner cannot", async () => {
    const studio = await seedStudio("p0178-team");
    const ownerB = await seedMember(studio, "p0178-team-ob");
    await adminQuery(`update public.practitioners set role='owner' where id=$1`, [
      ownerB.practitionerId,
    ]);
    const t1 = await seedMember(studio, "p0178-team-t1");
    const t2 = await seedMember(studio, "p0178-team-t2");
    const plain = await seedMember(studio, "p0178-team-p");

    expect((await setActive(studio.studioId, studio.practitionerId, t1.practitionerId, false)).rows[0].code).toBe("ok");
    expect((await setActive(studio.studioId, ownerB.practitionerId, t2.practitionerId, false)).rows[0].code).toBe("ok");
    const denied = await setActive(studio.studioId, plain.practitionerId, t1.practitionerId, true);
    expect(denied.rows[0].code).not.toBe("ok");
  });

  it("an owner of studio A cannot act on studio B's practitioner", async () => {
    const a = await seedStudio("p0178-team-xa");
    const b = await seedStudio("p0178-team-xb");
    const target = await seedMember(b, "p0178-team-xt");
    const r = await setActive(b.studioId, a.practitionerId, target.practitionerId, false);
    expect(r.rows[0].code).not.toBe("ok");
    expect((await row(target.practitionerId)).active).toBe(true);
  });
});
