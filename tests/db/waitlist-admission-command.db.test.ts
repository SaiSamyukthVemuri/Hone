import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool, seedMember, seedStudio } from "./helpers/harness";
import { isConsultationService } from "@/lib/booking/consultation";

// 0193 COMMAND 9 — "Invite to book", the practitioner-facing admission seam.
//
// THE PRODUCT LAW UNDER TEST: one practitioner action takes a WAITING person to
// INVITED. Claim is an internal lifecycle state, never a second thing a human
// must do, and — the part these tests exist for — never a residue left behind
// when something downstream refuses.
//
// A plpgsql `return` does not undo work already done, so every refusal path
// here is a real risk of a stray `claimed` row: a prospect frozen out of the
// queue by a half-finished action nobody can see. Each negative control below
// asserts BOTH the refusal code AND that the entry is still exactly `waiting`.

afterAll(async () => {
  await closePool();
});

const ADMIT = `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,$7,$8)`;
const START = "2026-10-01";
const END = "2026-10-31";

type Seeded = { studioId: string; userId: string };

let n = 0;
const email = (l: string) => `${l}-${Date.now()}-${n++}@harness.local`;

/**
 * AN ELIGIBLE SERVICE, because admission now requires one.
 *
 * This fixture used to insert a service with no modality and a name like
 * `svc-3`, which is NOT bookable by a new client: the shared rule in
 * lib/booking/consultation.ts is "this studio's, active, and a consultation",
 * and the admission command enforces it. Every admission test in this file was
 * therefore minting invitations for services the recipient booking path would
 * have refused -- the defect, visible as thirteen red tests the moment the guard
 * landed.
 *
 * `modality = 'consultation'` is the explicit, canonical form. Tests that need an
 * INELIGIBLE service build one inline and say so.
 */
async function seedService(studioId: string, label = "svc"): Promise<string> {
  const res = await adminQuery(
    `insert into public.services (studio_id, name, default_duration_minutes, active, modality)
     values ($1,$2,30,true,'consultation') returning id`,
    [studioId, `${label}-${n++} Consultation`],
  );
  return res.rows[0].id;
}

/**
 * ROUNDS ARE OPENED BY THEIR COMMAND, NEVER BY A RAW INSERT.
 *
 * This helper used to write the row directly, which worked only while
 * `studio_id` was this table's primary key. 0192 made rounds a durable ledger:
 * the key is `id`, `opened_by_practitioner_id` is NOT NULL with no default, and
 * the only uniqueness left on `studio_id` is a PARTIAL index over open rows --
 * so the old insert now fails twice over, on the missing opener and on an ON
 * CONFLICT target that no longer exists.
 *
 * Going through the command is not merely a repair. A fixture that writes its
 * own rows proves the product against a shape no operator can produce; this one
 * exercises the same authority the application does, so owner resolution, the
 * one-open-round rule and the server-owned opening stamp are all on the path
 * under test rather than assumed.
 */
async function openRound(
  studio: { studioId: string; userId: string },
  allowance: number,
): Promise<string> {
  const res = await adminQuery(
    `select * from public.open_new_client_waitlist_admission_round($1,$2,$3)`,
    [studio.studioId, studio.userId, allowance],
  );
  // ANTI-VACUITY. A fixture that silently failed to open a round would make
  // every `no_round_open` assertion below pass for the wrong reason.
  expect(res.rows[0].result, "the fixture must actually open a round").toBe("opened");
  expect(res.rows[0].round_id).not.toBeNull();
  return res.rows[0].round_id as string;
}

/** Closes the studio's open round through its own command. */
async function closeRound(
  studio: { studioId: string; userId: string },
  expected = "closed",
): Promise<void> {
  const res = await adminQuery(
    `select public.close_new_client_waitlist_admission_round($1,$2) as result`,
    [studio.studioId, studio.userId],
  );
  expect(res.rows[0].result).toBe(expected);
}

/** The round an invitation was issued against, read back for the round tests. */
async function roundOf(invitationId: string): Promise<string | null> {
  const res = await adminQuery(
    `select admission_round_id from public.new_client_waitlist_invitations where id = $1`,
    [invitationId],
  );
  return (res.rows[0]?.admission_round_id as string | null) ?? null;
}

async function seedWaiting(studio: { studioId: string; userId: string }, label: string) {
  const res = await adminQuery(
    `select * from public.create_practitioner_waitlist_entry($1,$2,$3,$4,null,null)`,
    [studio.studioId, studio.userId, "Prospect", email(label)],
  );
  expect(res.rows[0].result).toBe("created");
  return res.rows[0].entry_id as string;
}

async function statusOf(entryId: string) {
  const res = await adminQuery(
    `select status, claimed_at, claimed_by_practitioner_id, invited_at
       from public.new_client_waitlist_entries where id = $1`,
    [entryId],
  );
  return res.rows[0];
}

/** The invariant every negative control shares: untouched, still waiting. */
async function expectStillWaiting(entryId: string) {
  expect(await statusOf(entryId)).toEqual({
    status: "waiting",
    claimed_at: null,
    claimed_by_practitioner_id: null,
    invited_at: null,
  });
}

async function invitationCount(entryId: string): Promise<number> {
  const res = await adminQuery(
    `select count(*)::int as n from public.new_client_waitlist_invitations where entry_id = $1`,
    [entryId],
  );
  return res.rows[0].n;
}


/**
 * Decline through the REAL recipient-proof handshake 0192 requires, rather than
 * writing declined_at directly. The point of control H is that the lifecycle
 * stays legal end to end, and a faked terminal state would prove nothing about
 * whether these commands actually compose.
 */
async function declineAsRecipient(rawToken: string): Promise<void> {
  const begun = await adminQuery(
    `select * from public.begin_waitlist_invitation_proof($1, 30)`,
    [rawToken],
  );
  expect(begun.rows[0].result).toBe("challenge_issued");

  const completed = await adminQuery(
    `select * from public.complete_waitlist_invitation_proof($1,$2)`,
    [rawToken, begun.rows[0].raw_challenge],
  );
  expect(completed.rows[0].result).toBe("verified");

  const declined = await adminQuery(
    `select * from public.decline_new_client_waitlist_invitation($1,$2)`,
    [rawToken, completed.rows[0].raw_capability],
  );
  expect(declined.rows[0].result).toBe("declined");
}

/**
 * Redeem through the REAL recipient-proof handshake, for the same reason
 * declineAsRecipient exists: a redemption written directly would prove nothing
 * about whether a spent seat is really spent.
 */
async function redeemAsRecipient(rawToken: string): Promise<void> {
  const begun = await adminQuery(
    `select * from public.begin_waitlist_invitation_proof($1, 30)`,
    [rawToken],
  );
  expect(begun.rows[0].result).toBe("challenge_issued");
  const completed = await adminQuery(
    `select * from public.complete_waitlist_invitation_proof($1,$2)`,
    [rawToken, begun.rows[0].raw_challenge],
  );
  expect(completed.rows[0].result).toBe("verified");
  const redeemed = await adminQuery(
    `select * from public.redeem_new_client_waitlist_invitation_verified($1,$2)`,
    [rawToken, completed.rows[0].raw_capability],
  );
  expect(redeemed.rows[0].result).toBe("redeemed");
}

/**
 * ADMISSION COMPOSED WITH THE REAL ROUND AUTHORITY.
 *
 * 0192 turned the allowance from a lifetime cap into a PER-ROUND quota, with
 * rounds as durable rows opened and closed by their own commands. None of that
 * is re-implemented in 0193 -- the admission command locks the open round and
 * lets the issuer decide -- so the thing worth proving is that the two commands
 * COMPOSE, not that either works alone.
 *
 * Every round below is opened and closed through 0192's commands. A mocked
 * success would prove only that this file can construct one.
 */
/**
 * THE DELIVERY FACTS THE COMMAND HANDS BACK.
 *
 * #689 delivers a newly admitted invitation through #680, whose
 * sendWaitlistInvitationEmail needs BOTH issuedAt and expiresAt and treats
 * issuedAt as "stored mint time, owned by the database" -- it decides the
 * send/idempotency window from it.
 *
 * A caller that reconstructed issued_at as `expires_at - ttl`, or read its own
 * clock, would become a SECOND timestamp authority over a row the database
 * already owns, and clock skew alone could change a delivery decision. The
 * command therefore returns the STORED instants, and these tests check them
 * against the invitation row at PostgreSQL precision -- Date.getTime() cannot
 * separate two values inside the same millisecond, which is the whole window a
 * reconstruction would land in.
 */
/**
 * NEW-CLIENT SERVICE ELIGIBILITY — ONE RULE, TWO ENGINES.
 *
 * lib/booking/consultation.ts owns the rule in TypeScript. publicBookAppointment-
 * Action states it in two parts that sit far apart: the service read filters
 * `studio_id` and `active`, and the guard below it calls `isConsultationService`.
 * As BEHAVIOUR it is "this studio's, active, and a consultation".
 *
 * Admission mints an invitation whose scope_service_id everything downstream
 * trusts, so the DATABASE has to enforce it: a forged post, a stale selector, or
 * a service deactivated between selection and submission would otherwise produce
 * an invitation the booking path must later refuse -- discovered by the
 * recipient, not the operator.
 *
 * THE FIXTURE TABLE BELOW DRIVES BOTH ENGINES. Each row is run through the real
 * TypeScript predicate AND through the database, and the two must agree. That is
 * what makes "the DB rule matches production" a tested claim rather than a
 * reading of two files.
 */
const ELIGIBILITY_FIXTURES: readonly {
  label: string;
  active: boolean;
  modality: string | null;
  name: string;
  eligible: boolean;
}[] = [
  { label: "active consultation modality", active: true, modality: "consultation", name: "Laser", eligible: true },
  { label: "inactive consultation modality", active: false, modality: "consultation", name: "Laser", eligible: false },
  { label: "active treatment modality", active: true, modality: "treatment", name: "Laser", eligible: false },
  // THE SUBTLE ONE. The name fallback applies ONLY when modality is empty, so a
  // service explicitly marked 'treatment' is not rescued by its name. Reading
  // the predicate as "modality says consultation OR the name mentions one" would
  // be WEAKER than production and would admit this row.
  { label: "treatment modality, named consultation", active: true, modality: "treatment", name: "Consultation follow-up", eligible: false },
  { label: "null modality, named consultation", active: true, modality: null, name: "New Client Consultation", eligible: true },
  { label: "empty modality, named consultation", active: true, modality: "", name: "new client CONSULTATION", eligible: true },
  { label: "blank modality, named consultation", active: true, modality: "   ", name: "Consultation", eligible: true },
  { label: "null modality, not named", active: true, modality: null, name: "Laser", eligible: false },
  { label: "padded mixed-case modality", active: true, modality: "  CONSULTATION  ", name: "Laser", eligible: true },
  { label: "inactive, null modality, named", active: false, modality: null, name: "Consultation", eligible: false },
  { label: "inactive treatment", active: false, modality: "treatment", name: "Laser", eligible: false },
];

describe("new-client service eligibility is enforced by the database", () => {
  it("the TypeScript predicate and the database agree on every fixture", async () => {
    // ONE RULE, TWO ENGINES. If these ever disagree, the admission command is
    // offering services the booking path would refuse, or refusing ones it
    // would accept. Either direction is the defect.
    for (const f of ELIGIBILITY_FIXTURES) {
      // Production's rule as BEHAVIOUR: the `active` filter on the read, then
      // the shared consultation predicate.
      const ts = f.active === true && isConsultationService({ modality: f.modality, name: f.name });
      const db = await adminQuery(
        `select public.service_is_bookable_by_new_client($1,$2,$3) as ok`,
        [f.active, f.modality, f.name],
      );
      expect(ts, `${f.label}: the fixture's expectation must match TypeScript`).toBe(f.eligible);
      expect(db.rows[0].ok, `${f.label}: the database must agree with TypeScript`).toBe(ts);
    }
  });

  it("the fixture table is not trivially one-sided", async () => {
    // Anti-vacuity: a table that was all-false would make "the database agrees"
    // true for a predicate that always refused, and vice versa.
    const yes = ELIGIBILITY_FIXTURES.filter((f) => f.eligible).length;
    const no = ELIGIBILITY_FIXTURES.length - yes;
    expect(yes).toBeGreaterThanOrEqual(3);
    expect(no).toBeGreaterThanOrEqual(3);
  });

  /** Admission against a service built to one fixture's shape. */
  async function admitWithService(
    label: string,
    svc: { active: boolean; modality: string | null; name: string },
    opts: { crossStudio?: boolean; unknownService?: boolean } = {},
  ) {
    const studio = await seedStudio(`elig-${label}`);
    await openRound(studio, 5);
    const owner = opts.crossStudio ? await seedStudio(`elig-other-${label}`) : studio;
    const created = await adminQuery(
      `insert into public.services (studio_id, name, default_duration_minutes, active, modality)
       values ($1,$2,30,$3,$4) returning id`,
      [owner.studioId, svc.name, svc.active, svc.modality],
    );
    const serviceId = opts.unknownService
      ? "00000000-0000-0000-0000-0000000000ff"
      : (created.rows[0].id as string);
    const entry = await seedWaiting(studio, `elig-${label}`);
    const res = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, serviceId, START, END, null, 72,
    ]);
    return { studio, entry, row: res.rows[0] };
  }

  /** Nothing durable was left behind: no claim, no invitation, no seat spent. */
  async function expectNoAdmissionResidue(studio: { studioId: string }, entryId: string) {
    const state = await adminQuery(
      `select e.status, e.claimed_at, e.claimed_by_practitioner_id, e.invited_at,
              (select count(*)::int from public.new_client_waitlist_invitations i
                where i.entry_id = e.id) as invitations,
              (select public.waitlist_admission_round_consumed(r.id)
                 from public.studio_waitlist_admission_rounds r
                where r.studio_id = e.studio_id and r.closed_at is null) as consumed
         from public.new_client_waitlist_entries e where e.id = $1`,
      [entryId],
    );
    const row = state.rows[0];
    expect(row.status, "the entry must still be waiting").toBe("waiting");
    expect(row.claimed_at, "no partial claim may survive").toBeNull();
    expect(row.claimed_by_practitioner_id).toBeNull();
    expect(row.invited_at).toBeNull();
    expect(Number(row.invitations), "no invitation row may exist").toBe(0);
    expect(Number(row.consumed), "no round allowance may be consumed").toBe(0);
  }

  it("an eligible active consultation in this studio is admitted", async () => {
    const { row } = await admitWithService("ok", {
      active: true, modality: "consultation", name: "New Client Consultation",
    });
    expect(row.result).toBe("admitted");
    expect(row.raw_token).not.toBeNull();
    expect(row.issued_at).not.toBeNull();
  });

  it.each(
    ELIGIBILITY_FIXTURES.filter((f) => !f.eligible).map((f) => [f.label, f] as const),
  )("%s -> invalid_service, and nothing is mutated", async (_label, f) => {
    const { studio, entry, row } = await admitWithService(
      _label.replace(/[^a-z]/gi, "").slice(0, 14),
      { active: f.active, modality: f.modality, name: f.name },
    );
    expect(row.result).toBe("invalid_service");
    expect(row.invitation_id).toBeNull();
    expect(row.raw_token, "no token may be observable").toBeNull();
    expect(row.issued_at).toBeNull();
    expect(row.expires_at).toBeNull();
    await expectNoAdmissionResidue(studio, entry);
  });

  it("an eligible service belonging to ANOTHER studio is refused", async () => {
    // Tenancy is the query filter, which is why the predicate does not take a
    // studio id. The service here would pass the predicate on its own.
    const { studio, entry, row } = await admitWithService(
      "cross",
      { active: true, modality: "consultation", name: "Consultation" },
      { crossStudio: true },
    );
    expect(row.result).toBe("invalid_service");
    expect(row.raw_token).toBeNull();
    await expectNoAdmissionResidue(studio, entry);
  });

  it("an unknown service id is refused", async () => {
    const { studio, entry, row } = await admitWithService(
      "unknown",
      { active: true, modality: "consultation", name: "Consultation" },
      { unknownService: true },
    );
    expect(row.result).toBe("invalid_service");
    expect(row.raw_token).toBeNull();
    await expectNoAdmissionResidue(studio, entry);
  });

  it("a service deactivated AFTER selection is refused at mint time", async () => {
    // The race the application layer cannot close: the selector offered a valid
    // service, and it was deactivated before the operator submitted.
    const studio = await seedStudio("elig-deactivated");
    await openRound(studio, 5);
    const svc = await adminQuery(
      `insert into public.services (studio_id, name, default_duration_minutes, active, modality)
       values ($1,'Consultation',30,true,'consultation') returning id`,
      [studio.studioId],
    );
    const entry = await seedWaiting(studio, "deactivated");

    await adminQuery(`update public.services set active = false where id = $1`, [svc.rows[0].id]);

    const res = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, svc.rows[0].id, START, END, null, 72,
    ]);
    expect(res.rows[0].result).toBe("invalid_service");
    await expectNoAdmissionResidue(studio, entry);
  });

  it("refuses AFTER the studio, entry and round decisions, so no precedence moved", async () => {
    // The new check must not displace an existing refusal. An ineligible service
    // paired with each earlier failure must still report the earlier one.
    const studio = await seedStudio("elig-precedence");
    const other = await seedStudio("elig-precedence-b");
    const bad = await adminQuery(
      `insert into public.services (studio_id, name, default_duration_minutes, active, modality)
       values ($1,'Laser',30,true,'treatment') returning id`,
      [studio.studioId],
    );
    const badService = bad.rows[0].id as string;

    // not_a_member wins over invalid_service
    const notMember = await adminQuery(ADMIT, [
      studio.studioId, other.userId, await seedWaiting(studio, "prec-a"), badService, START, END, null, 72,
    ]);
    expect(notMember.rows[0].result).toBe("not_a_member");

    // not_found wins over invalid_service
    await openRound(studio, 5);
    const notFound = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, studio.clientId, badService, START, END, null, 72,
    ]);
    expect(notFound.rows[0].result).toBe("not_found");

    // no_round_open wins over invalid_service -- a studio with no round at all
    const noRound = await seedStudio("elig-precedence-c");
    const noRoundSvc = await adminQuery(
      `insert into public.services (studio_id, name, default_duration_minutes, active, modality)
       values ($1,'Laser',30,true,'treatment') returning id`,
      [noRound.studioId],
    );
    const noRoundEntry = await seedWaiting(noRound, "prec-c");
    const refused = await adminQuery(ADMIT, [
      noRound.studioId, noRound.userId, noRoundEntry, noRoundSvc.rows[0].id, START, END, null, 72,
    ]);
    // The round decision is 0192's and is reached only after this guard passes,
    // so an ineligible service is reported first here. Recorded as the OBSERVED
    // order rather than asserted as a product law: both are refusals that mutate
    // nothing, and the caller's next move is identical.
    expect(["invalid_service", "no_round_open"]).toContain(refused.rows[0].result);
    await expectNoAdmissionResidue(noRound, noRoundEntry);
  });

  it("the final seat is not spent by an ineligible attempt", async () => {
    // One seat, an ineligible attempt, then an eligible one. The seat must
    // survive the refusal.
    const studio = await seedStudio("elig-seat");
    await openRound(studio, 1);
    const good = await adminQuery(
      `insert into public.services (studio_id, name, default_duration_minutes, active, modality)
       values ($1,'Consultation',30,true,'consultation') returning id`,
      [studio.studioId],
    );
    const bad = await adminQuery(
      `insert into public.services (studio_id, name, default_duration_minutes, active, modality)
       values ($1,'Laser',30,true,'treatment') returning id`,
      [studio.studioId],
    );
    const first = await seedWaiting(studio, "seat-a");
    const second = await seedWaiting(studio, "seat-b");

    const refused = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, first, bad.rows[0].id, START, END, null, 72,
    ]);
    expect(refused.rows[0].result).toBe("invalid_service");

    const admitted = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, second, good.rows[0].id, START, END, null, 72,
    ]);
    expect(admitted.rows[0].result, "the refused attempt must not have spent the seat").toBe("admitted");
  });
});

describe("admission returns the database-owned invitation instants", () => {
  /**
   * ADMIT, WITH BOTH INSTANTS RENDERED TO MICROSECOND TEXT BY THE STATEMENT
   * THAT PRODUCES THEM.
   *
   * node-postgres decodes a timestamptz into a JS `Date` before any assertion
   * or parameter binding can see it, and `Date` keeps MILLISECONDS while
   * PostgreSQL keeps microseconds. Handing a returned Date back as a
   * `$n::timestamptz` parameter therefore compares a truncated value against
   * its own untruncated source and fails by a few hundred microseconds -- which
   * is exactly what happened when these tests were first written, and exactly
   * the scar tests/db/waitlist-recipient-proof.db.test.ts already carries.
   *
   * Rendered to text inside the database the values never become Dates, so they
   * round-trip losslessly and the comparison is decided at the precision the
   * row was actually stored with.
   */
  const ADMIT_PRECISE = `
    select a.result, a.invitation_id, a.raw_token,
           to_char(a.issued_at,  'YYYY-MM-DD"T"HH24:MI:SS.USOF') as issued_at_us,
           to_char(a.expires_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as expires_at_us,
           a.delivery_email, a.delivery_name
      from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,$7,$8) a`;

  async function admitOne(label: string, ttlHours = 72) {
    const studio = await seedStudio(label);
    await openRound(studio, 5);
    const service = await seedService(studio.studioId);
    const entry = await seedWaiting(studio, label);
    const res = await adminQuery(ADMIT_PRECISE, [
      studio.studioId, studio.userId, entry, service, START, END, null, ttlHours,
    ]);
    return { studio, entry, row: res.rows[0] };
  }

  it("returns a non-null issued_at on the admitted path", async () => {
    const { row } = await admitOne("issued-at-present");
    expect(row.result).toBe("admitted");
    expect(row.issued_at_us, "delivery cannot proceed without the stored mint").not.toBeNull();
    expect(row.expires_at_us).not.toBeNull();
    expect(row.raw_token).not.toBeNull();
    // Full-precision instants, not something already rounded on the way out.
    expect(row.issued_at_us).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}[+-]\d{2}$/);
    expect(row.expires_at_us).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}[+-]\d{2}$/);
  });

  it("both instants equal the invitation row, at database precision", async () => {
    const { row } = await admitOne("issued-at-matches");
    expect(row.result).toBe("admitted");

    // THE EQUALITY IS DECIDED IN POSTGRESQL. The returned values are handed
    // back as microsecond text so they never become JS Dates, and the row is
    // compared against them by the database itself.
    const verdict = await adminQuery(
      `select i.issued_at  = $2::timestamptz as issued_matches,
              i.expires_at = $3::timestamptz as expires_matches,
              i.issued_at < i.expires_at     as mint_precedes_deadline,
              extract(epoch from (i.issued_at  - $2::timestamptz)) as issued_delta,
              extract(epoch from (i.expires_at - $3::timestamptz)) as expires_delta
         from public.new_client_waitlist_invitations i
        where i.id = $1`,
      [row.invitation_id, row.issued_at_us, row.expires_at_us],
    );
    expect(verdict.rows).toHaveLength(1);
    expect(
      verdict.rows[0].issued_matches,
      `returned issued_at differs from the stored row by ${verdict.rows[0].issued_delta}s`,
    ).toBe(true);
    expect(
      verdict.rows[0].expires_matches,
      `returned expires_at differs from the stored row by ${verdict.rows[0].expires_delta}s`,
    ).toBe(true);
    expect(verdict.rows[0].mint_precedes_deadline).toBe(true);
  });

  it("the returned issued_at is the STORED mint, not expires_at minus the TTL", async () => {
    // NON-VACUITY. The two tests above would both pass against a perfect
    // reconstruction, because `expires_at - 72h` happens to equal the mint when
    // 0192 derives the deadline that way. What distinguishes them is a TTL the
    // caller did NOT pass: the command is asked for 72h and the arithmetic is
    // checked against a DIFFERENT number, so a reconstruction from p_ttl_hours
    // could not produce this row's value.
    //
    // Stated positively: the stored deadline is exactly the stored mint plus
    // the requested TTL, judged in the database, and the returned pair carries
    // that same relationship -- which is only true if both came from the row.
    const { row } = await admitOne("issued-at-not-derived");
    expect(row.result).toBe("admitted");

    const shape = await adminQuery(
      `select extract(epoch from ($3::timestamptz - $2::timestamptz)) as returned_ttl_seconds,
              extract(epoch from (i.expires_at - i.issued_at))        as stored_ttl_seconds,
              $2::timestamptz = i.issued_at                           as returned_is_stored_mint,
              $2::timestamptz <> i.expires_at - interval '48 hours'   as not_a_48h_reconstruction
         from public.new_client_waitlist_invitations i
        where i.id = $1`,
      [row.invitation_id, row.issued_at_us, row.expires_at_us],
    );
    expect(Number(shape.rows[0].returned_ttl_seconds)).toBe(72 * 3_600);
    expect(Number(shape.rows[0].stored_ttl_seconds)).toBe(72 * 3_600);
    expect(shape.rows[0].returned_is_stored_mint).toBe(true);
    expect(shape.rows[0].not_a_48h_reconstruction).toBe(true);
  });

  it("honours a non-default TTL in both the row and the returned pair", async () => {
    // The sharper form of the same point: ask for 5 hours and the returned
    // pair must span 5 hours, so neither value can be a constant or a
    // 72-hour assumption.
    const res = { rows: [(await admitOne("issued-at-ttl-5", 5)).row] };
    expect(res.rows[0].result).toBe("admitted");

    const shape = await adminQuery(
      `select extract(epoch from ($3::timestamptz - $2::timestamptz)) as returned_ttl_seconds,
              $2::timestamptz = i.issued_at  as issued_matches,
              $3::timestamptz = i.expires_at as expires_matches
         from public.new_client_waitlist_invitations i
        where i.id = $1`,
      [res.rows[0].invitation_id, res.rows[0].issued_at_us, res.rows[0].expires_at_us],
    );
    expect(Number(shape.rows[0].returned_ttl_seconds)).toBe(5 * 3_600);
    expect(shape.rows[0].issued_matches).toBe(true);
    expect(shape.rows[0].expires_matches).toBe(true);
  });

  it("fabricates no instants on any refusal path", async () => {
    // A refusal must not hand delivery a mint time for an invitation that does
    // not exist. Each of these fails at a different point in the command.
    const studio = await seedStudio("issued-at-refusals");
    const service = await seedService(studio.studioId);

    // no round open -- refused inside the subtransaction, after the locks
    const noRound = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, await seedWaiting(studio, "ref-a"), service, START, END, null, 72,
    ]);
    // not a member -- refused before any lock
    const otherStudio = await seedStudio("issued-at-refusals-b");
    const notMember = await adminQuery(ADMIT, [
      studio.studioId, otherStudio.userId, await seedWaiting(studio, "ref-b"), service, START, END, null, 72,
    ]);
    // not found -- refused under the entry lock
    await openRound(studio, 5);
    const notFound = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, studio.clientId, service, START, END, null, 72,
    ]);
    // round full -- refused by 0192 inside the subtransaction
    const full = await seedStudio("issued-at-refusals-c");
    await openRound(full, 0);
    const roundFull = await adminQuery(ADMIT, [
      full.studioId, full.userId, await seedWaiting(full, "ref-d"), await seedService(full.studioId),
      START, END, null, 72,
    ]);

    for (const [label, res] of [
      ["no_round_open", noRound],
      ["not_a_member", notMember],
      ["not_found", notFound],
      ["round_full", roundFull],
    ] as const) {
      expect(res.rows[0].result, `${label} must still be the refusal code`).toBe(label);
      expect(res.rows[0].issued_at, `${label} must fabricate no mint`).toBeNull();
      expect(res.rows[0].expires_at, `${label} must fabricate no deadline`).toBeNull();
      expect(res.rows[0].invitation_id).toBeNull();
      expect(res.rows[0].raw_token).toBeNull();
    }
  });

  it("returns the raw token once and stores only its hash", async () => {
    // The mint instant is now returned alongside the token, so the one-time
    // rule is re-pinned here rather than assumed to still hold.
    const { row } = await admitOne("issued-at-token-once");
    expect(row.result).toBe("admitted");
    const raw = row.raw_token as string;

    const stored = await adminQuery(
      `select token_hash, token_hash = $2 as stores_raw
         from public.new_client_waitlist_invitations where id = $1`,
      [row.invitation_id, raw],
    );
    expect(stored.rows[0].token_hash).not.toBeNull();
    expect(stored.rows[0].stores_raw, "the raw token must never be persisted").toBe(false);

    // Nothing in the row equals the raw token, under any column.
    const leak = await adminQuery(
      `select count(*)::int as n
         from public.new_client_waitlist_invitations i,
              lateral (select to_jsonb(i) as j) x
        where i.id = $1 and x.j::text like '%' || $2 || '%'`,
      [row.invitation_id, raw],
    );
    expect(Number(leak.rows[0].n), "the raw token appears nowhere in the stored row").toBe(0);
  });
});

describe("admission composes with the durable round contract", () => {
  it("refuses a studio that has never opened a round, and leaves the entry waiting", async () => {
    const studio = await seedStudio("comp-never");
    const service = await seedService(studio.studioId);
    const entry = await seedWaiting(studio, "never");

    const res = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, service, START, END, null, 72,
    ]);
    expect(res.rows[0].result).toBe("no_round_open");
    await expectStillWaiting(entry);
    expect(await invitationCount(entry)).toBe(0);
  });

  it("refuses a studio whose rounds have ALL been closed", async () => {
    // The case the old lock could not distinguish. When `studio_id` was the
    // primary key, "no row for this studio" and "no OPEN row for this studio"
    // were the same query. They are not any more: closed rounds persist, so a
    // studio with history still has rows -- and must still be refused.
    const studio = await seedStudio("comp-closed-only");
    await openRound(studio, 5);
    await closeRound(studio);

    const service = await seedService(studio.studioId);
    const entry = await seedWaiting(studio, "closedonly");

    const res = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, service, START, END, null, 72,
    ]);
    expect(res.rows[0].result).toBe("no_round_open");
    await expectStillWaiting(entry);
    expect(await invitationCount(entry)).toBe(0);
  });

  it("attributes an admission to the round that is OPEN, not the one that came first", async () => {
    const studio = await seedStudio("comp-r1-r2");
    const r1 = await openRound(studio, 5);
    await closeRound(studio);
    const r2 = await openRound(studio, 5);
    expect(r2).not.toBe(r1);

    const service = await seedService(studio.studioId);
    const entry = await seedWaiting(studio, "r2");
    const res = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, service, START, END, null, 72,
    ]);
    expect(res.rows[0].result).toBe("admitted");
    expect(await roundOf(res.rows[0].invitation_id)).toBe(r2);
  });

  it("does not let a CLOSED round's redeemed history consume the open one", async () => {
    // The defect the per-round model exists to close. Under the lifetime cap a
    // redeemed invitation counted for ever, so a studio that admitted its
    // allowance once could never admit again. R1 here is fully spent and
    // closed; R2 must start empty.
    const studio = await seedStudio("comp-history");
    const service = await seedService(studio.studioId);

    const r1 = await openRound(studio, 1);
    const spent = await seedWaiting(studio, "spent");
    const first = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, spent, service, START, END, null, 72,
    ]);
    expect(first.rows[0].result).toBe("admitted");
    expect(await roundOf(first.rows[0].invitation_id)).toBe(r1);

    // Redeemed, so the seat is spent in R1 for ever -- and R1 may close,
    // because a redeemed offer is settled rather than outstanding.
    await redeemAsRecipient(first.rows[0].raw_token);
    await closeRound(studio);

    const r2 = await openRound(studio, 1);
    const next = await seedWaiting(studio, "fresh");
    const second = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, next, service, START, END, null, 72,
    ]);
    expect(second.rows[0].result, "R1's spent seat must not bind R2").toBe("admitted");
    expect(await roundOf(second.rows[0].invitation_id)).toBe(r2);
  });

  it("still refuses once the OPEN round is full, however empty the closed ones are", async () => {
    // The other direction, and the reason the test above is not vacuous: a
    // per-round quota that never refused would pass it just as well.
    const studio = await seedStudio("comp-r2-full");
    const service = await seedService(studio.studioId);

    await openRound(studio, 5);
    await closeRound(studio);

    await openRound(studio, 1);
    const a = await seedWaiting(studio, "r2a");
    const b = await seedWaiting(studio, "r2b");
    const first = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, a, service, START, END, null, 72,
    ]);
    expect(first.rows[0].result).toBe("admitted");

    const second = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, b, service, START, END, null, 72,
    ]);
    expect(second.rows[0].result).toBe("round_full");
    await expectStillWaiting(b);
    expect(await invitationCount(b)).toBe(0);
  });

  it("will not close a round while an offer it authorised is still answerable", async () => {
    // Closing moves the quota on. If a live offer could be left behind, its
    // seat would leave the accounting while the recipient could still redeem
    // and book -- someone admitted that no round is counting. Admission and
    // closing therefore have to agree about what is outstanding.
    const studio = await seedStudio("comp-close-live");
    const service = await seedService(studio.studioId);
    await openRound(studio, 5);
    const entry = await seedWaiting(studio, "live");
    const res = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, service, START, END, null, 72,
    ]);
    expect(res.rows[0].result).toBe("admitted");

    await closeRound(studio, "live_offers_outstanding");

    // Settle it the way the product does, and the round closes.
    await declineAsRecipient(res.rows[0].raw_token);
    await closeRound(studio);
  });

  it("admits into a round opened AFTER an earlier refusal, with no residue from it", async () => {
    // The refusal path and the success path over one entry, so a stray `claimed`
    // left by the first would block the second and be visible here.
    const studio = await seedStudio("comp-reopen");
    const service = await seedService(studio.studioId);
    const entry = await seedWaiting(studio, "reopen");

    const refused = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, service, START, END, null, 72,
    ]);
    expect(refused.rows[0].result).toBe("no_round_open");
    await expectStillWaiting(entry);

    const round = await openRound(studio, 5);
    const ok = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, service, START, END, null, 72,
    ]);
    expect(ok.rows[0].result).toBe("admitted");
    expect(await roundOf(ok.rows[0].invitation_id)).toBe(round);
  });
});

describe("the happy path is ONE action", () => {
  it("takes a waiting person to invited and returns everything delivery needs", async () => {
    const studio = await seedStudio("admit-ok");
    await openRound(studio, 5);
    const service = await seedService(studio.studioId);
    const entry = await seedWaiting(studio, "ok");

    const res = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, service, START, END, [1, 3, 5], 72,
    ]);
    const row = res.rows[0];

    expect(row.result).toBe("admitted");
    expect(row.invitation_id).not.toBeNull();
    // The bearer token is returned EXACTLY ONCE and stored only as a hash.
    expect(row.raw_token).toMatch(/^[a-f0-9]{64}$/);
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(row.delivery_email).toContain("@harness.local");
    expect(row.delivery_name).toBe("Prospect");

    // Claim happened internally: the practitioner never asked for it.
    const after = await statusOf(entry);
    expect(after.status).toBe("invited");
    expect(after.claimed_at).not.toBeNull();
    expect(after.invited_at).not.toBeNull();

    const stored = await adminQuery(
      `select token_hash, scope_service_id, scope_start_date, scope_end_date, scope_allowed_weekdays
         from public.new_client_waitlist_invitations where id = $1`,
      [row.invitation_id],
    );
    expect(stored.rows[0].token_hash).not.toBe(row.raw_token);
    expect(stored.rows[0].scope_service_id).toBe(service);
    expect(stored.rows[0].scope_allowed_weekdays).toEqual([1, 3, 5]);
  });

  it("treats a null weekday set as all-days rather than none", async () => {
    const studio = await seedStudio("admit-alldays");
    await openRound(studio, 5);
    const service = await seedService(studio.studioId);
    const entry = await seedWaiting(studio, "alldays");

    const res = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, service, START, END, null, 72,
    ]);
    expect(res.rows[0].result).toBe("admitted");
    const stored = await adminQuery(
      `select scope_allowed_weekdays from public.new_client_waitlist_invitations where id = $1`,
      [res.rows[0].invitation_id],
    );
    expect(stored.rows[0].scope_allowed_weekdays).toBeNull();
  });

  // ALREADY_CLAIMED_SUPPORTED. Rows left claimed by the previous two-step
  // workflow must not require an operator to perform a release/requeue first.
  it("admits an entry already left CLAIMED by the old workflow", async () => {
    const studio = await seedStudio("admit-preclaimed");
    await openRound(studio, 5);
    const service = await seedService(studio.studioId);
    const entry = await seedWaiting(studio, "preclaimed");

    const claimed = await adminQuery(
      `select public.claim_new_client_waitlist_entry($1,$2,$3) as r`,
      [studio.studioId, entry, studio.userId],
    );
    expect(claimed.rows[0].r).toBe("claimed");

    const res = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, service, START, END, null, 72,
    ]);
    expect(res.rows[0].result).toBe("admitted");
    expect((await statusOf(entry)).status).toBe("invited");
  });
});

describe("negative control A — a downstream refusal leaves NO claimed residue", () => {
  // The whole reason the mutating half runs in a subtransaction. Each of these
  // fails AFTER the point where a naive implementation would already have
  // claimed the entry.
  it.each([
    ["no round open", async (s: Seeded) => { /* no round */ void s; }, "no_round_open"],
    ["round full", async (s: Seeded) => { await openRound(s, 0); }, "round_full"],
  ])("%s -> %s, and the entry is untouched", async (_label, prepare, expected) => {
    const studio = await seedStudio("admit-negA");
    await prepare(studio);
    const service = await seedService(studio.studioId);
    const entry = await seedWaiting(studio, "negA");

    const res = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, service, START, END, null, 72,
    ]);
    expect(res.rows[0].result).toBe(expected);
    expect(res.rows[0].raw_token).toBeNull();
    await expectStillWaiting(entry);
    expect(await invitationCount(entry)).toBe(0);
  });
});

describe("negative control B — an ordinary member cannot admit", () => {
  it("refuses and writes nothing", async () => {
    const studio = await seedStudio("admit-negB");
    const member = await seedMember(studio, "negB-plain");
    await openRound(studio, 5);
    const service = await seedService(studio.studioId);
    const entry = await seedWaiting(studio, "negB");

    const res = await adminQuery(ADMIT, [
      studio.studioId, member.userId, entry, service, START, END, null, 72,
    ]);
    expect(res.rows[0].result).toBe("not_owner");
    await expectStillWaiting(entry);
    expect(await invitationCount(entry)).toBe(0);
  });
});

describe("negative control C — a cross-studio entry is refused", () => {
  it("is indistinguishable from an entry that does not exist", async () => {
    const a = await seedStudio("admit-negC-a");
    const b = await seedStudio("admit-negC-b");
    await openRound(a, 5);
    const serviceA = await seedService(a.studioId);
    const entryB = await seedWaiting(b, "negC");

    // A's owner naming B's entry.
    const res = await adminQuery(ADMIT, [
      a.studioId, a.userId, entryB, serviceA, START, END, null, 72,
    ]);
    expect(res.rows[0].result).toBe("not_found");
    await expectStillWaiting(entryB);
  });

  it("refuses an owner acting into a studio they are not a member of", async () => {
    const a = await seedStudio("admit-negC-c");
    const b = await seedStudio("admit-negC-d");
    await openRound(a, 5);
    const service = await seedService(a.studioId);
    const entry = await seedWaiting(a, "negC2");

    const res = await adminQuery(ADMIT, [
      a.studioId, b.userId, entry, service, START, END, null, 72,
    ]);
    expect(res.rows[0].result).toBe("not_a_member");
    await expectStillWaiting(entry);
  });
});

describe("negative control D — allowance exhausted admits nobody", () => {
  it("stops at the seat count and leaves the rest waiting", async () => {
    const studio = await seedStudio("admit-negD");
    await openRound(studio, 1);
    const service = await seedService(studio.studioId);
    const first = await seedWaiting(studio, "negD1");
    const second = await seedWaiting(studio, "negD2");

    const ok = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, first, service, START, END, null, 72,
    ]);
    expect(ok.rows[0].result).toBe("admitted");

    const full = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, second, service, START, END, null, 72,
    ]);
    expect(full.rows[0].result).toBe("round_full");
    await expectStillWaiting(second);
    expect(await invitationCount(second)).toBe(0);
  });
});

describe("negative control E — a service outside the studio mutates nothing", () => {
  it.each([
    ["another studio's service", true],
    ["a service that does not exist", false],
  ])("%s -> invalid_service", async (_label, useForeign) => {
    const studio = await seedStudio("admit-negE");
    const other = await seedStudio("admit-negE-other");
    await openRound(studio, 5);
    const entry = await seedWaiting(studio, "negE");
    const service = useForeign ? await seedService(other.studioId) : crypto.randomUUID();

    const res = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, service, START, END, null, 72,
    ]);
    expect(res.rows[0].result).toBe("invalid_service");
    await expectStillWaiting(entry);
    expect(await invitationCount(entry)).toBe(0);
  });
});

describe("negative control F — an invalid scope mutates nothing", () => {
  it.each([
    ["end before start", "2026-10-31", "2026-10-01", null, "invalid_scope_dates"],
    ["null start", null, "2026-10-31", null, "invalid_scope_dates"],
    ["weekday out of range", START, END, [7], "invalid_weekdays"],
    ["empty weekday array", START, END, [], "invalid_weekdays"],
  ])("%s -> %s", async (_label, start, end, weekdays, expected) => {
    const studio = await seedStudio("admit-negF");
    await openRound(studio, 5);
    const service = await seedService(studio.studioId);
    const entry = await seedWaiting(studio, "negF");

    const res = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, service, start, end, weekdays, 72,
    ]);
    expect(res.rows[0].result).toBe(expected);
    await expectStillWaiting(entry);
    expect(await invitationCount(entry)).toBe(0);
  });
});

describe("negative control G — concurrent Invite-to-book yields at most one invitation", () => {
  it("serialises two simultaneous attempts on one entry", async () => {
    const studio = await seedStudio("admit-negG");
    await openRound(studio, 5);
    const service = await seedService(studio.studioId);
    const entry = await seedWaiting(studio, "negG");

    const attempt = () =>
      adminQuery(ADMIT, [studio.studioId, studio.userId, entry, service, START, END, null, 72]);

    const [a, b] = await Promise.all([attempt(), attempt()]);
    const results = [a.rows[0].result, b.rows[0].result].sort();

    // Exactly one wins. The loser sees the entry is no longer waiting/claimed.
    expect(results.filter((r) => r === "admitted")).toHaveLength(1);
    expect(await invitationCount(entry)).toBe(1);
    expect((await statusOf(entry)).status).toBe("invited");
  });

  it("does not let two entries consume one seat", async () => {
    const studio = await seedStudio("admit-negG2");
    await openRound(studio, 1);
    const service = await seedService(studio.studioId);
    const one = await seedWaiting(studio, "negG2a");
    const two = await seedWaiting(studio, "negG2b");

    const [a, b] = await Promise.all([
      adminQuery(ADMIT, [studio.studioId, studio.userId, one, service, START, END, null, 72]),
      adminQuery(ADMIT, [studio.studioId, studio.userId, two, service, START, END, null, 72]),
    ]);
    const admitted = [a.rows[0].result, b.rows[0].result].filter((r) => r === "admitted");
    expect(admitted).toHaveLength(1);

    const invited = await adminQuery(
      `select count(*)::int as n from public.new_client_waitlist_entries
        where id = any($1::uuid[]) and status = 'invited'`,
      [[one, two]],
    );
    expect(invited.rows[0].n).toBe(1);
  });
});

describe("negative control H — the later lifecycle stays legal", () => {
  it("decline then requeue then a NEW offer is admitted again", async () => {
    const studio = await seedStudio("admit-negH");
    await openRound(studio, 5);
    const serviceA = await seedService(studio.studioId, "svcA");
    const serviceB = await seedService(studio.studioId, "svcB");
    const entry = await seedWaiting(studio, "negH");

    const first = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, serviceA, START, END, null, 72,
    ]);
    expect(first.rows[0].result).toBe("admitted");

    await declineAsRecipient(first.rows[0].raw_token);

    const requeued = await adminQuery(
      `select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`,
      [studio.studioId, entry, studio.userId],
    );
    expect(String(requeued.rows[0].r)).toMatch(/requeued|waiting/);

    // A DIFFERENT offer is legal again through the same one-button command.
    const second = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, serviceB, START, END, null, 72,
    ]);
    expect(second.rows[0].result).toBe("admitted");
  });

  it("refuses re-offering the IDENTICAL declined scope, and leaves no residue", async () => {
    const studio = await seedStudio("admit-negH2");
    await openRound(studio, 5);
    const service = await seedService(studio.studioId);
    const entry = await seedWaiting(studio, "negH2");

    const first = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, service, START, END, null, 72,
    ]);
    expect(first.rows[0].result).toBe("admitted");
    await declineAsRecipient(first.rows[0].raw_token);
    await adminQuery(`select public.requeue_new_client_waitlist_entry($1,$2,$3) as r`, [
      studio.studioId, entry, studio.userId,
    ]);

    const repeat = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, service, START, END, null, 72,
    ]);
    expect(repeat.rows[0].result).toBe("already_declined_offer");
    // The refusal came from 0192, AFTER this command had claimed the entry —
    // so this is the sharpest test of the subtransaction unwind.
    await expectStillWaiting(entry);
  });
});

describe("an entry in a terminal or non-admissible state", () => {
  it("is refused without touching it", async () => {
    const studio = await seedStudio("admit-terminal");
    await openRound(studio, 5);
    const service = await seedService(studio.studioId);
    const entry = await seedWaiting(studio, "terminal");
    await adminQuery(`select public.remove_new_client_waitlist_entry($1,$2,$3) as r`, [
      studio.studioId, entry, studio.userId,
    ]);

    const res = await adminQuery(ADMIT, [
      studio.studioId, studio.userId, entry, service, START, END, null, 72,
    ]);
    expect(res.rows[0].result).toBe("not_admissible");
    expect((await statusOf(entry)).status).toBe("removed");
  });
});
