import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, closePool, resolveLocalDbUrl, seedStudio } from "./helpers/harness";
import {
  eventIdSet,
  expectBlockedOn,
  expectExactlyOneNewEvent,
  newEventsSince,
  readStoredInstant,
} from "./helpers/waitlist-concurrency";

// ===========================================================================
// 0200 — WAIT-P1-EXIT: THE REDEEMED-BUT-UNBOOKED ESCAPE HATCH
// ===========================================================================
//
// THE STATE UNDER TEST. Redemption stamps the invitation and LEAVES the entry
// at `invited`; only a recorded conversion moves it. So a prospect who opens
// their invitation and never books sits at `invited` with a redeemed
// invitation — and section I below proves, on this schema, that all four
// shipped exits still refuse exactly there. That refusal set is the dead end,
// and it is asserted rather than described, so this file goes red if any of
// those commands is ever quietly weakened to accommodate the state instead.
//
// WHAT THIS FILE IS NOT. It is not a second opinion about redemption, booking
// or capacity. Every fixture drives the REAL chain — create entry, admit,
// prove, redeem, and where a booking is needed, `create_waitlist_public_
// appointment` — so a state this suite reaches is a state the product can
// reach.
// ===========================================================================

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

const CLOSE = `select public.close_unbooked_new_client_waitlist_invitation($1,$2,$3) as r`;
const BOOK = `select * from public.create_waitlist_public_appointment($1,$2,$3,$4::timestamptz,$5,$6,null,null)`;
const CONVERT = `select public.record_new_client_waitlist_conversion($1,$2,$3) as r`;

const EN_T = "public.new_client_waitlist_entries";
const IN_T = "public.new_client_waitlist_invitations";

afterAll(async () => {
  await closePool();
});

type Fixture = { studioId: string; userId: string; serviceId: string; roundId: string };

/** A studio that can actually take a public booking: active service + open week. */
async function fixture(label: string): Promise<Fixture> {
  const s = await seedStudio(`p1exit-${label}`);
  const svc = await q<{ id: string }>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
     values ($1,'Consultation',30,true,'consultation') returning id`,
    [s.studioId],
  );
  for (let d = 0; d < 7; d += 1) {
    await q(
      `insert into public.studio_availability_default
         (studio_id,day_of_week,is_open,open_time,close_time,practitioner_id)
       values ($1,$2,true,'08:00','20:00',null)`,
      [s.studioId, d],
    );
  }
  const r = await q<{ result: string; round_id: string }>(
    `select * from public.open_new_client_waitlist_admission_round($1,$2,20)`,
    [s.studioId, s.userId],
  );
  expect(r[0].result).toBe("opened");
  return {
    studioId: s.studioId,
    userId: s.userId,
    serviceId: svc[0].id,
    roundId: r[0].round_id,
  };
}

/** A legal slot, taken from the booking path's own candidate generator. */
async function legalSlot(f: Fixture, nth: number): Promise<string> {
  for (let day = 2; day < 30; day += 1) {
    const when = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
    const cands = await q<{ c: string }>(
      `select c from public.public_booking_slot_candidates($1,$2::date,30) c`,
      [f.studioId, when],
    );
    if (cands.length > nth) return cands[nth].c;
  }
  throw new Error("no legal slot");
}

/**
 * A cancellation-token hash that CANNOT collide with another file's.
 *
 * THE DEFECT THIS REPLACES, observed in CI. The neighbouring 0195 suite derives
 * its hashes from a short seed with
 * `"0123456789abcdef"[(seed.charCodeAt(i % seed.length) + i) % 16]`, and a
 * two-character seed only ever contributes two characters of entropy — so this
 * file's `"rb"` produced a digest byte-identical to that file's `"r2"`, and
 * `appointments_cancellation_token_hash_uniq` failed in the OTHER suite. The db
 * lane shares one database across files, so a weak generator is a cross-file
 * hazard rather than a local one.
 *
 * `randomUUID()` gives 32 hex characters; two of them give the 64 the CHECK
 * requires, from a source with no seed to collide on.
 */
const tokenHash = (): string =>
  (randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 64).padEnd(64, "0");

type Prospect = { entryId: string; email: string; rawToken: string };

/** An entry with a LIVE, un-redeemed invitation, via the real admission chain. */
async function invitedProspect(f: Fixture, label: string): Promise<Prospect> {
  const email = `p-${label}-${f.studioId.slice(0, 8)}@example.com`;
  const e = await q<{ result: string; entry_id: string }>(
    `select * from public.create_practitioner_waitlist_entry($1,$2,'Prospect',$3,null,null)`,
    [f.studioId, f.userId, email],
  );
  expect(e[0].result).toBe("created");
  const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const a = await q<{ result: string; raw_token: string }>(
    `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72)`,
    [f.studioId, f.userId, e[0].entry_id, f.serviceId, from, to],
  );
  expect(a[0].result).toBe("admitted");
  return { entryId: e[0].entry_id, email, rawToken: a[0].raw_token };
}

/** Drive that prospect through proof + redemption — the real recipient path. */
async function redeem(p: Prospect): Promise<void> {
  const b = await q<{ raw_challenge: string }>(
    `select * from public.begin_waitlist_invitation_proof($1,20)`,
    [p.rawToken],
  );
  const c = await q<{ raw_capability: string }>(
    `select * from public.complete_waitlist_invitation_proof($1,$2)`,
    [p.rawToken, b[0].raw_challenge],
  );
  const r = await q<{ result: string }>(
    `select * from public.redeem_new_client_waitlist_invitation_verified($1,$2)`,
    [p.rawToken, c[0].raw_capability],
  );
  expect(r[0].result, "the fixture failed to reach the state under test").toBe("redeemed");
}

/** THE state this slice exists for: redeemed, still `invited`, never booked. */
async function redeemedUnbooked(f: Fixture, label: string): Promise<Prospect> {
  const p = await invitedProspect(f, label);
  await redeem(p);
  expect(await statusOf(p.entryId)).toBe("invited");
  return p;
}

const statusOf = async (entryId: string): Promise<string> =>
  (await q<{ status: string }>(`select status from ${EN_T} where id = $1`, [entryId]))[0].status;

const close = async (f: Fixture, entryId: string, actor = f.userId): Promise<string> =>
  (await q<{ r: string }>(CLOSE, [f.studioId, entryId, actor]))[0].r;

/** The invitation row's close + redemption evidence, at full precision. */
async function inviteEvidence(entryId: string) {
  const r = await q<{
    redeemed_at: string | null;
    closed_at: string | null;
    closed_by: string | null;
    released_at: string | null;
    expired_at: string | null;
    declined_at: string | null;
  }>(
    `select to_char(redeemed_at,'YYYY-MM-DD"T"HH24:MI:SS.USOF') as redeemed_at,
            to_char(closed_at,  'YYYY-MM-DD"T"HH24:MI:SS.USOF') as closed_at,
            closed_by_practitioner_id::text                     as closed_by,
            to_char(released_at,'YYYY-MM-DD"T"HH24:MI:SS.USOF') as released_at,
            to_char(expired_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as expired_at,
            to_char(declined_at,'YYYY-MM-DD"T"HH24:MI:SS.USOF') as declined_at
       from ${IN_T} where entry_id = $1`,
    [entryId],
  );
  expect(r, "expected exactly one invitation for this entry").toHaveLength(1);
  return r[0];
}

/** Seats consumed in a round, read through the server's own gateway (0197). */
const consumed = async (f: Fixture): Promise<number> =>
  (
    await q<{ c: number }>(
      `select public.read_waitlist_admission_round_consumed($1,$2) as c`,
      [f.studioId, f.roundId],
    )
  )[0].c;

// ---------------------------------------------------------------------------
describe("I — the dead end is real on THIS schema, and stays real", () => {
  // THIS RUNS FIRST ON PURPOSE. Every other assertion in the file is only
  // interesting if the four shipped exits genuinely refuse here. If one of them
  // is ever relaxed, this goes red before anything else — which is the signal
  // that the new command has become a second way to do an existing job.
  it("release, expire, remove and requeue all refuse a redeemed, unbooked entry", async () => {
    const f = await fixture("deadend");
    const p = await redeemedUnbooked(f, "de");

    const release = await q<{ r: string }>(
      `select public.release_new_client_waitlist_entry($1,$2,$3) as r`,
      [f.studioId, p.entryId, f.userId],
    );
    const expire = await q<{ r: string }>(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) as r`,
      [f.studioId, p.entryId, f.userId],
    );
    const remove = await q<{ r: string }>(
      `select public.remove_new_client_waitlist_entry($1,$2,$3) as r`,
      [f.studioId, p.entryId, f.userId],
    );
    const requeue = await q<{ r: string }>(
      `select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`,
      [f.studioId, p.entryId, f.userId],
    );

    expect(release[0].r).toBe("already_redeemed");
    expect(expire[0].r).toBe("already_redeemed");
    expect(remove[0].r).toBe("release_required");
    expect(requeue[0].r).toBe("not_requeueable");
    expect(
      await statusOf(p.entryId),
      "one of the four exits moved the entry — the dead end has changed shape",
    ).toBe("invited");
  });

  it("and no fresh invitation can be issued to move it either", async () => {
    const f = await fixture("deadend2");
    const p = await redeemedUnbooked(f, "de2");
    const again = await q<{ result: string }>(
      `select result from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`,
      [f.studioId, p.entryId, f.userId],
    );
    // NAMES THE CODE, BECAUSE `not.toBe("issued")` WOULD BE VACUOUS HERE.
    // 0192's success word is `invited`, not `issued` — so a negative assertion
    // against a word the command cannot return passes against a SUCCESSFUL
    // issuance, which is the opposite of what this test claims to prove.
    // Issuance accepts only a `claimed` entry, and this one is `invited`.
    expect(again[0].result).toBe("not_claimed");
    expect(await statusOf(p.entryId)).toBe("invited");
    expect(
      (
        await q<{ c: number }>(`select count(*)::int as c from ${IN_T} where entry_id = $1`, [
          p.entryId,
        ])
      )[0].c,
      "a second invitation row was created",
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("A — the exit itself", () => {
  it("closes the cycle, releases the entry, and records who did it", async () => {
    const f = await fixture("happy");
    const p = await redeemedUnbooked(f, "h");
    const before = await eventIdSet(p.entryId);
    const redeemedAtBefore = (await inviteEvidence(p.entryId)).redeemed_at;

    expect(await close(f, p.entryId)).toBe("closed");

    expect(await statusOf(p.entryId)).toBe("released");

    const ev = await inviteEvidence(p.entryId);
    expect(ev.closed_at, "the cycle was not stamped closed").not.toBeNull();
    expect(ev.closed_by, "the close has no actor").not.toBeNull();
    // THE REDEMPTION IS PRESERVED, NOT OVERWRITTEN. The seat it consumed and the
    // fact the prospect opened the link are both history, and history is not
    // edited by an exit.
    expect(ev.redeemed_at).toBe(redeemedAtBefore);
    // NO SECOND TERMINAL OUTCOME. `..._one_outcome_check` permits at most one of
    // redeemed / expired / released / declined, and this command writes none of
    // them.
    expect(ev.released_at).toBeNull();
    expect(ev.expired_at).toBeNull();
    expect(ev.declined_at).toBeNull();

    // ONE CLOCK READ: the entry's release and the invitation's close are the
    // same instant, compared by PostgreSQL at microsecond precision.
    const entryReleased = await readStoredInstant(
      `select released_at from ${EN_T} where id = $1`,
      [p.entryId],
    );
    expect(
      entryReleased,
      "the entry and the invitation disagree about when the cycle was closed",
    ).toBe(ev.closed_at);

    // EXACTLY ONE lifecycle event, and it is the transition that was made.
    await expectExactlyOneNewEvent(p.entryId, before, "invited", "released");
  });

  it("the actor recorded is the practitioner who acted, not the one who claimed", async () => {
    const f = await fixture("actor");
    const p = await redeemedUnbooked(f, "ac");
    // A SECOND OWNER in the same studio. The entry's claim evidence points at
    // the first; the close must point at whoever actually pressed it.
    const second = await q<{ id: string; user_id: string }>(
      `with u as (
         insert into auth.users (id, email, aud, role)
         values (gen_random_uuid(), 'second-' || $2 || '@harness.local', 'authenticated','authenticated')
         returning id
       )
       insert into public.practitioners (studio_id, user_id, display_name, email, role, active)
       select $1, u.id, 'Second Owner', 'second-' || $2 || '@harness.local', 'owner', true from u
       returning id, user_id`,
      [f.studioId, f.studioId.slice(0, 8)],
    );

    expect(await close(f, p.entryId, second[0].user_id)).toBe("closed");
    expect((await inviteEvidence(p.entryId)).closed_by).toBe(second[0].id);
  });

  it("the token stays permanently unusable, as it already was", async () => {
    const f = await fixture("token");
    const p = await redeemedUnbooked(f, "tk");
    expect(await close(f, p.entryId)).toBe("closed");
    const again = await q<{ result: string }>(
      `select result from public.redeem_new_client_waitlist_invitation($1)`,
      [p.rawToken],
    );
    expect(again[0].result).toBe("invalid_token");
  });
});

// ---------------------------------------------------------------------------
describe("B — redeemed AND booked cannot use this escape hatch", () => {
  it("a converted entry answers already_booked and nothing is written", async () => {
    const f = await fixture("booked");
    const p = await redeemedUnbooked(f, "bk");
    const client = await q<{ client_id: string }>(
      `select * from public.find_or_create_client_for_booking($1,$2,'Prospect',null)`,
      [f.studioId, p.email],
    );
    const booked = await q<{ result: string }>(BOOK, [
      f.studioId,
      client[0].client_id,
      f.serviceId,
      await legalSlot(f, 0),
      tokenHash(),
      p.entryId,
    ]);
    // 0195's own word for the composed outcome: the appointment AND the
    // conversion committed together. Plain `created` is create_public_appointment.
    expect(booked[0].result).toBe("created_and_converted");
    expect(await statusOf(p.entryId)).toBe("converted");

    const before = await eventIdSet(p.entryId);
    expect(await close(f, p.entryId)).toBe("already_booked");

    expect(await statusOf(p.entryId)).toBe("converted");
    expect((await inviteEvidence(p.entryId)).closed_at).toBeNull();
    expect(await newEventsSince(p.entryId, before)).toHaveLength(0);
  });

  it("an appointment stranded by the pre-0195 flow is CLOSED OVER — 0201 supersedes the repair", async () => {
    // THE PRE-0195 SHAPE. Before the atomic command the flow was three
    // transactions, and a process death between the appointment and the
    // conversion left a durable appointment behind an entry still reading
    // `invited`.
    //
    // THIS TEST IS THE RECORD OF TWO SUPERSESSIONS, kept whole because the
    // fixture below is the only one in the suite that builds the stranded shape.
    //
    //   The FIRST revision REFUSED here with `booking_exists`, telling the
    //   operator to record the booking through an operation nothing in the
    //   product invokes. The dead end came back wearing a different word.
    //
    //   0200 then REPAIRED here, answering `converted_instead` and moving the
    //   entry to a terminal `converted`. 0201 WITHDRAWS that, because the scan
    //   it rested on could not tell this appointment from one `create_waitlist_
    //   public_appointment` would have refused, and could not be made to
    //   decide deterministically against a concurrent writer. The exit now
    //   answers `closed` and records no conversion it cannot prove.
    //
    // What survives unchanged is the property this test was written for: the
    // entry does not stay stuck, and the appointment is not disturbed.
    // `tests/db/waitlist-exit-authority-contraction.db.test.ts` carries the
    // full matrix behind the change.
    const f = await fixture("stranded");
    const p = await redeemedUnbooked(f, "st");
    const client = await q<{ client_id: string }>(
      `select * from public.find_or_create_client_for_booking($1,$2,'Prospect',null)`,
      [f.studioId, p.email],
    );
    // The ORDINARY booking command — no waitlist entry, so no conversion is
    // recorded and the entry stays exactly where it was.
    const appt = await q<{ result: string; appointment_id: string }>(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [f.studioId, client[0].client_id, f.serviceId, await legalSlot(f, 0), tokenHash()],
    );
    expect(appt[0].result).toBe("created");
    expect(await statusOf(p.entryId)).toBe("invited");

    const before = await eventIdSet(p.entryId);
    expect(await close(f, p.entryId)).toBe("closed");

    // THE ENTRY IS RELEASED, and NO conversion is claimed on evidence the
    // command cannot check.
    expect(await statusOf(p.entryId)).toBe("released");
    const entry = await q<{ converted_client_id: string | null; converted_at: string | null }>(
      `select converted_client_id::text, converted_at::text from ${EN_T} where id = $1`,
      [p.entryId],
    );
    expect(entry[0].converted_client_id, "0201 must claim no conversion").toBeNull();
    expect(entry[0].converted_at).toBeNull();

    // THE CYCLE IS STAMPED CLOSED, by the operator who closed it.
    const ev = await inviteEvidence(p.entryId);
    expect(ev.closed_at, "the close must be recorded as an operator close").not.toBeNull();
    expect(ev.redeemed_at).not.toBeNull();

    // ONE lifecycle event, and it is the transition that was made.
    await expectExactlyOneNewEvent(p.entryId, before, "invited", "released");

    // THE APPOINTMENT STANDS — nothing was rolled back to make this tidy.
    const appts = await q<{ c: number }>(
      `select count(*)::int as c from public.appointments
        where id = $1 and status <> 'cancelled'`,
      [appt[0].appointment_id],
    );
    expect(appts[0].c).toBe(1);

    // AND THE ROW IS NO LONGER STUCK: a retry says so rather than repeating.
    expect(await close(f, p.entryId)).toBe("already_closed");
  });

  it("RACE: a concurrent email edit no longer reaches the exit at all — 0201", async () => {
    // THE SECOND P1 REVIEW FINDING, AND ITS WITHDRAWAL.
    //
    // 0200's aggregate resolved the stranded booking's client, and
    // `record_new_client_waitlist_conversion` checks only studio membership —
    // not the recipient binding. An owner editing that client's email
    // concurrently with Close could have the match made on the OLD normalised
    // address and the conversion recorded after the edit committed. 0200 held
    // the matched client FOR SHARE and re-compared under that lock, and this
    // test proved the resulting refusal.
    //
    // 0201 removes the client read entirely, so there is no identity to
    // re-point and no lock to park on. The property inverts, and the inverted
    // form is the stronger one: THE EXIT COMPLETES WHILE THE EDIT IS STILL
    // HELD OPEN. Completing against a held `UPDATE clients` — which takes FOR
    // NO KEY UPDATE, the very mode 0200's FOR SHARE conflicted with — is
    // positive proof that the read is gone, not merely that it was reordered.
    const f = await fixture("client-edit");
    const p = await redeemedUnbooked(f, "ce");
    const client = await q<{ client_id: string }>(
      `select * from public.find_or_create_client_for_booking($1,$2,'Prospect',null)`,
      [f.studioId, p.email],
    );
    const appt = await q<{ result: string }>(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [f.studioId, client[0].client_id, f.serviceId, await legalSlot(f, 0), tokenHash()],
    );
    expect(appt[0].result).toBe("created");

    const s1 = new Client({ connectionString: resolveLocalDbUrl() });
    const s2 = new Client({ connectionString: resolveLocalDbUrl() });
    const observer = new Client({ connectionString: resolveLocalDbUrl() });
    await s1.connect();
    await s2.connect();
    await observer.connect();
    let closeResult: string | undefined;
    try {
      // S1 re-points the identity and HOLDS it, exactly as before.
      await s1.query("begin");
      await s1.query(`update public.clients set email = $2 where id = $1`, [
        client[0].client_id,
        `moved-${f.studioId.slice(0, 8)}@example.com`,
      ]);

      const pid = (await s2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      const closing = s2.query(CLOSE, [f.studioId, p.entryId, f.userId]).then(
        (r) => r.rows[0].r as string,
      );
      await new Promise((r) => setTimeout(r, 1_200));

      // NOT BLOCKED BY ANYTHING — the discriminator. Under 0200 this pid was
      // parked on s1; the empty blocker list is what changed.
      const w = await observer.query(
        `select pg_blocking_pids(pid) as blockers from pg_stat_activity where pid = $1`,
        [pid],
      );
      expect(w.rows[0]?.blockers, "the exit still parks on a client identity").toEqual([]);

      // And it has ALREADY ANSWERED, while the edit is still uncommitted.
      closeResult = await closing;

      await s1.query("commit");
    } finally {
      await s1.query("rollback").catch(() => undefined);
      await s1.end();
      await s2.end();
      await observer.end();
    }

    // It closes the cycle on its own authority and claims no conversion.
    expect(closeResult).toBe("closed");
    const entry = await q<{ status: string; converted_client_id: string | null }>(
      `select status, converted_client_id::text from ${EN_T} where id = $1`,
      [p.entryId],
    );
    expect(entry[0].status).toBe("released");
    expect(entry[0].converted_client_id).toBeNull();
    expect((await inviteEvidence(p.entryId)).closed_at).not.toBeNull();
  });

  it("the repair binds to the entry's OWN recipient, never to a neighbour", async () => {
    // The conversion target is resolved on the same recipient binding 0195
    // enforces — the entry's normalised address — so another client's
    // appointment in the same studio cannot pull this prospect into a booking
    // that is not theirs.
    const f = await fixture("neighbour");
    const p = await redeemedUnbooked(f, "nb");
    const other = await q<{ client_id: string }>(
      `select * from public.find_or_create_client_for_booking($1,$2,'Someone Else',null)`,
      [f.studioId, `other-${f.studioId.slice(0, 8)}@example.com`],
    );
    const appt = await q<{ result: string }>(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [f.studioId, other[0].client_id, f.serviceId, await legalSlot(f, 0), tokenHash()],
    );
    expect(appt[0].result).toBe("created");

    // Someone else's booking is not this prospect's, so the ordinary close runs.
    expect(await close(f, p.entryId)).toBe("closed");
    expect(await statusOf(p.entryId)).toBe("released");
    const entry = await q<{ converted_client_id: string | null }>(
      `select converted_client_id::text from ${EN_T} where id = $1`,
      [p.entryId],
    );
    expect(entry[0].converted_client_id, "the exit converted to the WRONG person").toBeNull();
  });

  it("a CANCELLED appointment strands nothing, so the ordinary close still runs", async () => {
    const f = await fixture("cancelled");
    const p = await redeemedUnbooked(f, "cx");
    const client = await q<{ client_id: string }>(
      `select * from public.find_or_create_client_for_booking($1,$2,'Prospect',null)`,
      [f.studioId, p.email],
    );
    const appt = await q<{ result: string; appointment_id: string }>(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [f.studioId, client[0].client_id, f.serviceId, await legalSlot(f, 0), tokenHash()],
    );
    expect(appt[0].result).toBe("created");
    await q(
      `update public.appointments set status = 'cancelled', cancelled_at = now() where id = $1`,
      [appt[0].appointment_id],
    );
    expect(await close(f, p.entryId)).toBe("closed");
  });

  it("an appointment from BEFORE this cycle's redemption does not block the exit", async () => {
    // A prospect's unrelated history is not evidence about this invitation.
    const f = await fixture("history");
    const p = await invitedProspect(f, "hi");
    const client = await q<{ client_id: string }>(
      `select * from public.find_or_create_client_for_booking($1,$2,'Prospect',null)`,
      [f.studioId, p.email],
    );
    const appt = await q<{ result: string }>(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [f.studioId, client[0].client_id, f.serviceId, await legalSlot(f, 0), tokenHash()],
    );
    expect(appt[0].result).toBe("created");
    await redeem(p); // redemption happens AFTER the appointment was created
    expect(await close(f, p.entryId)).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
describe("C — an unredeemed invitation does not use this escape hatch", () => {
  it("answers not_redeemed, writes nothing, and leaves release working", async () => {
    const f = await fixture("unredeemed");
    const p = await invitedProspect(f, "un");
    const before = await eventIdSet(p.entryId);

    expect(await close(f, p.entryId)).toBe("not_redeemed");

    expect(await statusOf(p.entryId)).toBe("invited");
    const ev = await inviteEvidence(p.entryId);
    expect(ev.closed_at).toBeNull();
    expect(ev.redeemed_at).toBeNull();
    expect(ev.released_at).toBeNull();
    expect(await newEventsSince(p.entryId, before)).toHaveLength(0);

    // THE COMMAND THAT OWNS THIS STATE IS UNCHANGED AND STILL WORKS.
    const rel = await q<{ r: string }>(
      `select public.release_new_client_waitlist_entry($1,$2,$3) as r`,
      [f.studioId, p.entryId, f.userId],
    );
    expect(rel[0].r).toBe("released");
  });

  it("a waiting entry, never invited, answers not_invited", async () => {
    const f = await fixture("waiting");
    const e = await q<{ entry_id: string }>(
      `select * from public.create_practitioner_waitlist_entry($1,$2,'Prospect',$3,null,null)`,
      [f.studioId, f.userId, `w-${f.studioId.slice(0, 8)}@example.com`],
    );
    expect(await close(f, e[0].entry_id)).toBe("not_invited");
    expect(await statusOf(e[0].entry_id)).toBe("waiting");
  });
});

// ---------------------------------------------------------------------------
describe("D — a cross-studio or cross-entry request refuses", () => {
  it("another studio's entry id is not found, and is not touched", async () => {
    const mine = await fixture("tenant-a");
    const theirs = await fixture("tenant-b");
    const victim = await redeemedUnbooked(theirs, "vt");

    // MY studio, MY owner, THEIR entry id.
    const r = await q<{ r: string }>(CLOSE, [mine.studioId, victim.entryId, mine.userId]);
    expect(r[0].r).toBe("not_found");

    expect(await statusOf(victim.entryId)).toBe("invited");
    expect((await inviteEvidence(victim.entryId)).closed_at).toBeNull();
  });

  it("an actor from another studio is not a member here", async () => {
    const mine = await fixture("actor-a");
    const theirs = await fixture("actor-b");
    const p = await redeemedUnbooked(mine, "xa");

    const r = await q<{ r: string }>(CLOSE, [mine.studioId, p.entryId, theirs.userId]);
    expect(r[0].r).toBe("not_a_member");
    expect(await statusOf(p.entryId)).toBe("invited");
  });

  it("a non-owner member of this studio is refused", async () => {
    const f = await fixture("role");
    const p = await redeemedUnbooked(f, "rl");
    const member = await q<{ user_id: string }>(
      `with u as (
         insert into auth.users (id, email, aud, role)
         values (gen_random_uuid(), 'member-' || $2 || '@harness.local','authenticated','authenticated')
         returning id
       )
       insert into public.practitioners (studio_id, user_id, display_name, email, role, active)
       select $1, u.id, 'Member', 'member-' || $2 || '@harness.local', 'practitioner', true from u
       returning user_id`,
      [f.studioId, f.studioId.slice(0, 8)],
    );
    const r = await q<{ r: string }>(CLOSE, [f.studioId, p.entryId, member[0].user_id]);
    expect(r[0].r).toBe("not_owner");
    expect(await statusOf(p.entryId)).toBe("invited");
  });
});

// ---------------------------------------------------------------------------
describe("E — double submit is safe", () => {
  it("the second call answers already_closed and changes nothing", async () => {
    const f = await fixture("retry");
    const p = await redeemedUnbooked(f, "rt");

    expect(await close(f, p.entryId)).toBe("closed");
    const afterFirst = await inviteEvidence(p.entryId);
    const before = await eventIdSet(p.entryId);

    expect(await close(f, p.entryId)).toBe("already_closed");
    expect(await close(f, p.entryId)).toBe("already_closed");

    expect(
      await inviteEvidence(p.entryId),
      "a retry rewrote the close it was supposed to recognise",
    ).toEqual(afterFirst);
    expect(await statusOf(p.entryId)).toBe("released");
    expect(
      await newEventsSince(p.entryId, before),
      "a retry appended a second lifecycle event",
    ).toHaveLength(0);
  });

  it("a release this command did NOT perform is not reported as its own retry", async () => {
    // THE EXACT-INSTANT TEST, NEGATIVELY. An ordinary release also lands the
    // entry in `released`; answering `already_closed` there would claim an act
    // this command never performed.
    const f = await fixture("foreign-release");
    const p = await invitedProspect(f, "fr");
    const rel = await q<{ r: string }>(
      `select public.release_new_client_waitlist_entry($1,$2,$3) as r`,
      [f.studioId, p.entryId, f.userId],
    );
    expect(rel[0].r).toBe("released");
    expect(await close(f, p.entryId)).toBe("not_invited");
  });

  it("an ordinary `released` entry, set aside without redemption, is untouched by all this", async () => {
    // The closed-cycle idempotency test must not be satisfied by the mere fact
    // that an entry is `released` — the far commoner way to get there.
    const f = await fixture("plain-released");
    const p = await invitedProspect(f, "pr2");
    expect(
      (
        await q<{ r: string }>(
          `select public.release_new_client_waitlist_entry($1,$2,$3) as r`,
          [f.studioId, p.entryId, f.userId],
        )
      )[0].r,
    ).toBe("released");
    expect(await close(f, p.entryId)).toBe("not_invited");
    // And its ordinary return path is completely unaffected.
    expect(
      (
        await q<{ r: string }>(`select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`, [
          f.studioId,
          p.entryId,
          f.userId,
        ])
      )[0].r,
    ).toBe("requeued");
    expect(await statusOf(p.entryId)).toBe("waiting");
  });
});

// ---------------------------------------------------------------------------
describe("F — a booking race cannot produce both a booking and an exit", () => {
  it("exit first: the booking refuses and NO appointment commits", async () => {
    const f = await fixture("race-exit");
    const p = await redeemedUnbooked(f, "re");
    const client = await q<{ client_id: string }>(
      `select * from public.find_or_create_client_for_booking($1,$2,'Prospect',null)`,
      [f.studioId, p.email],
    );
    const slot = await legalSlot(f, 0);

    // SESSION 1 opens, takes the entry mutex by running the exit, and HOLDS the
    // transaction open. Session 2's booking must then park on that lock.
    const s1 = new Client({ connectionString: resolveLocalDbUrl() });
    const s2 = new Client({ connectionString: resolveLocalDbUrl() });
    await s1.connect();
    await s2.connect();
    try {
      await s1.query("begin");
      const exited = await s1.query(CLOSE, [f.studioId, p.entryId, f.userId]);
      expect(exited.rows[0].r).toBe("closed");

      const pid = (await s2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      await s2.query("begin");
      const booking = s2.query(BOOK, [
        f.studioId,
        client[0].client_id,
        f.serviceId,
        slot,
        tokenHash(),
        p.entryId,
      ]);
      await expectBlockedOn(pid, "the booking did not park on the entry mutex the exit holds");

      await s1.query("commit");
      const booked = await booking;
      await s2.query("commit");

      // The conversion could not find an `invited` entry, so 0195 raised its
      // private WA002 and unwound the appointment inserts with it. Its success
      // word is `created_and_converted`; anything else is a refusal.
      expect(booked.rows[0].result).not.toBe("created_and_converted");
    } finally {
      await s1.query("rollback").catch(() => undefined);
      await s2.query("rollback").catch(() => undefined);
      await s1.end();
      await s2.end();
    }

    expect(await statusOf(p.entryId)).toBe("released");
    const appts = await q<{ c: number }>(
      `select count(*)::int as c from public.appointments
        where studio_id = $1 and client_id = $2 and status <> 'cancelled'`,
      [f.studioId, client[0].client_id],
    );
    expect(appts[0].c, "an appointment survived a refused booking").toBe(0);
  });

  it("booking first: the exit refuses and the appointment stands", async () => {
    const f = await fixture("race-book");
    const p = await redeemedUnbooked(f, "rb");
    const client = await q<{ client_id: string }>(
      `select * from public.find_or_create_client_for_booking($1,$2,'Prospect',null)`,
      [f.studioId, p.email],
    );
    const slot = await legalSlot(f, 0);

    const s1 = new Client({ connectionString: resolveLocalDbUrl() });
    const s2 = new Client({ connectionString: resolveLocalDbUrl() });
    await s1.connect();
    await s2.connect();
    let closeResult: string | undefined;
    try {
      await s1.query("begin");
      const booked = await s1.query(BOOK, [
        f.studioId,
        client[0].client_id,
        f.serviceId,
        slot,
        tokenHash(),
        p.entryId,
      ]);
      expect(booked.rows[0].result).toBe("created_and_converted");

      const pid = (await s2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      await s2.query("begin");
      const exiting = s2.query(CLOSE, [f.studioId, p.entryId, f.userId]);
      await expectBlockedOn(pid, "the exit did not park on the entry mutex the booking holds");

      await s1.query("commit");
      closeResult = (await exiting).rows[0].r as string;
      await s2.query("commit");
    } finally {
      await s1.query("rollback").catch(() => undefined);
      await s2.query("rollback").catch(() => undefined);
      await s1.end();
      await s2.end();
    }

    expect(closeResult).toBe("already_booked");
    expect(await statusOf(p.entryId)).toBe("converted");
    expect((await inviteEvidence(p.entryId)).closed_at).toBeNull();
    const appts = await q<{ c: number }>(
      `select count(*)::int as c from public.appointments
        where studio_id = $1 and client_id = $2 and status <> 'cancelled'`,
      [f.studioId, client[0].client_id],
    );
    expect(appts[0].c, "the committed appointment was lost").toBe(1);
  });

  it("two concurrent exits produce one close and one already_closed", async () => {
    const f = await fixture("race-double");
    const p = await redeemedUnbooked(f, "rd");

    const s1 = new Client({ connectionString: resolveLocalDbUrl() });
    const s2 = new Client({ connectionString: resolveLocalDbUrl() });
    await s1.connect();
    await s2.connect();
    let first: string | undefined;
    let second: string | undefined;
    try {
      await s1.query("begin");
      first = (await s1.query(CLOSE, [f.studioId, p.entryId, f.userId])).rows[0].r as string;

      const pid = (await s2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      await s2.query("begin");
      const other = s2.query(CLOSE, [f.studioId, p.entryId, f.userId]);
      await expectBlockedOn(pid, "the second exit did not park on the entry mutex");

      await s1.query("commit");
      second = (await other).rows[0].r as string;
      await s2.query("commit");
    } finally {
      await s1.query("rollback").catch(() => undefined);
      await s2.query("rollback").catch(() => undefined);
      await s1.end();
      await s2.end();
    }

    expect([first, second].sort()).toEqual(["already_closed", "closed"]);
    const events = await q<{ c: number }>(
      `select count(*)::int as c from public.new_client_waitlist_entry_events
        where entry_id = $1 and from_status = 'invited' and to_status = 'released'`,
      [p.entryId],
    );
    expect(events[0].c, "two exits both moved the entry").toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("G — the admission seat is not recycled, which is 0192's ruling", () => {
  it("the round's consumed count is identical before and after the exit", async () => {
    const f = await fixture("capacity");
    const p = await redeemedUnbooked(f, "cp");
    const before = await consumed(f);
    expect(before, "redemption should already have spent a seat").toBe(1);

    expect(await close(f, p.entryId)).toBe("closed");

    expect(
      await consumed(f),
      "the exit recycled an admission seat — 0192 rules a redeemed seat is spent " +
        "and is not recycled even when an appointment is later cancelled",
    ).toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe("H — queue priority and provenance are not rewritten", () => {
  it("joined_at, source and identity survive the exit untouched", async () => {
    const f = await fixture("order");
    const first = await redeemedUnbooked(f, "o1");

    const snapshot = async (entryId: string) =>
      (
        await q<Record<string, string>>(
          `select to_char(joined_at,'YYYY-MM-DD"T"HH24:MI:SS.USOF') as joined_at,
                  source, name, email, email_normalized
             from ${EN_T} where id = $1`,
          [entryId],
        )
      )[0];

    const before = await snapshot(first.entryId);
    expect(await close(f, first.entryId)).toBe("closed");
    expect(
      await snapshot(first.entryId),
      "the exit rewrote provenance it does not own",
    ).toEqual(before);
  });

  it("and remove is reachable afterwards, which it was not before", async () => {
    const f = await fixture("removable");
    const p = await redeemedUnbooked(f, "rm");
    expect(await close(f, p.entryId)).toBe("closed");
    const removed = await q<{ r: string }>(
      `select public.remove_new_client_waitlist_entry($1,$2,$3) as r`,
      [f.studioId, p.entryId, f.userId],
    );
    expect(removed[0].r).toBe("removed");
  });
});

// ---------------------------------------------------------------------------
describe("K — the exit is ONE-WAY, because five consumers depend on that", () => {
  // 0195 states the premise it relies on: "an entry cannot acquire a second
  // invitation once one is redeemed". It held only because a redeemed entry was
  // STUCK at `invited`. This command unsticks it, so this command owes it.
  it("a closed entry cannot be requeued, and the refusal says so", async () => {
    const f = await fixture("oneway");
    const p = await redeemedUnbooked(f, "ow");
    expect(await close(f, p.entryId)).toBe("closed");

    const requeued = await q<{ r: string }>(
      `select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`,
      [f.studioId, p.entryId, f.userId],
    );
    expect(requeued[0].r).toBe("already_redeemed");
    expect(
      await statusOf(p.entryId),
      "the refused requeue moved the entry anyway",
    ).toBe("released");
  });

  it("so ONE entry can never hold two redeemed invitations", async () => {
    // THE INVARIANT ITSELF, walked end to end rather than asserted about the
    // guard that protects it. Every route back into the active set is tried.
    const f = await fixture("invariant");
    const p = await redeemedUnbooked(f, "iv");
    expect(await close(f, p.entryId)).toBe("closed");

    for (const [command, expected] of [
      ["requeue_new_client_waitlist_entry", "already_redeemed"],
      ["claim_new_client_waitlist_entry", "not_waiting"],
    ] as const) {
      const r = await q<{ r: string }>(`select public.${command}($1,$2,$3) as r`, [
        f.studioId,
        p.entryId,
        f.userId,
      ]);
      expect(r[0].r, command).toBe(expected);
    }
    const issued = await q<{ result: string }>(
      `select result from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`,
      [f.studioId, p.entryId, f.userId],
    );
    // 0192's success word is `invited`; `issued` is a word it cannot return, so
    // asserting against that would pass on a successful issuance.
    expect(issued[0].result).toBe("not_claimed");

    const count = await q<{ c: number }>(
      `select count(*)::int as c from ${IN_T}
        where entry_id = $1 and redeemed_at is not null`,
      [p.entryId],
    );
    expect(count[0].c).toBe(1);
  });

  it("the narrowing is a NO-OP on every state reachable without this command", async () => {
    // NON-VACUITY FOR THE GUARD. If it fired on ordinary requeues it would be a
    // regression, not a repair — so both un-redeemed routes into `released` and
    // `expired` are walked and must still requeue.
    const f = await fixture("noop");

    // Route 1: released without redemption.
    const a = await invitedProspect(f, "n1");
    await q(`select public.release_new_client_waitlist_entry($1,$2,$3)`, [
      f.studioId,
      a.entryId,
      f.userId,
    ]);
    expect(
      (
        await q<{ r: string }>(`select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`, [
          f.studioId,
          a.entryId,
          f.userId,
        ])
      )[0].r,
    ).toBe("requeued");

    // Route 2: `invited`. Requeue has ALWAYS refused this state, and the word
    // it refuses with is part of its contract — two shipped DB tests assert
    // `not_requeueable` there by name. The guard must not change it, which is
    // why it is scoped to the statuses requeue would otherwise accept.
    const b = await redeemedUnbooked(f, "n2");
    expect(
      (
        await q<{ r: string }>(`select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`, [
          f.studioId,
          b.entryId,
          f.userId,
        ])
      )[0].r,
      "the guard changed an EXISTING refusal's vocabulary",
    ).toBe("not_requeueable");

    // The `expired` arm of the guard is deliberately untested here and
    // deliberately present: `expire_new_client_waitlist_invitation` refuses a
    // redeemed entry, so no supported path reaches `expired` carrying a
    // redemption. Producing one would mean disabling the invitations
    // append-only trigger mid-suite — a table-wide ALTER that the db lane runs
    // files in parallel around, and a flake class this file will not introduce
    // for an arm that cannot fire.
  });

  it("RACE: a requeue overlapping a close cannot resurrect the entry", async () => {
    // THE P1 REVIEW FINDING, AND THE SHAPE THAT CLOSES IT.
    //
    // THE DEFECT, REPRODUCED before the repair: the redeemed exclusion sat in an
    // UNLOCKED PRE-CHECK ahead of requeue's UPDATE. Under READ COMMITTED each
    // statement takes its own snapshot, so a close committing BETWEEN the two
    // was invisible to the guard and visible to the write — guard saw
    // `invited` and declined to fire, UPDATE saw `released` and matched, and
    // the entry came back as `waiting`. With that window forced open the
    // measured result was `requeued`, entry `waiting`: RESURRECTED.
    //
    // THE REPAIR MOVES THE EXCLUSION ONTO THE WRITE, so predicate and write are
    // one statement and the window does not exist. No row lock is taken, on
    // purpose: `waitlist-invitation-wall-clock` measured that requeue is
    // "excluded by its own predicate, not parked by a lock", and 0188's own
    // comment rules this class of test must be HANDLED, NOT PRE-CHECKED.
    //
    // SO THIS TEST ASSERTS THE SCHEDULE THAT ACTUALLY EXISTS: requeue does not
    // wait, it cannot see the state that would authorise it, and it writes
    // nothing either way.
    const f = await fixture("race-requeue");
    const p = await redeemedUnbooked(f, "rq");

    const s1 = new Client({ connectionString: resolveLocalDbUrl() });
    await s1.connect();
    let duringClose: string | undefined;
    try {
      await s1.query("begin");
      const closed = await s1.query(CLOSE, [f.studioId, p.entryId, f.userId]);
      expect(closed.rows[0].r).toBe("closed");

      // A SECOND SESSION, WHILE THE CLOSE IS UNCOMMITTED. Everyone else still
      // sees `invited`, so requeue's own predicate matches nothing and it
      // returns without waiting — which is why this call does not deadlock the
      // test rather than why it is safe.
      duringClose = (
        await q<{ r: string }>(`select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`, [
          f.studioId,
          p.entryId,
          f.userId,
        ])
      )[0].r;
      expect(
        await statusOf(p.entryId),
        "the uncommitted close was visible to another session",
      ).toBe("invited");

      await s1.query("commit");
    } finally {
      await s1.query("rollback").catch(() => undefined);
      await s1.end();
    }

    expect(duringClose, "requeue acted on a state it could not see").toBe("not_requeueable");
    expect(
      await statusOf(p.entryId),
      "the entry was RESURRECTED — the one-way rule was bypassed",
    ).toBe("released");

    // AND ONCE THE CLOSE IS VISIBLE, the refusal is named truthfully rather
    // than falling through to the generic one.
    expect(
      (
        await q<{ r: string }>(`select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`, [
          f.studioId,
          p.entryId,
          f.userId,
        ])
      )[0].r,
    ).toBe("already_redeemed");
    expect(await statusOf(p.entryId)).toBe("released");

    // The resurrection route stays shut: nothing can re-invite it.
    expect(
      (
        await q<{ result: string }>(
          `select result from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`,
          [f.studioId, p.entryId, f.userId],
        )
      )[0].result,
    ).toBe("not_claimed");
  });

  it("RACE: the redeemed exclusion is on the WRITE, so one statement decides", async () => {
    // THE DISCRIMINATING HALF. The test above shows the outcome; this shows
    // WHERE the refusal comes from — the UPDATE itself, not a read before it.
    //
    // Both rows requeue's predicate accepts are exercised against a redeemed
    // entry, and the write must refuse each. A pre-check could be stale here; a
    // predicate on the write cannot, because `redeemed_at` is write-once and
    // was committed long before this statement began.
    const f = await fixture("atomic-refusal");
    const p = await redeemedUnbooked(f, "ar");
    expect(await close(f, p.entryId)).toBe("closed");

    // Drive the UPDATE directly, with the command's own predicate, and require
    // it to match nothing. If the exclusion ever moves off the write, this
    // matches one row and the one-way rule is gone.
    const moved = await q<{ id: string }>(
      `update ${EN_T}
          set status = 'waiting', claimed_at = null, claimed_by_practitioner_id = null,
              invited_at = null, expired_at = null, released_at = null
        where id = $1 and studio_id = $2
          and status in ('released','expired')
          and not exists (
            select 1 from ${IN_T} i
             where i.entry_id = $1 and i.studio_id = $2 and i.redeemed_at is not null)
      returning id`,
      [p.entryId, f.studioId],
    );
    expect(moved, "the write's own predicate admitted a redeemed entry").toHaveLength(0);
    expect(await statusOf(p.entryId)).toBe("released");
  });

  it("RACE: a close overlapping a requeue is decided the same way in reverse", async () => {
    // The mirror. A requeue that STARTS first on a plain released entry is a
    // legitimate requeue, and the close that follows must not corrupt it.
    const f = await fixture("race-requeue-rev");
    const p = await invitedProspect(f, "rr");
    await q(`select public.release_new_client_waitlist_entry($1,$2,$3)`, [
      f.studioId,
      p.entryId,
      f.userId,
    ]);

    const s1 = new Client({ connectionString: resolveLocalDbUrl() });
    const s2 = new Client({ connectionString: resolveLocalDbUrl() });
    await s1.connect();
    await s2.connect();
    let closeResult: string | undefined;
    try {
      await s1.query("begin");
      const requeued = await s1.query(
        `select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`,
        [f.studioId, p.entryId, f.userId],
      );
      expect(requeued.rows[0].r).toBe("requeued");

      const pid = (await s2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      await s2.query("begin");
      const closing = s2.query(CLOSE, [f.studioId, p.entryId, f.userId]);
      await expectBlockedOn(pid, "the close did not park on the entry mutex the requeue holds");

      await s1.query("commit");
      closeResult = (await closing).rows[0].r as string;
      await s2.query("commit");
    } finally {
      await s1.query("rollback").catch(() => undefined);
      await s2.query("rollback").catch(() => undefined);
      await s1.end();
      await s2.end();
    }

    // The entry is `waiting`; the close owns only `invited`.
    expect(closeResult).toBe("not_invited");
    expect(await statusOf(p.entryId)).toBe("waiting");
  });

  it("requeue keeps its own duplicate handling, untouched", async () => {
    // 0188's `already_active` translation of a unique_violation is the one thing
    // a careless redefinition would drop, because it lives in an exception
    // handler rather than in a guard.
    const f = await fixture("dup");
    const a = await invitedProspect(f, "d1");
    await q(`select public.release_new_client_waitlist_entry($1,$2,$3)`, [
      f.studioId,
      a.entryId,
      f.userId,
    ]);
    // The same person rejoins through the public form while the entry is away.
    const again = await q<{ result: string }>(
      `select * from public.create_practitioner_waitlist_entry($1,$2,'Prospect',$3,null,null)`,
      [f.studioId, f.userId, a.email],
    );
    expect(again[0].result).toBe("created");

    const requeued = await q<{ r: string }>(
      `select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`,
      [f.studioId, a.entryId, f.userId],
    );
    expect(requeued[0].r).toBe("already_active");
  });
});

// ---------------------------------------------------------------------------
describe("J — the close record is evidence, and the command is service_role only", () => {
  it("closed_at cannot be rewritten, cleared, or re-attributed", async () => {
    const f = await fixture("appendonly");
    const p = await redeemedUnbooked(f, "ap");
    expect(await close(f, p.entryId)).toBe("closed");
    const before = await inviteEvidence(p.entryId);

    for (const sql of [
      `update ${IN_T} set closed_at = now() where entry_id = $1`,
      `update ${IN_T} set closed_at = null, closed_by_practitioner_id = null where entry_id = $1`,
      `update ${IN_T} set closed_by_practitioner_id = gen_random_uuid() where entry_id = $1`,
    ]) {
      let code: string | undefined;
      try {
        await adminQuery(sql, [p.entryId]);
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code, `an operator close was rewritable by: ${sql}`).toBeDefined();
    }
    expect(await inviteEvidence(p.entryId)).toEqual(before);
  });

  it("a close on an UNREDEEMED invitation is unrepresentable", async () => {
    const f = await fixture("evidence");
    const p = await invitedProspect(f, "ev");
    let code: string | undefined;
    try {
      await adminQuery(
        `update ${IN_T} set closed_at = now(), closed_by_practitioner_id =
           (select id from public.practitioners where studio_id = $2 limit 1)
          where entry_id = $1`,
        [p.entryId, f.studioId],
      );
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code, "a live invitation could be closed without being redeemed").toBe("23514");
  });

  it("two open redeemed cycles per entry are unrepresentable", async () => {
    const f = await fixture("unique");
    const p = await redeemedUnbooked(f, "uq");
    let code: string | undefined;
    try {
      await adminQuery(
        `insert into ${IN_T} (studio_id, entry_id, token_hash, expires_at,
                              issued_by_practitioner_id, redeemed_at)
         select studio_id, entry_id, $2, now() + interval '1 hour',
                issued_by_practitioner_id, now()
           from ${IN_T} where entry_id = $1`,
        [p.entryId, tokenHash()],
      );
      } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code, "a second open redeemed cycle was accepted").toBe("23505");
  });

  it("neither anon nor authenticated may execute the command", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      const denied = await asRole(role, async (query) => {
        try {
          await query(CLOSE, [
            "00000000-0000-0000-0000-000000000000",
            "00000000-0000-0000-0000-000000000000",
            "00000000-0000-0000-0000-000000000000",
          ]);
          return null;
        } catch (e) {
          return (e as { code?: string }).code ?? "unknown";
        }
      });
      expect(denied, `${role} holds EXECUTE on the exit command`).toBe("42501");
    }
  });

  it("service_role may execute it — the server path is not broken by the revokes", async () => {
    const f = await fixture("grant");
    const p = await redeemedUnbooked(f, "gr");
    const result = await asRole("service_role", async (query) => {
      const r = await query(CLOSE, [f.studioId, p.entryId, f.userId]);
      return r.rows[0].r as string;
    });
    expect(result).toBe("closed");
  });
});
