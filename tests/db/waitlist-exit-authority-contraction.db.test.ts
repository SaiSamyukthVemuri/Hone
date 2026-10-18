import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, closePool, resolveLocalDbUrl, seedStudio } from "./helpers/harness";
import { expectBlockedOn } from "./helpers/waitlist-concurrency";

// ===========================================================================
// 0201 — WAIT-P1-EXIT SUCCESSOR: THE EXIT READS NO APPOINTMENT
// ===========================================================================
//
// WHAT CHANGED, AND WHY THE PROOF SHAPE CHANGES WITH IT.
//
// 0200 decided whether to record a missing conversion by scanning
// `public.appointments` with no lock, while holding no lock any appointment
// writer takes. Three findings followed: a cancellation could commit across the
// decision, a qualifying creation could commit across it, and the predicate was
// weaker than 0195's scope rules.
//
// 0201 deletes the scan. So the property under test is no longer "one command
// parks on the other" — it is STRONGER and simpler:
//
//     THE EXIT'S OUTCOME DOES NOT DEPEND ON APPOINTMENTS AT ALL.
//
// Section B proves that by the sharpest available means: an appointment write
// held OPEN and uncommitted in another session, with the exit run against it.
// Under 0200 the exit's answer depended on whether that write had committed.
// Under 0201 the answer is the SAME in both commit orders, because the exit
// never reads the row at all.
//
// A MEASURED CORRECTION, recorded because the obvious stronger claim is false.
// The exit is NOT lock-free with respect to ordinary booking, and an earlier
// draft of this file asserted that it was. Measured: the exit's UPDATE of the
// entry fires `new_client_waitlist_entries_record_event`, which INSERTs the
// audit row; that INSERT takes FOR KEY SHARE on the entry's `studios` row
// through the event table's FK, and `create_public_appointment` holds that same
// studio row FOR UPDATE. So the exit CAN WAIT for an ordinary booking to
// settle. What it cannot do is ANSWER DIFFERENTLY because of one.
//
// That distinction is the whole point, so both halves are proven separately:
// `an UNCOMMITTED ordinary booking does not change the exit's answer` is the
// correctness property, and `the exit waits on the STUDIO row, never on
// appointments` pins the mechanism so a future reader does not re-derive the
// false claim. The wait is pre-existing — 0200 updates the same entry through
// the same trigger — and it cannot deadlock, which section F proves.
//
// Section C is the scope matrix. Every row of it returns `closed`, because the
// exit no longer asks. Under 0200 several of those rows returned
// `converted_instead` and moved the entry to a TERMINAL `converted` state onto
// an appointment 0195 would have refused.
//
// Section F is the regression guard that matters most: the ONE pairing that
// must still serialise — the exit against `create_waitlist_public_appointment`
// — still does, through the entry mutex, in both commit orders. 0201 must not
// buy determinism against ordinary booking by loosening the pair that was
// already correct.
// ===========================================================================

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

const CLOSE = `select public.close_unbooked_new_client_waitlist_invitation($1,$2,$3) as r`;
const BOOK = `select * from public.create_waitlist_public_appointment($1,$2,$3,$4::timestamptz,$5,$6,null,null)`;
/** The ORDINARY public booking route — the one that does not touch the entry. */
const BOOK_ORDINARY = `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`;

const EN_T = "public.new_client_waitlist_entries";
const IN_T = "public.new_client_waitlist_invitations";

afterAll(async () => {
  await closePool();
});

type Fixture = {
  studioId: string;
  userId: string;
  practitionerId: string;
  serviceId: string;
  altServiceId: string;
};

/** A studio that can actually take a public booking: active services + open week. */
async function fixture(label: string): Promise<Fixture> {
  const s = await seedStudio(`p1x201-${label}`);
  const svc = await q<{ id: string }>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
     values ($1,'Consultation',30,true,'consultation') returning id`,
    [s.studioId],
  );
  const alt = await q<{ id: string }>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
     values ($1,'Other Consultation',30,true,'consultation') returning id`,
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
  const r = await q<{ result: string }>(
    `select * from public.open_new_client_waitlist_admission_round($1,$2,20)`,
    [s.studioId, s.userId],
  );
  expect(r[0].result).toBe("opened");
  return {
    studioId: s.studioId,
    userId: s.userId,
    practitionerId: s.practitionerId,
    serviceId: svc[0].id,
    altServiceId: alt[0].id,
  };
}

/** A legal slot from the booking path's own candidate generator. */
async function legalSlot(f: Fixture, nth = 0): Promise<string> {
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
 * A legal slot whose STUDIO-LOCAL date is strictly AFTER `isoDate`.
 *
 * `legalSlot` starts searching two days out and the fixture is open every day,
 * so it returns a slot INSIDE any window wider than a couple of days. Using it
 * for the after-the-window row made that row construct an in-window booking and
 * assert nothing — the row passed for the wrong reason. The studio-local date is
 * the value 0195 compares, so it is the value selected on here.
 */
async function legalSlotAfterLocalDate(f: Fixture, isoDate: string): Promise<string> {
  for (let day = 2; day < 60; day += 1) {
    const when = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
    const cands = await q<{ c: string }>(
      `select c from public.public_booking_slot_candidates($1,$2::date,30) c`,
      [f.studioId, when],
    );
    if (cands.length === 0) continue;
    const local = await studioLocalDate(f, cands[0].c);
    if (local > isoDate) return cands[0].c;
  }
  throw new Error(`no legal slot with a studio-local date after ${isoDate}`);
}

/** The studio-local calendar date of an instant — what 0195's gate compares. */
async function studioLocalDate(f: Fixture, at: string): Promise<string> {
  const r = await q<{ d: string }>(
    `select to_char(($1::timestamptz at time zone s.timezone)::date,'YYYY-MM-DD') as d
       from public.studios s where s.id = $2`,
    [at, f.studioId],
  );
  return r[0].d;
}

/** A legal slot whose STUDIO-LOCAL weekday is (or is not) in `want`. */
async function legalSlotOnWeekday(f: Fixture, want: number[], inSet: boolean): Promise<string> {
  for (let day = 2; day < 40; day += 1) {
    const when = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
    const cands = await q<{ c: string }>(
      `select c from public.public_booking_slot_candidates($1,$2::date,30) c`,
      [f.studioId, when],
    );
    if (cands.length === 0) continue;
    const dow = await q<{ d: number }>(
      `select extract(dow from ($1::timestamptz at time zone s.timezone))::int as d
         from public.studios s where s.id = $2`,
      [cands[0].c, f.studioId],
    );
    if (want.includes(dow[0].d) === inSet) return cands[0].c;
  }
  throw new Error(`no legal slot with weekday ${inSet ? "in" : "outside"} ${want}`);
}

const tokenHash = (): string =>
  (randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 64).padEnd(64, "0");

type Prospect = { entryId: string; email: string; rawToken: string };

/**
 * An entry with a LIVE invitation via a real issuing chain.
 *
 * There are TWO of them, and they differ exactly in whether the invitation
 * carries a scope — which is why `scoped` selects the function, not a parameter:
 *
 *   scoped   `admit_new_client_waitlist_entry` — binds a service and a date
 *            window. It REFUSES a null service (`invalid_service`), so it can
 *            never produce an unscoped invitation.
 *   unscoped `claim_new_client_waitlist_entry` then
 *            `issue_new_client_waitlist_invitation` — the 4-argument issuer,
 *            which takes no scope arguments at all and leaves all four scope
 *            columns NULL.
 *
 * The unscoped shape is the one whose scope gate 0195 skips ENTIRELY — no
 * service, date or weekday check. It is reachable in the shipped schema, so it
 * is built by its real path here rather than assumed away.
 */
async function invitedProspect(
  f: Fixture,
  label: string,
  opts: { scoped?: boolean; from?: string; to?: string; dows?: number[] | null } = {},
): Promise<Prospect> {
  const scoped = opts.scoped ?? true;
  const email = `p-${label}-${f.studioId.slice(0, 8)}@example.com`;
  const e = await q<{ result: string; entry_id: string }>(
    `select * from public.create_practitioner_waitlist_entry($1,$2,'Prospect',$3,null,null)`,
    [f.studioId, f.userId, email],
  );
  expect(e[0].result).toBe("created");

  if (!scoped) {
    const c = await q<{ r: string }>(
      `select public.claim_new_client_waitlist_entry($1,$2,$3) as r`,
      [f.studioId, e[0].entry_id, f.userId],
    );
    expect(c[0].r, "the fixture failed to claim").toBe("claimed");
    const i = await q<{ result: string; raw_token: string }>(
      `select * from public.issue_new_client_waitlist_invitation($1,$2,$3,72)`,
      [f.studioId, e[0].entry_id, f.userId],
    );
    expect(i[0].result, "the fixture failed to issue").toBe("invited");
    await expectUnscoped(e[0].entry_id);
    return { entryId: e[0].entry_id, email, rawToken: i[0].raw_token };
  }

  const from = opts.from ?? new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const to = opts.to ?? new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  const a = await q<{ result: string; raw_token: string }>(
    `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,$7,72)`,
    [f.studioId, f.userId, e[0].entry_id, f.serviceId, from, to, opts.dows ?? null],
  );
  expect(a[0].result, "the fixture failed to admit").toBe("admitted");
  return { entryId: e[0].entry_id, email, rawToken: a[0].raw_token };
}

/** Proves the fixture really built the branch 0195's scope gate skips. */
async function expectUnscoped(entryId: string): Promise<void> {
  const r = await q<{ n: number }>(
    `select count(*)::int as n from ${IN_T}
      where entry_id = $1 and closed_at is null
        and scope_service_id is null and scope_start_date is null
        and scope_end_date is null and scope_allowed_weekdays is null`,
    [entryId],
  );
  expect(r[0].n, "the unscoped fixture did not produce an unscoped invitation").toBe(1);
}

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
async function redeemedUnbooked(
  f: Fixture,
  label: string,
  opts: Parameters<typeof invitedProspect>[2] = {},
): Promise<Prospect> {
  const p = await invitedProspect(f, label, opts);
  await redeem(p);
  expect(await statusOf(p.entryId)).toBe("invited");
  return p;
}

const statusOf = async (entryId: string): Promise<string> =>
  (await q<{ status: string }>(`select status from ${EN_T} where id = $1`, [entryId]))[0].status;

const close = async (f: Fixture, entryId: string, actor = f.userId): Promise<string> =>
  (await q<{ r: string }>(CLOSE, [f.studioId, entryId, actor]))[0].r;

/** The client the booking authority itself creates or matches for an address. */
const clientFor = async (f: Fixture, email: string): Promise<string> =>
  (
    await q<{ client_id: string }>(
      `select * from public.find_or_create_client_for_booking($1,$2,'Prospect',null)`,
      [f.studioId, email],
    )
  )[0].client_id;

/** Book by the ORDINARY route — no entry id, so nothing touches the entry mutex. */
async function bookOrdinary(
  f: Fixture,
  clientId: string,
  startsAt: string,
  serviceId = f.serviceId,
): Promise<string> {
  const r = await q<{ result: string; appointment_id: string | null }>(BOOK_ORDINARY, [
    f.studioId,
    clientId,
    serviceId,
    startsAt,
    tokenHash(),
  ]);
  expect(r[0].result, "the ordinary booking fixture failed").toBe("created");
  return r[0].appointment_id as string;
}

/** The instant an appointment starts — the value 0195's date gate reads. */
const apptStartOf = async (id: string): Promise<string> =>
  (
    await q<{ s: string }>(
      `select starts_at::text as s from public.appointments where id = $1`,
      [id],
    )
  )[0].s;

const apptStatus = async (id: string): Promise<string> =>
  (await q<{ status: string }>(`select status from public.appointments where id = $1`, [id]))[0]
    .status;

const convertedClientOf = async (entryId: string): Promise<string | null> =>
  (
    await q<{ c: string | null }>(
      `select converted_client_id::text as c from ${EN_T} where id = $1`,
      [entryId],
    )
  )[0].c;

// ---------------------------------------------------------------------------
describe("A — the exit still does its job", () => {
  it("closes the cycle and releases the entry, with no appointment anywhere", async () => {
    const f = await fixture("plain");
    const p = await redeemedUnbooked(f, "pl");
    expect(await close(f, p.entryId)).toBe("closed");
    expect(await statusOf(p.entryId)).toBe("released");
    const ev = await q<{ closed_at: string | null; closed_by: string | null }>(
      `select closed_at::text, closed_by_practitioner_id::text as closed_by from ${IN_T} where entry_id = $1`,
      [p.entryId],
    );
    expect(ev[0].closed_at).not.toBeNull();
    expect(ev[0].closed_by).not.toBeNull();
  });

  it("a second call answers already_closed and changes nothing", async () => {
    const f = await fixture("idem");
    const p = await redeemedUnbooked(f, "id");
    expect(await close(f, p.entryId)).toBe("closed");
    const before = await q<{ c: string }>(`select closed_at::text as c from ${IN_T} where entry_id=$1`, [p.entryId]);
    expect(await close(f, p.entryId)).toBe("already_closed");
    const after = await q<{ c: string }>(`select closed_at::text as c from ${IN_T} where entry_id=$1`, [p.entryId]);
    expect(after[0].c).toBe(before[0].c);
  });
});

// ---------------------------------------------------------------------------
describe("B — FINDINGS 1 AND 2: the exit does not depend on appointments", () => {
  it("an UNCOMMITTED ordinary booking does not change the exit's answer", async () => {
    // THE DECISIVE PROOF. Under 0200 the exit's answer depended on whether this
    // insert had committed: visible -> `converted_instead`, invisible ->
    // `closed`. Under 0201 the insert is invisible to the decision in BOTH
    // states, so the answer cannot turn on when it commits.
    //
    // The exit runs on its OWN session, not the shared pool, so that a wait is
    // observed as a wait rather than as pool starvation.
    const f = await fixture("uncommitted-create");
    const p = await redeemedUnbooked(f, "uc");
    const clientId = await clientFor(f, p.email);
    const slot = await legalSlot(f);

    const writer = new Client({ connectionString: resolveLocalDbUrl() });
    const exiter = new Client({ connectionString: resolveLocalDbUrl() });
    await writer.connect();
    await exiter.connect();
    try {
      await writer.query("begin");
      const ins = await writer.query(BOOK_ORDINARY, [f.studioId, clientId, f.serviceId, slot, tokenHash()]);
      expect(ins.rows[0].result).toBe("created");

      // The exit is issued WHILE the booking is still uncommitted and holds its
      // locks. It may wait (see the next test for exactly what on); it may not
      // answer anything other than `closed`.
      const pending = exiter
        .query(CLOSE, [f.studioId, p.entryId, f.userId])
        .then((r) => r.rows[0].r as string);
      await writer.query("commit");
      expect(await pending, "the exit answered on an appointment it must not read").toBe("closed");
    } finally {
      await writer.query("rollback").catch(() => undefined);
      await writer.end();
      await exiter.end();
    }

    // Terminal state: the entry closed, the appointment stands and is untouched.
    expect(await statusOf(p.entryId)).toBe("released");
    expect(await convertedClientOf(p.entryId)).toBeNull();
    const appts = await q<{ c: number }>(
      `select count(*)::int as c from public.appointments where studio_id=$1 and client_id=$2 and status <> 'cancelled'`,
      [f.studioId, clientId],
    );
    expect(appts[0].c, "the ordinary appointment must survive untouched").toBe(1);
  });

  it("the exit waits on the STUDIO row via the audit-trail FK, never on appointments", async () => {
    // PINS THE MECHANISM. The exit is not lock-free against ordinary booking,
    // and the reason is not the appointment: updating the entry fires
    // `new_client_waitlist_entries_record_event`, whose INSERT into
    // `new_client_waitlist_entry_events` takes FOR KEY SHARE on the studio row
    // that `create_public_appointment` holds FOR UPDATE.
    //
    // This test exists so that a future reader who sees the wait does not
    // conclude the appointment scan came back. It asserts the blocker is the
    // booking session AND that the exit still cannot read appointments — the
    // static guard for which is the 0201 source-contract suite.
    const f = await fixture("wait-cause");
    const p = await redeemedUnbooked(f, "wc");
    const clientId = await clientFor(f, p.email);
    const slot = await legalSlot(f);

    const writer = new Client({ connectionString: resolveLocalDbUrl() });
    const exiter = new Client({ connectionString: resolveLocalDbUrl() });
    const observer = new Client({ connectionString: resolveLocalDbUrl() });
    await writer.connect();
    await exiter.connect();
    await observer.connect();
    try {
      const writerPid = (await writer.query("select pg_backend_pid() as p")).rows[0].p as number;
      const exitPid = (await exiter.query("select pg_backend_pid() as p")).rows[0].p as number;

      await writer.query("begin");
      // Take ONLY the studio row, by the same mode the booking path takes it.
      // Nothing is inserted into `appointments` at all, so if the exit still
      // waits, no appointment row can be the cause.
      await writer.query(`select 1 from public.studios where id = $1 for update`, [f.studioId]);

      const pending = exiter
        .query(CLOSE, [f.studioId, p.entryId, f.userId])
        .then((r) => r.rows[0].r as string);
      await new Promise((r) => setTimeout(r, 1_200));

      const w = await observer.query(
        `select wait_event_type, pg_blocking_pids(pid) as blockers
           from pg_stat_activity where pid = $1`,
        [exitPid],
      );
      expect(w.rows[0]?.wait_event_type, "the exit did not wait on the studio row alone").toBe("Lock");
      expect(w.rows[0]?.blockers, "the studio-row holder must be the blocker").toEqual([writerPid]);

      // No appointment exists for this studio, so the wait cannot be an
      // appointment read — the positive control for the claim above.
      const a = await observer.query(
        `select count(*)::int as c from public.appointments where studio_id = $1`,
        [f.studioId],
      );
      expect(a.rows[0].c, "the control requires that no appointment exist").toBe(0);

      await writer.query("commit");
      expect(await pending).toBe("closed");
    } finally {
      await writer.query("rollback").catch(() => undefined);
      await writer.end();
      await exiter.end();
      await observer.end();
    }
  });

  it("ORDER A — a committed qualifying booking first: the exit still closes and converts nothing", async () => {
    const f = await fixture("order-a");
    const p = await redeemedUnbooked(f, "oa");
    const clientId = await clientFor(f, p.email);
    const apptId = await bookOrdinary(f, clientId, await legalSlot(f));

    expect(await close(f, p.entryId)).toBe("closed");
    expect(await statusOf(p.entryId)).toBe("released");
    expect(
      await convertedClientOf(p.entryId),
      "0200 converted the entry onto an ORDINARY booking here — finding 3",
    ).toBeNull();
    expect(await apptStatus(apptId)).toBe("confirmed");
  });

  it("ORDER B — the exit first, then the booking: identical terminal state", async () => {
    const f = await fixture("order-b");
    const p = await redeemedUnbooked(f, "ob");
    const clientId = await clientFor(f, p.email);

    expect(await close(f, p.entryId)).toBe("closed");
    const apptId = await bookOrdinary(f, clientId, await legalSlot(f));

    expect(await statusOf(p.entryId)).toBe("released");
    expect(await convertedClientOf(p.entryId)).toBeNull();
    expect(await apptStatus(apptId)).toBe("confirmed");
  });

  it("FINDING 1 — an UNCOMMITTED cancellation does not block the exit either", async () => {
    // The practitioner cancel path takes ONLY the appointment row — no studio
    // lock — so a studio-lock repair would never have reached it. The exit
    // reaches it by not caring.
    const f = await fixture("uncommitted-cancel");
    const p = await redeemedUnbooked(f, "ux");
    const clientId = await clientFor(f, p.email);
    const apptId = await bookOrdinary(f, clientId, await legalSlot(f));

    const s1 = new Client({ connectionString: resolveLocalDbUrl() });
    await s1.connect();
    try {
      await s1.query("begin");
      await s1.query(
        `select public.practitioner_cancel_appointment($1,$2,$3,'operator test') as r`,
        [apptId, f.studioId, f.practitionerId],
      );
      const answered = await Promise.race([
        close(f, p.entryId),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error("the exit BLOCKED on a cancellation")), 4000)),
      ]);
      expect(answered).toBe("closed");
      await s1.query("commit");
    } finally {
      await s1.query("rollback").catch(() => undefined);
      await s1.end();
    }

    expect(await statusOf(p.entryId)).toBe("released");
    expect(await convertedClientOf(p.entryId)).toBeNull();
    expect(await apptStatus(apptId)).toBe("cancelled");
  });

  it("ORDER A/B for cancellation — the terminal state is the same either way", async () => {
    for (const cancelFirst of [true, false]) {
      const f = await fixture(`cx-${cancelFirst ? "cf" : "xf"}`);
      const p = await redeemedUnbooked(f, cancelFirst ? "cf" : "xf");
      const clientId = await clientFor(f, p.email);
      const apptId = await bookOrdinary(f, clientId, await legalSlot(f));

      if (cancelFirst) {
        await q(`select public.practitioner_cancel_appointment($1,$2,$3,'t') as r`, [
          apptId,
          f.studioId,
          f.practitionerId,
        ]);
        expect(await close(f, p.entryId)).toBe("closed");
      } else {
        expect(await close(f, p.entryId)).toBe("closed");
        await q(`select public.practitioner_cancel_appointment($1,$2,$3,'t') as r`, [
          apptId,
          f.studioId,
          f.practitionerId,
        ]);
      }

      expect(await statusOf(p.entryId)).toBe("released");
      expect(await convertedClientOf(p.entryId)).toBeNull();
      expect(await apptStatus(apptId)).toBe("cancelled");
    }
  });
});

// ---------------------------------------------------------------------------
describe("C — FINDING 3: the scope matrix, every row of which now closes", () => {
  // Each row constructs an appointment 0195 would have JUDGED, then asserts the
  // exit is indifferent to it. Under 0200 the rows marked below returned
  // `converted_instead` and moved the entry to a TERMINAL `converted`.
  // The two scope bounds are named so the premise check below can compare the
  // booking's studio-local date against the SAME value the invitation carries.
  const AFTER_WINDOW_END = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const BEFORE_WINDOW_START = new Date(Date.now() + 25 * 86_400_000).toISOString().slice(0, 10);

  const rows: Array<{
    name: string;
    build: (f: Fixture, p: Prospect) => Promise<string>;
    scoped?: Parameters<typeof invitedProspect>[2];
    outsideWindow?: "before" | "after";
  }> = [
    {
      name: "exact service, inside the window, allowed weekday",
      build: async (f, p) => bookOrdinary(f, await clientFor(f, p.email), await legalSlot(f)),
    },
    {
      name: "WRONG service — 0195 answers scope_service_not_offered",
      build: async (f, p) =>
        bookOrdinary(f, await clientFor(f, p.email), await legalSlot(f), f.altServiceId),
    },
    {
      name: "AFTER scope_end_date — 0195 answers scope_date_out_of_range",
      scoped: { to: AFTER_WINDOW_END },
      outsideWindow: "after",
      build: async (f, p) =>
        bookOrdinary(
          f,
          await clientFor(f, p.email),
          await legalSlotAfterLocalDate(f, AFTER_WINDOW_END),
        ),
    },
    {
      name: "BEFORE scope_start_date — 0195 answers scope_date_out_of_range",
      scoped: { from: BEFORE_WINDOW_START },
      outsideWindow: "before",
      build: async (f, p) => bookOrdinary(f, await clientFor(f, p.email), await legalSlot(f)),
    },
    {
      name: "DISALLOWED weekday — 0195 answers scope_weekday_not_allowed",
      scoped: { dows: [1] },
      build: async (f, p) =>
        bookOrdinary(f, await clientFor(f, p.email), await legalSlotOnWeekday(f, [1], false)),
    },
    {
      name: "ALLOWED weekday",
      scoped: { dows: [0, 1, 2, 3, 4, 5, 6] },
      build: async (f, p) =>
        bookOrdinary(f, await clientFor(f, p.email), await legalSlotOnWeekday(f, [0, 1, 2, 3, 4, 5, 6], true)),
    },
    {
      name: "UNSCOPED invitation — 0195 skips its whole scope gate",
      scoped: { scoped: false },
      build: async (f, p) => bookOrdinary(f, await clientFor(f, p.email), await legalSlot(f)),
    },
  ];

  for (const [i, row] of rows.entries()) {
    it(`${row.name} -> closed, entry NOT converted, appointment untouched`, async () => {
      const f = await fixture(`sc${i}`);
      const p = await redeemedUnbooked(f, `s${i}`, row.scoped ?? {});
      const apptId = await row.build(f, p);

      // PREMISE CHECK. A row named for a date outside the scope window must
      // actually have built one. The after-the-window row previously did not —
      // it booked INSIDE the window and still passed, because 0201 answers
      // `closed` either way, so the assertion could not tell the difference.
      // Constructing the scenario and asserting the outcome are separate
      // obligations, and only this check discharges the first.
      if (row.outsideWindow) {
        const local = await studioLocalDate(f, await apptStartOf(apptId));
        if (row.outsideWindow === "after") {
          expect(
            local > AFTER_WINDOW_END,
            `this row must book AFTER ${AFTER_WINDOW_END}, but booked ${local}`,
          ).toBe(true);
        } else {
          expect(
            local < BEFORE_WINDOW_START,
            `this row must book BEFORE ${BEFORE_WINDOW_START}, but booked ${local}`,
          ).toBe(true);
        }
      }

      expect(await close(f, p.entryId)).toBe("closed");
      expect(await statusOf(p.entryId)).toBe("released");
      expect(
        await convertedClientOf(p.entryId),
        "the exit converted the entry onto an appointment it must not judge",
      ).toBeNull();
      expect(await apptStatus(apptId)).toBe("confirmed");
    });
  }

  it("an UNRELATED appointment created after redemption is equally irrelevant", async () => {
    // 0200 matched on (client, created_at >= redeemed_at, not cancelled) and
    // would have converted onto this.
    const f = await fixture("unrelated");
    const p = await redeemedUnbooked(f, "ur");
    const clientId = await clientFor(f, p.email);
    const apptId = await bookOrdinary(f, clientId, await legalSlot(f, 1), f.altServiceId);

    expect(await close(f, p.entryId)).toBe("closed");
    expect(await convertedClientOf(p.entryId)).toBeNull();
    expect(await apptStatus(apptId)).toBe("confirmed");
  });

  it("a CANCELLED appointment is equally irrelevant — for a new reason", async () => {
    // 0200 skipped cancelled rows deliberately. 0201 skips ALL rows, so this
    // passes for a simpler reason and must keep passing.
    const f = await fixture("cancelled");
    const p = await redeemedUnbooked(f, "ca");
    const clientId = await clientFor(f, p.email);
    const apptId = await bookOrdinary(f, clientId, await legalSlot(f));
    await q(`select public.practitioner_cancel_appointment($1,$2,$3,'t') as r`, [
          apptId,
          f.studioId,
          f.practitionerId,
        ]);

    expect(await close(f, p.entryId)).toBe("closed");
    expect(await statusOf(p.entryId)).toBe("released");
  });
});

// ---------------------------------------------------------------------------
describe("D — the refusals the exit still owes", () => {
  it("a CONVERTED entry answers already_booked and writes nothing", async () => {
    const f = await fixture("converted");
    const p = await redeemedUnbooked(f, "cv");
    const clientId = await clientFor(f, p.email);
    const booked = await q<{ result: string }>(BOOK, [
      f.studioId, clientId, f.serviceId, await legalSlot(f), tokenHash(), p.entryId,
    ]);
    expect(booked[0].result).toBe("created_and_converted");
    expect(await statusOf(p.entryId)).toBe("converted");

    expect(await close(f, p.entryId)).toBe("already_booked");
    expect(await statusOf(p.entryId)).toBe("converted");
    const ev = await q<{ c: string | null }>(`select closed_at::text as c from ${IN_T} where entry_id=$1`, [p.entryId]);
    expect(ev[0].c, "already_booked must write nothing").toBeNull();
  });

  it("an UNREDEEMED invitation answers not_redeemed and leaves release working", async () => {
    const f = await fixture("unredeemed");
    const p = await invitedProspect(f, "un");
    expect(await close(f, p.entryId)).toBe("not_redeemed");
    expect(await statusOf(p.entryId)).toBe("invited");
    const rel = await q<{ r: string }>(
      `select public.release_new_client_waitlist_entry($1,$2,$3) as r`,
      [f.studioId, p.entryId, f.userId],
    );
    expect(rel[0].r).toBe("released");
  });

  it("a WAITING entry, never invited, answers not_invited", async () => {
    const f = await fixture("waiting");
    const e = await q<{ entry_id: string }>(
      `select * from public.create_practitioner_waitlist_entry($1,$2,'W',$3,null,null)`,
      [f.studioId, f.userId, `w-${f.studioId.slice(0, 8)}@example.com`],
    );
    expect(await close(f, e[0].entry_id)).toBe("not_invited");
  });
});

// ---------------------------------------------------------------------------
describe("E — tenancy and privilege", () => {
  it("another studio's entry id is not found, and is not touched", async () => {
    const a = await fixture("ten-a");
    const b = await fixture("ten-b");
    const p = await redeemedUnbooked(a, "ta");
    // b's owner, a's entry.
    expect(await close(b, p.entryId, b.userId)).toBe("not_found");
    expect(await statusOf(p.entryId)).toBe("invited");
  });

  it("an actor from another studio is not a member here", async () => {
    const a = await fixture("ten-c");
    const b = await fixture("ten-d");
    const p = await redeemedUnbooked(a, "tc");
    const r = await close(a, p.entryId, b.userId);
    expect(r).not.toBe("closed");
    expect(await statusOf(p.entryId)).toBe("invited");
  });

  it("EXECUTE is service_role only — anon and authenticated are refused", async () => {
    // The source test cannot see this; 0197's lesson was that 182 passing
    // admin-connection assertions missed exactly this class.
    for (const role of ["anon", "authenticated"] as const) {
      await expect(
        asRole(role, async (run) => run(CLOSE, [randomUUID(), randomUUID(), randomUUID()])),
        `${role} must not hold EXECUTE on the exit`,
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it("the browser cannot reach the invitation's protected columns", async () => {
    // 0200 granted `authenticated` SELECT on closed_at + closed_by only. 0201
    // changes no table privilege, and this pins that it did not widen one.
    await expect(
      asRole("authenticated", async (run) => run(`select token_hash from ${IN_T} limit 1`)),
    ).rejects.toThrow(/permission denied/i);
  });
});

// ---------------------------------------------------------------------------
describe("F — REGRESSION: the one pairing that must still serialise", () => {
  it("exit first: the waitlist booking parks on the entry mutex, then refuses", async () => {
    // 0201 must not buy determinism against ordinary booking by loosening the
    // pair that was already correct. `create_waitlist_public_appointment` takes
    // the SAME entry row FOR UPDATE, so these two still exclude each other.
    const f = await fixture("reg-exit");
    const p = await redeemedUnbooked(f, "rx");
    const clientId = await clientFor(f, p.email);
    const slot = await legalSlot(f);

    const s1 = new Client({ connectionString: resolveLocalDbUrl() });
    const s2 = new Client({ connectionString: resolveLocalDbUrl() });
    await s1.connect();
    await s2.connect();
    try {
      await s1.query("begin");
      expect((await s1.query(CLOSE, [f.studioId, p.entryId, f.userId])).rows[0].r).toBe("closed");

      const pid = (await s2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      await s2.query("begin");
      const booking = s2.query(BOOK, [f.studioId, clientId, f.serviceId, slot, tokenHash(), p.entryId]);
      await expectBlockedOn(pid, "the waitlist booking did not park on the entry mutex the exit holds");

      await s1.query("commit");
      const booked = await booking;
      await s2.query("commit");
      expect(booked.rows[0].result).not.toBe("created_and_converted");
    } finally {
      await s1.query("rollback").catch(() => undefined);
      await s2.query("rollback").catch(() => undefined);
      await s1.end();
      await s2.end();
    }

    expect(await statusOf(p.entryId)).toBe("released");
  });

  it("booking first: the exit answers already_booked and the appointment stands", async () => {
    const f = await fixture("reg-book");
    const p = await redeemedUnbooked(f, "rb");
    const clientId = await clientFor(f, p.email);
    const slot = await legalSlot(f);

    const s1 = new Client({ connectionString: resolveLocalDbUrl() });
    const s2 = new Client({ connectionString: resolveLocalDbUrl() });
    await s1.connect();
    await s2.connect();
    try {
      await s1.query("begin");
      const booked = await s1.query(BOOK, [f.studioId, clientId, f.serviceId, slot, tokenHash(), p.entryId]);
      expect(booked.rows[0].result).toBe("created_and_converted");

      const pid = (await s2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      await s2.query("begin");
      const exiting = s2.query(CLOSE, [f.studioId, p.entryId, f.userId]);
      await expectBlockedOn(pid, "the exit did not park on the entry mutex the booking holds");

      await s1.query("commit");
      expect((await exiting).rows[0].r).toBe("already_booked");
      await s2.query("commit");
    } finally {
      await s1.query("rollback").catch(() => undefined);
      await s2.query("rollback").catch(() => undefined);
      await s1.end();
      await s2.end();
    }

    expect(await statusOf(p.entryId)).toBe("converted");
  });

  it("two concurrent exits produce one close and one already_closed", async () => {
    const f = await fixture("reg-two");
    const p = await redeemedUnbooked(f, "rt");

    const s1 = new Client({ connectionString: resolveLocalDbUrl() });
    const s2 = new Client({ connectionString: resolveLocalDbUrl() });
    await s1.connect();
    await s2.connect();
    try {
      await s1.query("begin");
      expect((await s1.query(CLOSE, [f.studioId, p.entryId, f.userId])).rows[0].r).toBe("closed");

      const pid = (await s2.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      await s2.query("begin");
      const second = s2.query(CLOSE, [f.studioId, p.entryId, f.userId]);
      await expectBlockedOn(pid, "the second exit did not park on the entry mutex");

      await s1.query("commit");
      expect((await second).rows[0].r).toBe("already_closed");
      await s2.query("commit");
    } finally {
      await s1.query("rollback").catch(() => undefined);
      await s2.query("rollback").catch(() => undefined);
      await s1.end();
      await s2.end();
    }

    const ev = await q<{ n: number }>(
      `select count(*)::int as n from ${IN_T} where entry_id=$1 and closed_at is not null`,
      [p.entryId],
    );
    expect(ev[0].n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("G — invariants 0201 must not have loosened", () => {
  it("requeue still refuses a closed cycle — the one-redeemed-cycle invariant", async () => {
    const f = await fixture("requeue");
    const p = await redeemedUnbooked(f, "rq");
    expect(await close(f, p.entryId)).toBe("closed");
    const r = await q<{ r: string }>(
      `select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`,
      [f.studioId, p.entryId, f.userId],
    );
    expect(r[0].r, "a spent cycle must not re-enter the queue").toBe("already_redeemed");
    expect(await statusOf(p.entryId)).toBe("released");
  });

  it("the admission seat is NOT recycled — 0192 rules it spent from redemption", async () => {
    const f = await fixture("seat");
    const p = await redeemedUnbooked(f, "st");
    const roundId = (
      await q<{ id: string }>(
        `select id from public.studio_waitlist_admission_rounds where studio_id=$1 and closed_at is null`,
        [f.studioId],
      )
    )[0].id;
    const before = (
      await q<{ c: number }>(`select public.read_waitlist_admission_round_consumed($1,$2) as c`, [f.studioId, roundId])
    )[0].c;
    expect(await close(f, p.entryId)).toBe("closed");
    const after = (
      await q<{ c: number }>(`select public.read_waitlist_admission_round_consumed($1,$2) as c`, [f.studioId, roundId])
    )[0].c;
    expect(after, "closing must not hand the seat back").toBe(before);
  });

  it("the redemption token stays permanently unusable", async () => {
    const f = await fixture("token");
    const p = await redeemedUnbooked(f, "tk");
    expect(await close(f, p.entryId)).toBe("closed");
    const again = await q<{ result: string }>(
      `select * from public.redeem_new_client_waitlist_invitation_verified($1,$2)`,
      [p.rawToken, "whatever"],
    );
    expect(again[0].result).not.toBe("redeemed");
  });
});
