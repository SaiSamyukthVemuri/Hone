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

async function openRound(studioId: string, allowance: number): Promise<void> {
  await adminQuery(
    `insert into public.studio_waitlist_admission_rounds (studio_id, allowance)
     values ($1,$2)
     on conflict (studio_id) do update set allowance = excluded.allowance`,
    [studioId, allowance],
  );
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

describe("the happy path is ONE action", () => {
  it("takes a waiting person to invited and returns everything delivery needs", async () => {
    const studio = await seedStudio("admit-ok");
    await openRound(studio.studioId, 5);
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
    await openRound(studio.studioId, 5);
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
    await openRound(studio.studioId, 5);
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
    ["no round open", async (s: { studioId: string }) => { /* no round */ void s; }, "no_round_open"],
    ["round full", async (s: { studioId: string }) => openRound(s.studioId, 0), "round_full"],
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
    await openRound(studio.studioId, 5);
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
    await openRound(a.studioId, 5);
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
    await openRound(a.studioId, 5);
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
    await openRound(studio.studioId, 1);
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
    await openRound(studio.studioId, 5);
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
    await openRound(studio.studioId, 5);
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
    await openRound(studio.studioId, 5);
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
    await openRound(studio.studioId, 1);
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
    await openRound(studio.studioId, 5);
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
    await openRound(studio.studioId, 5);
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
    await openRound(studio.studioId, 5);
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
