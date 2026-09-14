import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminQuery, closePool, resolveLocalDbUrl, seedStudio } from "./helpers/harness";

/** `adminQuery` returns a QueryResult; every assertion here works on rows. */
const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];
import { waitUntilBlocked } from "./helpers/waitlist-concurrency";

// ===========================================================================
// 0195 — ATOMIC INVITATION BOOKING + CONVERSION
// ===========================================================================
//
// WHAT THIS PROVES. `create_waitlist_public_appointment` creates the
// appointment, its mandatory audit row and the waitlist conversion in ONE
// transaction, so the state "appointment exists AND entry.status = 'invited'"
// is unreachable. Before 0195 the application ran three transactions and a
// process death between the second and third left that state permanently.
//
// HOW THE CONCURRENCY CASES ARE SCHEDULED, AND ONE RULE THAT MATTERS.
// A harness may pre-take a lock for a participant ONLY if it is the first lock
// that participant's own command takes. For a standalone conversion the entry
// qualifies (its statements are entry -> invitation). For THIS command it does
// NOT, because this command takes the studio first. Applying an entry-first
// prefix to it manufactures a cycle no caller can produce — that mistake was
// made once and reported as a lock-policy defect it was not.
//
// Each participant also owns BEGIN -> work -> COMMIT/ROLLBACK. Deferring both
// commits until after a race resolves makes a blocked participant wait on a
// transaction that cannot end until it returns; that reports as a timeout and
// proves nothing.
// ===========================================================================

const BOOK = `select * from public.create_waitlist_public_appointment($1,$2,$3,$4::timestamptz,$5,$6,null,null)`;
const CONVERT = `select public.record_new_client_waitlist_conversion($1,$2,$3) as r`;

afterAll(async () => {
  await closePool();
});

type Fixture = {
  studioId: string; userId: string; clientId: string; serviceId: string;
};

/** A studio that can actually take a public booking: active service + open week. */
async function fixture(label: string): Promise<Fixture> {
  const s = await seedStudio(`atomic-${label}`);
  const svc = await q<any>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
     values ($1,'Consultation',30,true,'consultation') returning id`,
    [s.studioId],
  );
  for (let d = 0; d < 7; d += 1) {
    await q<any>(
      `insert into public.studio_availability_default
         (studio_id,day_of_week,is_open,open_time,close_time,practitioner_id)
       values ($1,$2,true,'08:00','20:00',null)`,
      [s.studioId, d],
    );
  }
  await q<any>(
    `select * from public.open_new_client_waitlist_admission_round($1,$2,20)`,
    [s.studioId, s.userId],
  );
  return { studioId: s.studioId, userId: s.userId, clientId: s.clientId, serviceId: svc[0].id };
}

/** A legal slot, taken from the booking path's own candidate generator. */
async function legalSlot(f: Fixture, nth: number): Promise<string> {
  for (let day = 2; day < 30; day += 1) {
    const when = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
    const cands = await q<any>(
      `select c from public.public_booking_slot_candidates($1,$2::date,30) c`,
      [f.studioId, when],
    );
    if (cands.length > nth) return cands[nth].c;
  }
  throw new Error("no legal slot");
}

/** A studio-LOCAL date, derived in SQL so no JS timezone assumption creeps in. */
async function studioDate(f: Fixture, plusDays: number): Promise<string> {
  const r = await q<any>(
    `select ((now() at time zone s.timezone)::date + $2::int)::text as d
       from public.studios s where s.id = $1`,
    [f.studioId, plusDays],
  );
  return r[0].d as string;
}

/** The nth bookable candidate ON a specific studio-local date, or null. */
async function slotOnDate(f: Fixture, date: string, nth = 0): Promise<string | null> {
  const c = await q<any>(
    `select c from public.public_booking_slot_candidates($1,$2::date,30) c`,
    [f.studioId, date],
  );
  return c.length > nth ? (c[nth].c as string) : null;
}

/** An instant on a permitted date but at a closed hour — refused by the booking
 *  command itself, not by scope. */
async function closedHourOn(f: Fixture, date: string): Promise<string> {
  const r = await q<any>(
    `select (($2::date + time '03:00') at time zone s.timezone)::text as t
       from public.studios s where s.id = $1`,
    [f.studioId, date],
  );
  return r[0].t as string;
}

/** The studio-local weekday (0 = Sunday, matching 0192's contract) of an instant. */
async function dowOf(f: Fixture, instant: string): Promise<number> {
  const r = await q<any>(
    `select extract(dow from ($2::timestamptz at time zone s.timezone))::int as d
       from public.studios s where s.id = $1`,
    [f.studioId, instant],
  );
  return r[0].d as number;
}

const tokenHash = (seed: string): string =>
  Array.from({ length: 64 }, (_, i) => "0123456789abcdef"[(seed.charCodeAt(i % seed.length) + i) % 16]).join("");

/**
 * Drive the REAL chain to an invited + redeemed entry: admit -> proof -> redeem.
 *
 * Returns the entry's EMAIL as well as its id, because 0195 binds the booking
 * client to the entry's stored address. A test that books some other client is
 * not testing this command's happy path — it is testing the defect.
 */
async function redeemedEntry(
  f: Fixture, label: string,
): Promise<{ entryId: string; email: string }> {
  const email = `w-${label}-${f.studioId.slice(0, 8)}@example.com`;
  const e = await q<any>(
    `select * from public.create_practitioner_waitlist_entry($1,$2,'Prospect',$3,null,null)`,
    [f.studioId, f.userId, email],
  );
  expect(e[0].result).toBe("created");
  const from = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const a = await q<any>(
    `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,null,72)`,
    [f.studioId, f.userId, e[0].entry_id, f.serviceId, from, to],
  );
  expect(a[0].result).toBe("admitted");
  const b = await q<any>(
    `select * from public.begin_waitlist_invitation_proof($1,20)`, [a[0].raw_token],
  );
  const c = await q<any>(
    `select * from public.complete_waitlist_invitation_proof($1,$2)`, [a[0].raw_token, b[0].raw_challenge],
  );
  const r = await q<any>(
    `select * from public.redeem_new_client_waitlist_invitation_verified($1,$2)`,
    [a[0].raw_token, c[0].raw_capability],
  );
  expect(r[0].result).toBe("redeemed");
  return { entryId: r[0].entry_id as string, email };
}

/**
 * Resolve the booking client the way the booking path itself does — 0032's
 * `find_or_create_client_for_booking`, which matches on normalized email within
 * the studio and inserts only when there is no match. Using the repository's own
 * resolver is what makes the binding test meaningful: it proves the EXISTING and
 * NEW client paths both satisfy 0195, rather than hand-building a row that
 * happens to match.
 */
async function bookingClient(
  f: Fixture, email: string,
): Promise<{ clientId: string; created: boolean }> {
  const r = await q<any>(
    `select * from public.find_or_create_client_for_booking($1,$2,'Prospect',null)`,
    [f.studioId, email],
  );
  return { clientId: r[0].client_id as string, created: r[0].client_created_during_call as boolean };
}

/**
 * A redeemed entry whose invitation carries an EXPLICIT offer scope. 0192 §2
 * stores the offer server-side — scope_service_id, scope_start_date,
 * scope_end_date, scope_allowed_weekdays — precisely so a substituted service
 * or date cannot widen permission.
 */
async function redeemedScopedEntry(
  f: Fixture,
  label: string,
  scope: { serviceId: string; from: string; to: string; weekdays: number[] | null },
): Promise<{ entryId: string; email: string }> {
  const email = `s-${label}-${f.studioId.slice(0, 8)}@example.com`;
  const e = await q<any>(
    `select * from public.create_practitioner_waitlist_entry($1,$2,'Prospect',$3,null,null)`,
    [f.studioId, f.userId, email],
  );
  expect(e[0].result).toBe("created");
  const a = await q<any>(
    `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,$7::smallint[],72)`,
    [f.studioId, f.userId, e[0].entry_id, scope.serviceId, scope.from, scope.to, scope.weekdays],
  );
  expect(a[0].result).toBe("admitted");
  const b = await q<any>(`select * from public.begin_waitlist_invitation_proof($1,20)`, [a[0].raw_token]);
  const c = await q<any>(
    `select * from public.complete_waitlist_invitation_proof($1,$2)`, [a[0].raw_token, b[0].raw_challenge],
  );
  const r = await q<any>(
    `select * from public.redeem_new_client_waitlist_invitation_verified($1,$2)`,
    [a[0].raw_token, c[0].raw_capability],
  );
  expect(r[0].result).toBe("redeemed");
  return { entryId: r[0].entry_id as string, email };
}

/** A second, genuinely bookable service in the same studio. */
async function extraService(f: Fixture, name: string): Promise<string> {
  const r = await q<any>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
     values ($1,$2,30,true,'consultation') returning id`,
    [f.studioId, name],
  );
  return r[0].id as string;
}

const apptById = (id: string) =>
  q<any>(`select id, client_id from public.appointments where id=$1`, [id]);
const auditFor = (id: string) =>
  q<any>(`select count(*)::int as n from public.appointment_audit where appointment_id=$1`, [id]);
const apptCount = (sid: string) =>
  q<any>(`select count(*)::int as n from public.appointments where studio_id=$1`, [sid])
    .then((r) => r[0].n);
const auditCount = (sid: string) =>
  q<any>(`select count(*)::int as n from public.appointment_audit where studio_id=$1`, [sid])
    .then((r) => r[0].n);
const entryRow = (id: string) =>
  q<any>(
    `select status, converted_at, converted_client_id from public.new_client_waitlist_entries where id=$1`, [id],
  ).then((r) => r[0]);

describe("0195 — one transaction: appointment, audit and conversion", () => {
  it("commits all three, and the entry converts to the resolved client", async () => {
    const f = await fixture("ok");
    const { entryId, email } = await redeemedEntry(f, "ok");
    const { clientId } = await bookingClient(f, email);
    const slot = await legalSlot(f, 0);

    const r = await q<any>(
      BOOK, [f.studioId, clientId, f.serviceId, slot, tokenHash("ok"), entryId],
    );
    expect(r[0].result).toBe("created_and_converted");
    expect(r[0].appointment_id).not.toBeNull();

    // Verified by the RETURNED id, never by email or client association.
    const appt = await apptById(r[0].appointment_id as string);
    expect(appt).toHaveLength(1);
    expect(appt[0].client_id).toBe(clientId);
    expect((await auditFor(r[0].appointment_id as string))[0].n).toBe(1);

    const e = await entryRow(entryId);
    expect(e.status).toBe("converted");
    expect(e.converted_at).not.toBeNull();
    expect(e.converted_client_id).toBe(clientId);
  });

  it("a conversion refusal rolls back THIS invocation's appointment and audit", async () => {
    const f = await fixture("rollback");
    const { entryId, email } = await redeemedEntry(f, "rollback");
    const { clientId } = await bookingClient(f, email);

    const first = await q<any>(
      BOOK, [f.studioId, clientId, f.serviceId, await legalSlot(f, 0), tokenHash("r1"), entryId],
    );
    expect(first[0].result).toBe("created_and_converted");

    const before = await apptCount(f.studioId);
    // The entry is terminal now, so the appointment work is reached and the
    // conversion then refuses. The caller commits the RETURNED result normally.
    const second = await q<any>(
      BOOK, [f.studioId, clientId, f.serviceId, await legalSlot(f, 3), tokenHash("r2"), entryId],
    );
    expect(second[0].result).toMatch(/^conversion:/);
    expect(second[0].appointment_id).toBeNull();
    // No SQLSTATE or raw database text crosses the boundary.
    expect(second[0].result).not.toMatch(/^\d{5}$/);

    expect(await apptCount(f.studioId)).toBe(before);
    // SCOPED TO THIS STUDIO ON PURPOSE. An unscoped `where a.id is null` scan
    // counts orphaned audit rows that other suites legitimately leave in the
    // shared CI database — it passed on a fresh local chain and found 6 in CI.
    // The claim is about THIS invocation, so the query must be too.
    const orphans = await q<any>(
      `select count(*)::int as n
         from public.appointment_audit au
         left join public.appointments a on a.id = au.appointment_id
        where a.id is null
          and au.studio_id = $1`,
      [f.studioId],
    );
    expect(orphans[0].n).toBe(0);
    // Positive control: the FIRST booking's audit row is still there, so the
    // count above is zero because the rollback worked, not because the join or
    // the studio filter matched nothing.
    expect((await auditFor(first[0].appointment_id as string))[0].n).toBe(1);
    expect((await entryRow(entryId)).status).toBe("converted");
  });

  it("an appointment refusal converts nothing", async () => {
    const f = await fixture("apt-refuse");
    const { entryId, email } = await redeemedEntry(f, "apt-refuse");
    const { clientId } = await bookingClient(f, email);
    const before = await apptCount(f.studioId);

    // The OFFERED service on a PERMITTED date, so scope passes and the refusal
    // is genuinely the appointment command's. (This previously passed a bogus
    // service id, which scope now — correctly — intercepts first.)
    const r = await q<any>(
      BOOK,
      [f.studioId, clientId, f.serviceId,
       await closedHourOn(f, await studioDate(f, 3)), tokenHash("ar"), entryId],
    );
    expect(r[0].result).toMatch(/^appointment:/);
    const e = await entryRow(entryId);
    expect(e.status).toBe("invited");
    expect(e.converted_at).toBeNull();
    expect(await apptCount(f.studioId)).toBe(before);
  });

  it("refuses an entry belonging to another studio, and books nothing", async () => {
    const a = await fixture("tenant-a");
    const b = await fixture("tenant-b");
    const { entryId: foreign } = await redeemedEntry(b, "tenant-b");
    // A client that is legitimately A's, so the refusal below is attributable to
    // the foreign ENTRY rather than to the recipient binding.
    const { clientId } = await bookingClient(a, `own-a-${a.studioId.slice(0, 8)}@example.com`);
    const before = await apptCount(a.studioId);

    const r = await q<any>(
      BOOK, [a.studioId, clientId, a.serviceId, await legalSlot(a, 0), tokenHash("fx"), foreign],
    );
    expect(r[0].result).toBe("entry_not_found");
    expect(await apptCount(a.studioId)).toBe(before);
    expect((await entryRow(foreign)).status).toBe("invited");
  });

  it("leaves ordinary public booking unchanged", async () => {
    const f = await fixture("ordinary");
    const r = await q<any>(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [f.studioId, f.clientId, f.serviceId, await legalSlot(f, 0), tokenHash("ord")],
    );
    expect(r[0].result).toBe("created");
    expect((await auditFor(r[0].appointment_id))[0].n).toBe(1);
  });
});

describe("0195 — the conversion is bound to the redeemed recipient", () => {
  // =========================================================================
  // WHY THIS BLOCK EXISTS. An independent review found that the command took
  // `p_client_id` on trust. `record_new_client_waitlist_conversion` checks only
  // that the client exists IN THE SAME STUDIO, and a same-studio check is not a
  // same-person check — so person A's redeemed invitation could book person B's
  // appointment and convert A's entry to B, both committing together.
  //
  // Every earlier test in this file passed `f.clientId`, the seeded studio's
  // own client, which has no email at all. They were all booking the wrong
  // person and could never have caught this.
  // =========================================================================

  it("refuses ANOTHER client in the SAME studio, and writes nothing", async () => {
    const f = await fixture("wrong-recipient");
    const { entryId } = await redeemedEntry(f, "wrong-recipient");

    // Person B: a real, active client of THIS studio, with a real address that
    // is simply not the one on the invitation.
    const other = await bookingClient(f, `someone-else-${f.studioId.slice(0, 8)}@example.com`);
    expect(other.created).toBe(true);

    const appts = await apptCount(f.studioId);
    const audits = await auditCount(f.studioId);

    const r = await q<any>(
      BOOK, [f.studioId, other.clientId, f.serviceId, await legalSlot(f, 0), tokenHash("wr"), entryId],
    );

    expect(r[0].result).toBe("recipient_mismatch");
    expect(r[0].appointment_id).toBeNull();
    // Nothing from THIS invocation survived, and the entry is untouched.
    expect(await apptCount(f.studioId)).toBe(appts);
    expect(await auditCount(f.studioId)).toBe(audits);
    const e = await entryRow(entryId);
    expect(e.status).toBe("invited");
    expect(e.converted_at).toBeNull();
    expect(e.converted_client_id).toBeNull();
  });

  it("refuses a client from ANOTHER studio", async () => {
    const a = await fixture("bind-a");
    const b = await fixture("bind-b");
    const { entryId, email } = await redeemedEntry(a, "bind-a");
    // Same address, wrong tenant: b's client normalizes identically, so only the
    // studio scoping can refuse it. That is the point of the case.
    const foreignClient = await bookingClient(b, email);
    const before = await apptCount(a.studioId);

    const r = await q<any>(
      BOOK, [a.studioId, foreignClient.clientId, a.serviceId, await legalSlot(a, 0), tokenHash("xs"), entryId],
    );

    expect(r[0].result).toBe("client_not_found");
    expect(await apptCount(a.studioId)).toBe(before);
    expect((await entryRow(entryId)).status).toBe("invited");
  });

  it("refuses a client whose email is absent — never matches NULL to NULL", async () => {
    const f = await fixture("null-email");
    const { entryId } = await redeemedEntry(f, "null-email");
    // `seedStudio`'s client is inserted with no email, so normalized_email is
    // NULL. Two NULLs must not read as agreement.
    const before = await apptCount(f.studioId);

    const r = await q<any>(
      BOOK, [f.studioId, f.clientId, f.serviceId, await legalSlot(f, 0), tokenHash("ne"), entryId],
    );

    expect(r[0].result).toBe("recipient_mismatch");
    expect(await apptCount(f.studioId)).toBe(before);
    expect((await entryRow(entryId)).status).toBe("invited");
  });

  it("accepts the NEW-client path: the resolver created the client from the entry's address", async () => {
    const f = await fixture("new-client");
    const { entryId, email } = await redeemedEntry(f, "new-client");
    const c = await bookingClient(f, email);
    expect(c.created).toBe(true); // genuinely the new-client path

    const r = await q<any>(
      BOOK, [f.studioId, c.clientId, f.serviceId, await legalSlot(f, 0), tokenHash("nc"), entryId],
    );
    expect(r[0].result).toBe("created_and_converted");
    expect((await entryRow(entryId)).converted_client_id).toBe(c.clientId);
  });

  it("accepts the EXISTING-client path: a returning client matched on normalized email", async () => {
    const f = await fixture("existing-client");
    const { entryId, email } = await redeemedEntry(f, "existing-client");

    // The client already exists before the booking, and is matched — not
    // re-created — even though the caller supplies a differently-cased address
    // with surrounding whitespace. The normalization is the repository's own.
    const first = await bookingClient(f, email);
    expect(first.created).toBe(true);
    const again = await bookingClient(f, `  ${email.toUpperCase()}  `);
    expect(again.created).toBe(false);
    expect(again.clientId).toBe(first.clientId);

    const r = await q<any>(
      BOOK, [f.studioId, again.clientId, f.serviceId, await legalSlot(f, 0), tokenHash("ec"), entryId],
    );
    expect(r[0].result).toBe("created_and_converted");
    expect((await entryRow(entryId)).converted_client_id).toBe(first.clientId);
  });
});

describe("0195 — the booking stays inside the invitation's stored offer scope", () => {
  // =========================================================================
  // 0192 §2 stores the offer on the invitation — scope_service_id,
  // scope_start_date, scope_end_date, scope_allowed_weekdays — with the stated
  // purpose that "a substituted URL parameter, service or date cannot widen
  // permission: the commit path re-reads these columns". Nothing downstream
  // re-read them, so the commit path honoured whatever the caller asked for.
  //
  // EVERY REFUSAL BELOW IS PAIRED WITH A POSITIVE CONTROL that books the SAME
  // slot (or the same service) under a scope that permits it. Without that, an
  // ordinary availability or service-eligibility refusal would masquerade as
  // scope enforcement.
  // =========================================================================

  it("refuses a DIFFERENT otherwise-bookable service, and permits the scoped one", async () => {
    const f = await fixture("scope-svc");
    const other = await extraService(f, "Other Consultation");
    const from = await studioDate(f, 2);
    const to = await studioDate(f, 20);

    // Scope names f.serviceId. The booking asks for `other`.
    const wrong = await redeemedScopedEntry(f, "svc-wrong", {
      serviceId: f.serviceId, from, to, weekdays: null,
    });
    const wc = await bookingClient(f, wrong.email);
    const slot = await slotOnDate(f, await studioDate(f, 3));
    expect(slot).not.toBeNull();

    const before = await apptCount(f.studioId);
    const r = await q<any>(
      BOOK, [f.studioId, wc.clientId, other, slot, tokenHash("sv1"), wrong.entryId],
    );
    expect(r[0].result).toBe("scope_service_not_offered");
    expect(await apptCount(f.studioId)).toBe(before);
    expect((await entryRow(wrong.entryId)).status).toBe("invited");

    // POSITIVE CONTROL: `other` is genuinely bookable — the same service and
    // slot succeed when the invitation actually offers it.
    const ok = await redeemedScopedEntry(f, "svc-ok", {
      serviceId: other, from, to, weekdays: null,
    });
    const okc = await bookingClient(f, ok.email);
    const r2 = await q<any>(
      BOOK, [f.studioId, okc.clientId, other, slot, tokenHash("sv2"), ok.entryId],
    );
    expect(r2[0].result).toBe("created_and_converted");
  });

  it("refuses a date OUTSIDE the offered range, and permits the same slot inside it", async () => {
    const f = await fixture("scope-date");
    const target = await studioDate(f, 12);
    const slot = await slotOnDate(f, target);
    expect(slot).not.toBeNull();

    // Range deliberately ends before the target date.
    const outside = await redeemedScopedEntry(f, "date-out", {
      serviceId: f.serviceId, from: await studioDate(f, 2), to: await studioDate(f, 5), weekdays: null,
    });
    const oc = await bookingClient(f, outside.email);
    const before = await apptCount(f.studioId);
    const r = await q<any>(
      BOOK, [f.studioId, oc.clientId, f.serviceId, slot, tokenHash("dt1"), outside.entryId],
    );
    expect(r[0].result).toBe("scope_date_out_of_range");
    expect(await apptCount(f.studioId)).toBe(before);
    expect((await entryRow(outside.entryId)).status).toBe("invited");

    // POSITIVE CONTROL: the very same instant books when the range covers it,
    // so the refusal above was the RANGE and not availability.
    const inside = await redeemedScopedEntry(f, "date-in", {
      serviceId: f.serviceId, from: await studioDate(f, 2), to: await studioDate(f, 20), weekdays: null,
    });
    const ic = await bookingClient(f, inside.email);
    const r2 = await q<any>(
      BOOK, [f.studioId, ic.clientId, f.serviceId, slot, tokenHash("dt2"), inside.entryId],
    );
    expect(r2[0].result).toBe("created_and_converted");
  });

  it("refuses an EXCLUDED weekday, and permits the same slot when that weekday is allowed", async () => {
    const f = await fixture("scope-dow");
    const target = await studioDate(f, 9);
    const slot = await slotOnDate(f, target);
    expect(slot).not.toBeNull();
    const dow = await dowOf(f, slot as string);
    // Every weekday EXCEPT the slot's own (0 = Sunday, per 0192's contract).
    const without = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== dow);
    const from = await studioDate(f, 2);
    const to = await studioDate(f, 20);

    const excluded = await redeemedScopedEntry(f, "dow-no", {
      serviceId: f.serviceId, from, to, weekdays: without,
    });
    const ec = await bookingClient(f, excluded.email);
    const before = await apptCount(f.studioId);
    const r = await q<any>(
      BOOK, [f.studioId, ec.clientId, f.serviceId, slot, tokenHash("dw1"), excluded.entryId],
    );
    expect(r[0].result).toBe("scope_weekday_not_allowed");
    expect(await apptCount(f.studioId)).toBe(before);
    expect((await entryRow(excluded.entryId)).status).toBe("invited");

    // POSITIVE CONTROL: the same slot, allowed.
    const allowed = await redeemedScopedEntry(f, "dow-yes", {
      serviceId: f.serviceId, from, to, weekdays: [dow],
    });
    const ac = await bookingClient(f, allowed.email);
    const r2 = await q<any>(
      BOOK, [f.studioId, ac.clientId, f.serviceId, slot, tokenHash("dw2"), allowed.entryId],
    );
    expect(r2[0].result).toBe("created_and_converted");
  });

  it("a refused scope writes NO appointment and NO audit, and does not convert", async () => {
    const f = await fixture("scope-nowrite");
    const other = await extraService(f, "Unoffered");
    const s = await redeemedScopedEntry(f, "nowrite", {
      serviceId: f.serviceId,
      from: await studioDate(f, 2), to: await studioDate(f, 20), weekdays: null,
    });
    const c = await bookingClient(f, s.email);
    const slot = await slotOnDate(f, await studioDate(f, 4));
    const appts = await apptCount(f.studioId);
    const audits = await auditCount(f.studioId);

    const r = await q<any>(
      BOOK, [f.studioId, c.clientId, other, slot, tokenHash("nw"), s.entryId],
    );
    expect(r[0].result).toBe("scope_service_not_offered");
    expect(await apptCount(f.studioId)).toBe(appts);
    expect(await auditCount(f.studioId)).toBe(audits);
    const e = await entryRow(s.entryId);
    expect(e.status).toBe("invited");
    expect(e.converted_at).toBeNull();
    expect(e.converted_client_id).toBeNull();
  });

  it("LEGACY all-null scope still books — the repair narrows nothing that was open", async () => {
    // Invitations issued by 0188..0191 predate the scope columns and carry all
    // four as NULL, which 0192's all-or-nothing CHECK explicitly permits. An
    // unscoped invitation must keep booking exactly as before.
    const f = await fixture("scope-legacy");
    const s = await redeemedScopedEntry(f, "legacy", {
      serviceId: f.serviceId,
      from: await studioDate(f, 2), to: await studioDate(f, 20), weekdays: null,
    });
    const cleared = await q<any>(
      `update public.new_client_waitlist_invitations
          set scope_service_id = null, scope_start_date = null,
              scope_end_date = null, scope_allowed_weekdays = null
        where entry_id = $1 and studio_id = $2 and redeemed_at is not null
        returning id`,
      [s.entryId, f.studioId],
    );
    expect(cleared).toHaveLength(1);   // the legacy shape is representable

    const c = await bookingClient(f, s.email);
    const slot = await slotOnDate(f, await studioDate(f, 6));
    const r = await q<any>(
      BOOK, [f.studioId, c.clientId, f.serviceId, slot, tokenHash("lg"), s.entryId],
    );
    expect(r[0].result).toBe("created_and_converted");
  });
});

describe("0195 — concurrency", () => {
  /** Each participant owns its own transaction lifecycle. */
  async function inTx<T>(
    client: Client, work: (c: Client) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; code: string; where: string }> {
    await client.query("set statement_timeout = 15000");
    await client.query("begin");
    try {
      const value = await work(client);
      await client.query("commit");
      return { ok: true, value };
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      const err = e as { code?: string; where?: string };
      return { ok: false, code: err.code ?? "?", where: (err.where ?? "").split("\n")[0] };
    }
  }
  const connect = async (): Promise<Client> => {
    const c = new Client({ connectionString: resolveLocalDbUrl() });
    await c.connect();
    return c;
  };

  it("two bookings for one redeemed entry: one converts, one refuses, ONE appointment", async () => {
    const f = await fixture("two-book");
    const { entryId, email } = await redeemedEntry(f, "two-book");
    const { clientId } = await bookingClient(f, email);
    const [s1, s2] = [await legalSlot(f, 0), await legalSlot(f, 3)];
    const A = await connect(); const B = await connect(); const obs = await connect();
    try {
      const pidB = (await B.query<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid;
      // NO harness prefix on either side: both are studio-first commands, so an
      // entry-first prefix would be a lock neither command takes first.
      const ra = inTx(A, (c) => c.query(BOOK, [f.studioId, clientId, f.serviceId, s1, tokenHash("t1"), entryId]).then((x) => x.rows[0]));
      const rb = inTx(B, (c) => c.query(BOOK, [f.studioId, clientId, f.serviceId, s2, tokenHash("t2"), entryId]).then((x) => x.rows[0]));
      await waitUntilBlocked(pidB, 3000).catch(() => null);
      const [xa, xb] = await Promise.all([ra, rb]);
      const results = [xa, xb].map((x) => (x.ok ? (x.value as { result: string }).result : `ERR:${x.code}`));
      expect(results.filter((r) => r === "created_and_converted")).toHaveLength(1);
      expect(results.filter((r) => r.startsWith("conversion:"))).toHaveLength(1);
      expect(results.filter((r) => r.startsWith("ERR:"))).toHaveLength(0);
    } finally {
      await Promise.all([A.end(), B.end(), obs.end()].map((p) => p.catch(() => undefined)));
    }
    expect(await apptCount(f.studioId)).toBe(1);
    expect((await entryRow(entryId)).status).toBe("converted");
  });

  it("booking versus a standalone conversion on the same entry does NOT deadlock", async () => {
    // THE REGRESSION. The pre-0195 lock order produced a reproducible 40P01
    // here: the booking held studios FOR UPDATE and wanted the entry, while the
    // conversion held the entry and wanted the studio KEY SHARE its event
    // trigger's FK requires.
    const f = await fixture("vs-conv");
    const { entryId, email } = await redeemedEntry(f, "vs-conv");
    const { clientId } = await bookingClient(f, email);
    const slot = await legalSlot(f, 0);
    const A = await connect(); const B = await connect();
    try {
      const pidA = (await A.query<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid;
      // B's prefix IS conversion's own first lock — command-reachable.
      await B.query("set statement_timeout = 15000");
      await B.query("begin");
      await B.query(`select 1 from public.new_client_waitlist_entries where id=$1 for update`, [entryId]);

      const ra = inTx(A, (c) => c.query(BOOK, [f.studioId, clientId, f.serviceId, slot, tokenHash("vc"), entryId]).then((x) => x.rows[0]));
      await waitUntilBlocked(pidA, 6000);
      const rbRows = await B.query<{ r: string }>(CONVERT, [f.studioId, entryId, clientId]);
      await B.query("commit");
      const xa = await ra;
      expect(rbRows.rows[0].r).toBe("converted");
      expect(xa.ok).toBe(true);
      if (xa.ok) expect((xa.value as { result: string }).result).toMatch(/^conversion:/);
    } finally {
      await Promise.all([A.end(), B.end()].map((p) => p.catch(() => undefined)));
    }
    expect(await apptCount(f.studioId)).toBe(0);
    expect((await entryRow(entryId)).status).toBe("converted");
  });

  it("Direction A: the booking holds the recipient, a concurrent email change WAITS", async () => {
    // THE NEW LOCK IN THE ORDER. Step 3 takes the bound client FOR SHARE so the
    // identity the binding was proved against cannot be re-pointed before the
    // commit. KEY SHARE would NOT do this: `UPDATE clients SET email = ...`
    // takes FOR NO KEY UPDATE, which KEY SHARE does not conflict with.
    const f = await fixture("lock-fwd");
    const { entryId, email } = await redeemedEntry(f, "lock-fwd");
    const { clientId } = await bookingClient(f, email);
    const slot = await legalSlot(f, 0);
    const A = await connect(); const B = await connect();
    try {
      await A.query("set statement_timeout = 15000");
      await A.query("begin");
      const booked = await A.query(BOOK, [f.studioId, clientId, f.serviceId, slot, tokenHash("lf"), entryId]);
      expect(booked.rows[0].result).toBe("created_and_converted");

      const pidB = (await B.query<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid;
      await B.query("set statement_timeout = 15000");
      await B.query("begin");
      const changing = B.query(
        `update public.clients set email = $2 where id = $1`,
        [clientId, `moved-${f.studioId.slice(0, 8)}@example.com`],
      );

      // It must genuinely block, not merely finish second.
      await waitUntilBlocked(pidB, 6000);

      await A.query("commit");
      await changing;             // proceeds only once A released
      await B.query("commit");
    } finally {
      await Promise.all([A.end(), B.end()].map((p) => p.catch(() => undefined)));
    }
    expect((await entryRow(entryId)).status).toBe("converted");
  });

  it("Direction B: an email change holds the recipient, the booking WAITS and does not deadlock", async () => {
    // The reverse order, because step 3 introduced a new object into the lock
    // sequence and an untested direction is an unproven one.
    const f = await fixture("lock-rev");
    const { entryId, email } = await redeemedEntry(f, "lock-rev");
    const { clientId } = await bookingClient(f, email);
    const slot = await legalSlot(f, 0);
    const A = await connect(); const B = await connect();
    try {
      await B.query("set statement_timeout = 15000");
      await B.query("begin");
      // A non-key UPDATE that does NOT change the bound address, so the booking
      // is still legitimate once it is allowed to proceed.
      await B.query(`update public.clients set name = 'Renamed' where id = $1`, [clientId]);

      const pidA = (await A.query<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid;
      const ra = inTx(A, (c) =>
        c.query(BOOK, [f.studioId, clientId, f.serviceId, slot, tokenHash("lr"), entryId]).then((x) => x.rows[0]));
      await waitUntilBlocked(pidA, 6000);

      await B.query("commit");
      const xa = await ra;
      expect(xa.ok).toBe(true);                       // no 40P01, no timeout
      if (xa.ok) expect((xa.value as { result: string }).result).toBe("created_and_converted");
    } finally {
      await Promise.all([A.end(), B.end()].map((p) => p.catch(() => undefined)));
    }
    expect((await entryRow(entryId)).status).toBe("converted");
  });
});

describe("0195 — privileges", () => {
  it("is executable by service_role only; no browser role holds EXECUTE", async () => {
    const acl = await q<any>(
      `select coalesce(array_to_string(p.proacl,' '),'(default)') as acl
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='create_waitlist_public_appointment'`,
    );
    expect(acl).toHaveLength(1);
    expect(acl[0].acl).toContain("service_role=X");
    expect(acl[0].acl).not.toMatch(/(^|\s)anon=/);
    expect(acl[0].acl).not.toMatch(/authenticated=/);
  });
});
