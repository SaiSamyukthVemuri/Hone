import { afterAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { adminQuery, asRole, asUser, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// 0367: waitlist_invitation_booking_counts. A read-only, owner-only command that returns COUNTS of the invitations a studio sent in a period and how
// many became a booking, from the explicit invitation-to-appointment link. These tests prove the behaviour against a real database: who may call it,
// what it counts, what it will never count, how the period is bounded, and that it writes nothing. Fixtures are run-unique (seedStudio mints random
// ids), never cleaned up, so the suite is safe to re-run on one stack.

afterAll(async () => {
  await closePool();
});

const CALL = `select * from public.waitlist_invitation_booking_counts($1, $2::timestamptz, $3::timestamptz)`;
const hex64 = () => randomBytes(32).toString("hex");

type Counts = {
  invitations_total: number;
  people_invited: number;
  booked_linked_live: number;
  booked_then_cancelled: number;
  converted_unlinked: number;
};

const countsAs = (userId: string, studioId: string, from: string | null = null, to: string | null = null) =>
  asUser(userId, (q) => q(CALL, [studioId, from, to])).then((r) => r.rows[0] as Counts);

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "NO_ERROR";
  } catch (e) {
    return (e as { code?: string }).code ?? "UNKNOWN";
  }
}

let seq = 0;
async function entry(studioId: string, status = "waiting"): Promise<string> {
  seq += 1;
  const id = randomUUID();
  await adminQuery(
    `insert into public.new_client_waitlist_entries (id, studio_id, name, email, phone, status, source, joined_at, joined_at_provenance)
     values ($1, $2, 'Fixture Person', $3, $4, $5, 'public_booking', now() - interval '60 days', 'form')`,
    [id, studioId, `f${seq}-${id.slice(0, 8)}@example.com`, `+1647${String(1000000 + seq)}`, status],
  );
  return id;
}

type Stamp = "none" | "redeemed" | "declined" | "expired" | "released";
/** One invitation, issued at `issuedAt` (an ISO instant). The insert trigger stamps issued_at = now(), so the instant is moved afterwards as the table owner. */
async function invitation(s: SeededStudio, entryId: string, issuedAt: string, stamp: Stamp = "none"): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.new_client_waitlist_invitations (id, studio_id, entry_id, token_hash, expires_at, issued_by_practitioner_id)
     values ($1, $2, $3, $4, now() + interval '2 days', $5)`,
    [id, s.studioId, entryId, hex64(), s.practitionerId],
  );
  await adminQuery(`alter table public.new_client_waitlist_invitations disable trigger new_client_waitlist_invitations_append_only`);
  try {
    await adminQuery(
      `update public.new_client_waitlist_invitations
          set issued_at = $2::timestamptz, expires_at = $2::timestamptz + interval '2 days',
              redeemed_at = case when $3 = 'redeemed' then $2::timestamptz + interval '1 hour' end,
              declined_at = case when $3 = 'declined' then $2::timestamptz + interval '1 hour' end,
              expired_at  = case when $3 = 'expired'  then $2::timestamptz + interval '3 days' end,
              released_at = case when $3 = 'released' then $2::timestamptz + interval '1 hour' end
        where id = $1`,
      [id, issuedAt, stamp],
    );
  } finally {
    await adminQuery(`alter table public.new_client_waitlist_invitations enable trigger new_client_waitlist_invitations_append_only`);
  }
  return id;
}

let dayN = 0;
async function appointment(s: SeededStudio, status: "confirmed" | "cancelled" | "completed" | "no_show"): Promise<string> {
  dayN += 1;
  const start = new Date(Date.UTC(2031, 0, 1) + dayN * 86_400_000).toISOString();
  const end = new Date(Date.UTC(2031, 0, 1) + dayN * 86_400_000 + 3_600_000).toISOString();
  const r = await adminQuery(
    `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
     values (gen_random_uuid(), $1, $2, $3, $4::timestamptz, $5::timestamptz, 60, $6, $7) returning id`,
    [s.studioId, s.practitionerId, s.clientId, start, end, status, hex64()],
  );
  return r.rows[0].id as string;
}
const link = (s: SeededStudio, invitationId: string, appointmentId: string) =>
  adminQuery(`insert into public.waitlist_invitation_bookings (invitation_id, studio_id, appointment_id) values ($1, $2, $3)`, [invitationId, s.studioId, appointmentId]);

const T0 = "2031-06-10T12:00:00.000Z";
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();

describe("the owner gets counts, and each figure counts only what it says", () => {
  it("counts invitations, distinct people, linked live bookings, linked cancelled bookings and unlinked conversions", async () => {
    const s = await seedStudio("cnt-a");
    const a = await entry(s.studioId, "converted");
    const b = await entry(s.studioId, "converted");
    const c = await entry(s.studioId, "converted");
    const d = await entry(s.studioId, "invited");
    const e = await entry(s.studioId, "waiting");
    const f = await entry(s.studioId, "invited");

    await invitation(s, a, at(-72), "expired"); // person A's first invitation: expired, no booking
    const aLive = await invitation(s, a, at(0), "redeemed"); // person A's second: redeemed and linked, appointment live
    await link(s, aLive, await appointment(s, "confirmed"));
    const bCancelled = await invitation(s, b, at(1), "redeemed"); // person B: linked, then the appointment was cancelled
    await link(s, bCancelled, await appointment(s, "cancelled"));
    await invitation(s, c, at(2), "redeemed"); // person C: entry converted, redeemed, NO link row
    await invitation(s, d, at(3), "redeemed"); // person D: redeemed but the entry is not converted: never a booking
    await invitation(s, e, at(4), "declined");
    await invitation(s, f, at(5), "none"); // still open

    const r = await countsAs(s.userId, s.studioId);
    expect(r).toEqual({
      invitations_total: 7,
      people_invited: 6,
      booked_linked_live: 1,
      booked_then_cancelled: 1,
      converted_unlinked: 1,
    });
  });

  it("a completed or no-show appointment behind a link is still a booking that was kept, not a cancellation", async () => {
    const s = await seedStudio("cnt-status");
    for (const st of ["completed", "no_show", "confirmed"] as const) {
      const e = await entry(s.studioId, "converted");
      const i = await invitation(s, e, at(0), "redeemed");
      await link(s, i, await appointment(s, st));
    }
    const r = await countsAs(s.userId, s.studioId);
    expect(r.booked_linked_live).toBe(3);
    expect(r.booked_then_cancelled).toBe(0);
  });

  it("a booking with NO link is never counted as booked: it is only the unlinked figure, and only when the entry is converted", async () => {
    const s = await seedStudio("cnt-unlinked");
    const conv = await entry(s.studioId, "converted");
    await invitation(s, conv, at(0), "redeemed");
    const notConv = await entry(s.studioId, "invited");
    await invitation(s, notConv, at(1), "redeemed");
    const open = await entry(s.studioId, "converted");
    await invitation(s, open, at(2), "none"); // not redeemed: cannot be an unlinked conversion of this invitation
    const r = await countsAs(s.userId, s.studioId);
    expect(r.booked_linked_live).toBe(0);
    expect(r.booked_then_cancelled).toBe(0);
    expect(r.converted_unlinked).toBe(1);
  });

  it("one person with several invitations is one person and several invitations", async () => {
    const s = await seedStudio("cnt-people");
    const p = await entry(s.studioId, "waiting");
    await invitation(s, p, at(0), "expired");
    await invitation(s, p, at(1), "released");
    await invitation(s, p, at(2), "none");
    const r = await countsAs(s.userId, s.studioId);
    expect(r.invitations_total).toBe(3);
    expect(r.people_invited).toBe(1);
  });

  it("an empty studio is zeros, not an error", async () => {
    const s = await seedStudio("cnt-empty");
    expect(await countsAs(s.userId, s.studioId)).toEqual({
      invitations_total: 0,
      people_invited: 0,
      booked_linked_live: 0,
      booked_then_cancelled: 0,
      converted_unlinked: 0,
    });
  });

  it("another studio's invitations and bookings are never counted", async () => {
    const mine = await seedStudio("cnt-mine");
    const other = await seedStudio("cnt-other");
    const oe = await entry(other.studioId, "converted");
    const oi = await invitation(other, oe, at(0), "redeemed");
    await link(other, oi, await appointment(other, "confirmed"));
    expect((await countsAs(mine.userId, mine.studioId)).invitations_total).toBe(0);
    expect((await countsAs(other.userId, other.studioId)).booked_linked_live).toBe(1);
  });
});

describe("the period is the invitations SENT in it: start inclusive, end exclusive, either end may be open", () => {
  it("includes an invitation issued exactly at the start, excludes one issued exactly at the end", async () => {
    const s = await seedStudio("per-a");
    const before = await entry(s.studioId);
    const onStart = await entry(s.studioId);
    const inside = await entry(s.studioId);
    const onEnd = await entry(s.studioId);
    await invitation(s, before, at(-1));
    await invitation(s, onStart, at(0));
    await invitation(s, inside, at(1));
    await invitation(s, onEnd, at(2));
    const r = await countsAs(s.userId, s.studioId, at(0), at(2));
    expect(r.invitations_total).toBe(2); // onStart and inside; not before, not onEnd
    expect(r.people_invited).toBe(2);
  });

  it("an open start counts everything before the end; an open end counts everything from the start; both open is everything", async () => {
    const s = await seedStudio("per-b");
    for (const h of [-10, 0, 10]) await invitation(s, await entry(s.studioId), at(h));
    expect((await countsAs(s.userId, s.studioId, null, at(0))).invitations_total).toBe(1);
    expect((await countsAs(s.userId, s.studioId, at(0), null)).invitations_total).toBe(2);
    expect((await countsAs(s.userId, s.studioId, null, null)).invitations_total).toBe(3);
  });

  it("the booking figures describe the SAME cohort: a booking is counted for the period its invitation was sent, not when it was booked", async () => {
    const s = await seedStudio("per-c");
    const e = await entry(s.studioId, "converted");
    const i = await invitation(s, e, at(-5), "redeemed");
    await link(s, i, await appointment(s, "confirmed"));
    expect((await countsAs(s.userId, s.studioId, at(0), at(10))).booked_linked_live).toBe(0);
    expect((await countsAs(s.userId, s.studioId, at(-10), at(0))).booked_linked_live).toBe(1);
  });

  it("an empty or backwards window is refused with a plain error, never a guess", async () => {
    const s = await seedStudio("per-d");
    expect(await codeOf(() => countsAs(s.userId, s.studioId, at(5), at(5)))).toBe("22023");
    expect(await codeOf(() => countsAs(s.userId, s.studioId, at(5), at(1)))).toBe("22023");
  });
});

describe("who may call it", () => {
  it("a non-owner member of the studio is refused with the one generic error", async () => {
    const s = await seedStudio("who-member");
    const memberUser = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [memberUser, `m-${memberUser.slice(0, 8)}@harness.local`]);
    await adminQuery(
      `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active) values (gen_random_uuid(), $1, $2, 'Member', $3, 'practitioner', true)`,
      [s.studioId, memberUser, `m-${memberUser.slice(0, 8)}@harness.local`],
    );
    expect(await codeOf(() => countsAs(memberUser, s.studioId))).toBe("42501");
  });

  it("an inactive owner is refused", async () => {
    const s = await seedStudio("who-inactive");
    await adminQuery(`update public.practitioners set active = false where id = $1`, [s.practitionerId]);
    expect(await codeOf(() => countsAs(s.userId, s.studioId))).toBe("42501");
  });

  it("the owner of ANOTHER studio is refused for this one, with the same error", async () => {
    const mine = await seedStudio("who-mine");
    const other = await seedStudio("who-other");
    expect(await codeOf(() => countsAs(other.userId, mine.studioId))).toBe("42501");
    let message = "";
    try {
      await countsAs(other.userId, mine.studioId);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("not allowed");
    expect(message).not.toContain(mine.studioId);
  });

  it("a signed-in user with no studio, an unknown studio id and a null studio id are refused", async () => {
    const s = await seedStudio("who-none");
    const stranger = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [stranger, `x-${stranger.slice(0, 8)}@harness.local`]);
    expect(await codeOf(() => countsAs(stranger, s.studioId))).toBe("42501");
    expect(await codeOf(() => countsAs(s.userId, randomUUID()))).toBe("42501");
    expect(await codeOf(() => asUser(s.userId, (q) => q(CALL, [null, null, null])))).toBe("42501");
  });

  it("anon and the service role cannot execute it at all", async () => {
    const s = await seedStudio("who-roles");
    expect(await codeOf(() => asRole("anon", (q) => q(CALL, [s.studioId, null, null])))).toBe("42501");
    expect(await codeOf(() => asRole("service_role", (q) => q(CALL, [s.studioId, null, null])))).toBe("42501");
  });

  it("an owner of TWO studios gets each studio's own counts for the studio asked about, and is never given a studio picked for them", async () => {
    const a = await seedStudio("two-a");
    const b = await seedStudio("two-b");
    // The same user owns both studios.
    await adminQuery(
      `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active) values (gen_random_uuid(), $1, $2, 'Both', $3, 'owner', true)`,
      [b.studioId, a.userId, `both-${a.userId.slice(0, 8)}@harness.local`],
    );
    await invitation(a, await entry(a.studioId), at(0));
    for (let i = 0; i < 3; i++) await invitation(b, await entry(b.studioId), at(i));
    expect((await countsAs(a.userId, a.studioId)).invitations_total).toBe(1);
    expect((await countsAs(a.userId, b.studioId)).invitations_total).toBe(3);
    // There is no default studio: the studio is an argument, and a studio they do not own is refused.
    const c = await seedStudio("two-c");
    expect(await codeOf(() => countsAs(a.userId, c.studioId))).toBe("42501");
  });
});

describe("privileges and read-only behaviour", () => {
  const FN = "public.waitlist_invitation_booking_counts(uuid, timestamptz, timestamptz)";

  it("EXECUTE is held by authenticated only: not public, not anon, not service_role", async () => {
    const r = await adminQuery(
      `select has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as authenticated,
              has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_role`,
      [FN],
    );
    expect(r.rows[0]).toEqual({ anon: false, authenticated: true, service_role: false });
    const pub = await adminQuery(
      `select count(*)::int as n from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(p.proacl) a where p.oid = $1::regprocedure and a.grantee = 0`,
      [FN],
    );
    expect(pub.rows[0].n).toBe(0);
  });

  it("is a stable security definer function with a pinned search_path", async () => {
    const r = await adminQuery(
      `select p.provolatile, p.prosecdef, p.proconfig from pg_catalog.pg_proc p where p.oid = $1::regprocedure`,
      [FN],
    );
    expect(r.rows[0].provolatile).toBe("s");
    expect(r.rows[0].prosecdef).toBe(true);
    expect(r.rows[0].proconfig).toContain("search_path=pg_catalog, pg_temp");
  });

  it("writes nothing: the three tables are unchanged by a call", async () => {
    const s = await seedStudio("ro");
    const e = await entry(s.studioId, "converted");
    const i = await invitation(s, e, at(0), "redeemed");
    await link(s, i, await appointment(s, "confirmed"));
    const snapshot = async () =>
      (
        await adminQuery(
          `select (select count(*) from public.new_client_waitlist_invitations where studio_id = $1)::int as inv,
                  (select count(*) from public.waitlist_invitation_bookings where studio_id = $1)::int as links,
                  (select count(*) from public.appointments where studio_id = $1)::int as appts,
                  (select md5(string_agg(i.id::text || coalesce(i.redeemed_at::text, ''), ',' order by i.id)) from public.new_client_waitlist_invitations i where i.studio_id = $1) as digest`,
          [s.studioId],
        )
      ).rows[0];
    const before = await snapshot();
    await countsAs(s.userId, s.studioId);
    await countsAs(s.userId, s.studioId, at(-1), at(1));
    expect(await snapshot()).toEqual(before);
  });

  it("returns counts only: five integer columns and nothing that names a person", async () => {
    const s = await seedStudio("shape");
    await invitation(s, await entry(s.studioId), at(0));
    const r = await asUser(s.userId, (q) => q(CALL, [s.studioId, null, null]));
    expect(r.rows).toHaveLength(1);
    expect(Object.keys(r.rows[0]).sort()).toEqual(["booked_linked_live", "booked_then_cancelled", "converted_unlinked", "invitations_total", "people_invited"]);
    for (const v of Object.values(r.rows[0])) expect(typeof v).toBe("number");
  });
});
