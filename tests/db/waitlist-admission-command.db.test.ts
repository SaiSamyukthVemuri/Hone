import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool, seedMember, seedStudio } from "./helpers/harness";

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

async function seedService(studioId: string, label = "svc"): Promise<string> {
  const res = await adminQuery(
    `insert into public.services (studio_id, name, default_duration_minutes)
     values ($1,$2,30) returning id`,
    [studioId, `${label}-${n++}`],
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
