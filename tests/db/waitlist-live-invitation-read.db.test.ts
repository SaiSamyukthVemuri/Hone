// 0198 — WAIT-LIVE-READ-01. The practitioner can evaluate the database's own
// liveness predicate.
//
// `one_live_per_entry` defines a live invitation as
//   redeemed_at IS NULL AND expired_at IS NULL
//   AND released_at IS NULL AND declined_at IS NULL
//
// An authenticated owner could read three of those four. `declined_at` was added
// by 0192 and granted to nobody, so the surface's (already correct) query raised
// 42501 and a DECLINED invitation was indistinguishable from a LIVE one.
//
// These cases prove the predicate now resolves, and — just as importantly — that
// nothing else became readable.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

let A: SeededStudio;
let B: SeededStudio;

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

async function seedEntry(s: SeededStudio): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into public.new_client_waitlist_entries
       (id, studio_id, name, email, status, claimed_at, claimed_by_practitioner_id, invited_at)
     values ($1,$2,'Prospect',$3,'invited', now(), $4, now())`,
    [id, s.studioId, `live-${id.slice(0, 8)}@harness.local`, s.practitionerId],
  );
  return id;
}

/** An invitation in a named lifecycle state. `live` closes nothing. */
async function seedInvitation(
  s: SeededStudio,
  entryId: string,
  state: "live" | "declined" | "redeemed" | "expired" | "released",
): Promise<string> {
  const id = randomUUID();
  const col = {
    live: null,
    declined: "declined_at",
    redeemed: "redeemed_at",
    expired: "expired_at",
    released: "released_at",
  }[state];
  await q(
    `insert into public.new_client_waitlist_invitations
       (id, studio_id, entry_id, token_hash, issued_at, expires_at, issued_by_practitioner_id
        ${col ? `, ${col}` : ""})
     values ($1,$2,$3,$4, now(), now() + interval '72 hours', $5
        ${col ? ", now()" : ""})`,
    [id, s.studioId, entryId, randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), s.practitionerId],
  );
  return id;
}

/** THE DATABASE'S OWN PREDICATE, run as the authenticated owner. */
const liveForEntry = (userId: string, entryId: string) =>
  asUser(userId, (query) =>
    query(
      `select id from public.new_client_waitlist_invitations
        where entry_id = $1
          and redeemed_at is null and expired_at is null
          and released_at is null and declined_at is null`,
      [entryId],
    ),
  );

beforeAll(async () => {
  A = await seedStudio("s6-live-a");
  B = await seedStudio("s6-live-b");
});
afterAll(async () => {
  await closePool();
});

describe("the owner can resolve the current cycle", () => {
  it("CASE 1 — one live invitation resolves to exactly that invitation", async () => {
    const entry = await seedEntry(A);
    const live = await seedInvitation(A, entry, "live");
    const r = await liveForEntry(A.userId, entry);
    expect(r.rows).toHaveLength(1);
    expect((r.rows[0] as { id: string }).id).toBe(live);
  });

  it("CASE 2 — declined A + live B: only B is current", async () => {
    const entry = await seedEntry(A);
    await seedInvitation(A, entry, "declined");
    const liveB = await seedInvitation(A, entry, "live");
    const r = await liveForEntry(A.userId, entry);
    expect(r.rows, "declined A leaked into the live set").toHaveLength(1);
    expect((r.rows[0] as { id: string }).id).toBe(liveB);
  });

  it("CASE 3 — declined A alone is NOT resurrected as current", async () => {
    const entry = await seedEntry(A);
    await seedInvitation(A, entry, "declined");
    const r = await liveForEntry(A.userId, entry);
    expect(r.rows).toHaveLength(0);
  });

  it("CASE 4 — a redeemed invitation never appears live", async () => {
    const entry = await seedEntry(A);
    await seedInvitation(A, entry, "redeemed");
    expect((await liveForEntry(A.userId, entry)).rows).toHaveLength(0);
  });

  it("CASE 5 — expired and released never appear live", async () => {
    for (const state of ["expired", "released"] as const) {
      const entry = await seedEntry(A);
      await seedInvitation(A, entry, state);
      expect((await liveForEntry(A.userId, entry)).rows, state).toHaveLength(0);
    }
  });

  it("CASE 6 — another studio's owner learns nothing", async () => {
    const entry = await seedEntry(A);
    await seedInvitation(A, entry, "live");
    const theirs = await liveForEntry(B.userId, entry);
    expect(theirs.rows, "cross-tenant read returned a row").toHaveLength(0);
  });
});

describe("nothing else became readable", () => {
  const entryOf = async () => {
    const e = await seedEntry(A);
    await seedInvitation(A, e, "live");
    return e;
  };

  for (const col of [
    "token_hash",
    "proof_challenge_hash",
    "proof_capability_hash",
    "proof_challenge_id",
    "proof_challenge_sent_to_hash",
    "scope_service_id",
    "scope_start_date",
    "scope_end_date",
    "scope_allowed_weekdays",
    "admission_round_id",
  ]) {
    it(`authenticated STILL cannot read ${col}`, async () => {
      await entryOf();
      await expect(
        asUser(A.userId, (query) =>
          query(`select ${col} from public.new_client_waitlist_invitations limit 1`),
        ),
        `${col} became readable`,
      ).rejects.toThrow();
    });
  }

  it("authenticated STILL cannot SELECT *", async () => {
    await entryOf();
    await expect(
      asUser(A.userId, (query) =>
        query(`select * from public.new_client_waitlist_invitations limit 1`),
      ),
    ).rejects.toThrow();
  });

  it("anon cannot read declined_at either", async () => {
    await entryOf();
    await expect(
      asRole("anon", (query) =>
        query(`select declined_at from public.new_client_waitlist_invitations limit 1`),
      ),
    ).rejects.toThrow();
  });

  it("the granted inventory is EXACTLY the twelve operational columns", async () => {
    const r = await q<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where table_schema='public' and table_name='new_client_waitlist_invitations'
          and grantee='authenticated' and privilege_type='SELECT'
        order by column_name`,
    );
    expect(r.map((x) => x.column_name)).toEqual([
      "declined_at",
      "delivery_disposition","delivery_recorded_at",
      "entry_id","expired_at","expires_at","id","issued_at",
      "issued_by_practitioner_id","redeemed_at","released_at","studio_id",
    ]);
  });

  it("anon and service_role hold NO column privilege on this table", async () => {
    const r = await q<{ n: number }>(
      `select count(*)::int as n from information_schema.column_privileges
        where table_schema='public' and table_name='new_client_waitlist_invitations'
          and grantee in ('anon','service_role')`,
    );
    expect(r[0]!.n).toBe(0);
  });
});
