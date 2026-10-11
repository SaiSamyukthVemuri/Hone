import { afterAll, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { Client } from "pg";
import { adminQuery, adminTx, closePool, resolveLocalDbUrl, seedStudio } from "./helpers/harness";

// 0210 — SMS-04, against a real database.
//
// THE SIGNUP (join_new_client_waitlist_with_phone_and_sms_answer):
//   - a phone number the sender could text is REQUIRED, for a Yes and a No;
//   - a Yes is recorded as the version-2 wording, only on an entry the call
//     created; a resubmission changes nothing, an email-only entry included;
//   - 0208's command is untouched and still records v1 (the rollout window).
//
// THE JOIN TEXT (claim_waitlist_join_ack_sms):
//   - claimed ONCE, only for a fresh public-form entry with its own v2 Yes,
//     only while the studio's waitlist texts are on;
//   - never for people already waiting: not after a backfilled or
//     owner-recorded consent, not after the switch is turned on, not for a
//     v1 Yes, not for a No, not for an old entry;
//   - at most one per number per 24 hours, across studios -- ATOMICALLY: claims
//     for one number are serialised, proven below with real connections;
//   - the ledger's new subject is tenant-bound, single, and write-once.
//
// Nothing here calls a provider: the claim writes a ledger row and the sender
// (tests/lib/waitlist/join-ack-sms.test.ts) does the rest.

afterAll(closePool);

const V1 = "waitlist_sms_operational_v1";
const V2 = "waitlist_sms_operational_v2";

async function waitlistStudio(label: string, texts: boolean) {
  const s = await seedStudio(label);
  await adminTx(async (q) => {
    await q("select set_config('hone.admission_mode_studio_id', $1, true)", [s.studioId]);
    await q(
      `update public.studios
          set new_client_admission_mode = 'waitlist',
              new_client_admission_mode_set_at = now()
        where id = $1`,
      [s.studioId],
    );
  });
  await setTexts(s.studioId, texts);
  return s;
}

const setTexts = (studioId: string, on: boolean) =>
  adminQuery(`update public.studios set send_waitlist_invitation_sms = $2 where id = $1`, [studioId, on]);

const uniqueEmail = (tag: string) => `${tag}-${randomUUID().slice(0, 8)}@example.com`;
/**
 * Ten random digits, so a number is new to the database on EVERY run: the
 * per-number limit looks back 24 hours, so a fixed number would meet the
 * previous run's claims on a stack that is not reset between runs.
 */
const freshDigits = () => `6${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
const dashed = (d: string) => `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
/** A sendable number nobody else uses. */
const freshPhone = () => dashed(freshDigits());

/** The 0210 signup command. */
async function signup(
  studioId: string,
  over: Partial<{ email: string; phone: string | null; consent: boolean | null }> = {},
) {
  const r = await adminQuery(
    `select * from public.join_new_client_waitlist_with_phone_and_sms_answer($1, 'Grace Hopper', $2, $3, false, $4)`,
    [
      studioId,
      over.email ?? uniqueEmail("join"),
      over.phone === undefined ? freshPhone() : over.phone,
      over.consent === undefined ? true : over.consent,
    ],
  );
  return r.rows[0] as { result: string; entry_id: string | null };
}

/** 0208's command, unchanged. */
async function signupV1(
  studioId: string,
  over: Partial<{ email: string; phone: string | null; consent: boolean }> = {},
) {
  const r = await adminQuery(
    `select * from public.join_new_client_waitlist_with_sms_answer($1, 'Ada Lovelace', $2, $3, false, $4)`,
    [
      studioId,
      over.email ?? uniqueEmail("v1"),
      over.phone === undefined ? freshPhone() : over.phone,
      over.consent ?? false,
    ],
  );
  return r.rows[0] as { result: string; entry_id: string | null };
}

async function claim(studioId: string, entryId: string | null) {
  const r = await adminQuery(`select * from public.claim_waitlist_join_ack_sms($1, $2)`, [studioId, entryId]);
  return r.rows[0] as {
    result: string;
    message_id: string | null;
    phone: string | null;
    sms_consent_at: Date | null;
    sms_opted_out_at: Date | null;
  };
}

const ledgerFor = async (entryId: string) =>
  (
    await adminQuery(
      `select id, purpose, status, appointment_id, waitlist_invitation_id, waitlist_entry_id
         from public.sms_outbound_messages where waitlist_entry_id = $1`,
      [entryId],
    )
  ).rows;

const entry = async (id: string) =>
  (
    await adminQuery(
      `select phone, status, source, sms_consent_at, sms_consent_source, sms_consent_text_version
         from public.new_client_waitlist_entries where id = $1`,
      [id],
    )
  ).rows[0];

const entriesIn = async (studioId: string) =>
  Number(
    (await adminQuery(`select count(*) from public.new_client_waitlist_entries where studio_id = $1`, [studioId]))
      .rows[0].count,
  );

const joinAckRowsIn = async (studioId: string) =>
  Number(
    (
      await adminQuery(
        `select count(*) from public.sms_outbound_messages
          where studio_id = $1 and purpose = 'waitlist_join_acknowledgement'`,
        [studioId],
      )
    ).rows[0].count,
  );

/**
 * An entry written directly, for the shapes no live command produces any more:
 * an OLD join, a consent outside the join's minute, an entry no longer waiting.
 * The public-form insert trigger stamps joined_at := now(), which is exactly
 * why an old join cannot be made through the front door; the write runs with
 * session_replication_role = replica (as new-studio-admission-default does) so
 * the given instants stand. Test fixture only.
 */
async function insertEntry(
  studioId: string,
  o: {
    joinedAgo: string;
    consentAfterJoin?: string | null;
    version?: string;
    status?: string;
    phone?: string;
  },
) {
  const id = randomUUID();
  await adminTx(async (q) => {
    await q(`set local session_replication_role = replica`);
    await q(
      `insert into public.new_client_waitlist_entries
         (id, studio_id, name, email, phone, status, source, joined_at, joined_at_provenance,
          claimed_at, claimed_by_practitioner_id, invited_at,
          sms_consent_at, sms_consent_source, sms_consent_text_version)
       select $1, $2, 'Direct Row', $3, $4, $5, 'public_booking', now() - $6::interval, 'form',
              case when $5 = 'invited' then now() end,
              case when $5 = 'invited' then (select id from public.practitioners where studio_id = $2 limit 1) end,
              case when $5 = 'invited' then now() end,
              case when $7::interval is null then null else now() - $6::interval + $7::interval end,
              case when $7::interval is null then null else 'public_form' end,
              case when $7::interval is null then null else $8 end`,
      [id, studioId, uniqueEmail("direct"), o.phone ?? freshPhone(), o.status ?? "waiting", o.joinedAgo,
       o.consentAfterJoin === undefined ? "1 second" : o.consentAfterJoin, o.version ?? V2],
    );
  });
  return id;
}

// ===========================================================================
// THE SIGNUP
// ===========================================================================
describe("0210 signup: a phone number is required, and a Yes is version 2", () => {
  it("a Yes with a sendable number joins, records the v2 wording, and keeps the number as typed", async () => {
    const s = await waitlistStudio("ack-signup-yes", false);
    const r = await signup(s.studioId, { phone: " (416) 555-0101 ", consent: true });
    expect(r.result).toBe("created");
    const row = await entry(r.entry_id!);
    expect(row.status).toBe("waiting");
    expect(row.sms_consent_source).toBe("public_form");
    expect(row.sms_consent_text_version).toBe(V2);
    expect(row.sms_consent_at).not.toBeNull();
    expect(row.phone).toContain("416");
  });

  it("a No with a sendable number joins exactly the same way and records no consent", async () => {
    const s = await waitlistStudio("ack-signup-no", false);
    const r = await signup(s.studioId, { consent: false });
    expect(r.result).toBe("created");
    const row = await entry(r.entry_id!);
    expect(row.status).toBe("waiting");
    expect(row.sms_consent_at).toBeNull();
    expect(row.sms_consent_text_version).toBeNull();
  });

  for (const consent of [true, false]) {
    it(`a ${consent ? "Yes" : "No"} with no phone, a blank one, or one the sender cannot text is refused and writes nothing`, async () => {
      const s = await waitlistStudio(`ack-signup-nophone-${consent}`, false);
      for (const phone of [null, "", "   ", "555-0123", "12345", "abc", "+123"]) {
        const r = await signup(s.studioId, { phone, consent });
        expect(r, JSON.stringify(phone)).toEqual({ result: "invalid_input", entry_id: null });
      }
      expect(await entriesIn(s.studioId)).toBe(0);
    });
  }

  it("a missing answer is refused and writes nothing", async () => {
    const s = await waitlistStudio("ack-signup-noanswer", false);
    expect(await signup(s.studioId, { consent: null })).toEqual({ result: "invalid_input", entry_id: null });
    expect(await entriesIn(s.studioId)).toBe(0);
  });

  it("a resubmission changes nothing -- an existing EMAIL-ONLY entry stays exactly as it is", async () => {
    const s = await waitlistStudio("ack-signup-dup", false);
    const email = uniqueEmail("emailonly");
    // Joined before SMS-04 through 0208's command, which allowed no phone on a No.
    const first = await signupV1(s.studioId, { email, phone: null, consent: false });
    expect(first.result).toBe("created");
    const before = await entry(first.entry_id!);
    expect(before.phone).toBeNull();
    const again = await signup(s.studioId, { email, phone: freshPhone(), consent: true });
    expect(again.result).toBe("already_waiting");
    expect(await entry(first.entry_id!)).toEqual(before);
    expect(await entriesIn(s.studioId)).toBe(1);
  });

  it("0208's command is untouched: it still joins without a phone on a No, and records a Yes as v1", async () => {
    const s = await waitlistStudio("ack-signup-v1", false);
    const yes = await signupV1(s.studioId, { consent: true });
    expect((await entry(yes.entry_id!)).sms_consent_text_version).toBe(V1);
    const noPhone = await signupV1(s.studioId, { phone: null, consent: false });
    expect(noPhone.result).toBe("created");
  });

  it("the stored wording version admits v1 and v2 and nothing else", async () => {
    const s = await waitlistStudio("ack-version-check", false);
    for (const [version, ok] of [[V1, true], [V2, true], ["waitlist_sms_operational_v3", false]] as const) {
      const attempt = insertEntry(s.studioId, { joinedAgo: "1 minute", version });
      if (ok) await expect(attempt).resolves.toBeTruthy();
      else await expect(attempt).rejects.toThrow(/text_version_check/);
    }
  });

  it("only service_role may call the new commands; 0208's keeps its own grant", async () => {
    for (const fn of [
      "public.join_new_client_waitlist_with_phone_and_sms_answer(uuid,text,text,text,boolean,boolean)",
      "public.claim_waitlist_join_ack_sms(uuid,uuid)",
      "public.join_new_client_waitlist_with_sms_answer(uuid,text,text,text,boolean,boolean)",
    ]) {
      const r = await adminQuery(
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authenticated,
                has_function_privilege('service_role', $1, 'execute') as service_role`,
        [fn],
      );
      expect(r.rows[0], fn).toEqual({ anon: false, authenticated: false, service_role: true });
    }
  });
});

// ===========================================================================
// THE JOIN TEXT -- ONE CLAIM, ONLY FOR A NEW SIGNUP WITH ITS OWN v2 YES
// ===========================================================================
describe("0210 claim: a genuinely new join with its own Yes is claimed ONCE", () => {
  it("claims a fresh v2 Yes: one ledger row, the right subject, the consented number", async () => {
    const s = await waitlistStudio("ack-claim-ok", true);
    const phone = freshPhone();
    const j = await signup(s.studioId, { phone, consent: true });
    const c = await claim(s.studioId, j.entry_id);
    expect(c.result).toBe("claimed");
    expect(c.message_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.phone).toBe(phone);
    expect(c.sms_consent_at).not.toBeNull();
    expect(c.sms_opted_out_at).toBeNull();
    expect(await ledgerFor(j.entry_id!)).toEqual([
      {
        id: c.message_id,
        purpose: "waitlist_join_acknowledgement",
        status: "claimed",
        appointment_id: null,
        waitlist_invitation_id: null,
        waitlist_entry_id: j.entry_id,
      },
    ]);
  });

  it("a second claim for the same entry is refused and writes nothing", async () => {
    const s = await waitlistStudio("ack-claim-twice", true);
    const j = await signup(s.studioId);
    expect((await claim(s.studioId, j.entry_id)).result).toBe("claimed");
    expect((await claim(s.studioId, j.entry_id)).result).toBe("already_claimed");
    expect(await ledgerFor(j.entry_id!)).toHaveLength(1);
  });

  it("the studio's waitlist texts OFF: studio_disabled, nothing written", async () => {
    const s = await waitlistStudio("ack-claim-off", false);
    const j = await signup(s.studioId);
    expect((await claim(s.studioId, j.entry_id)).result).toBe("studio_disabled");
    expect(await ledgerFor(j.entry_id!)).toHaveLength(0);
  });

  it("a No: not_eligible, nothing written", async () => {
    const s = await waitlistStudio("ack-claim-no", true);
    const j = await signup(s.studioId, { consent: false });
    expect((await claim(s.studioId, j.entry_id)).result).toBe("not_eligible");
    expect(await ledgerFor(j.entry_id!)).toHaveLength(0);
  });

  it("a v1 Yes (0208's command, the old wording) never gets the join text", async () => {
    const s = await waitlistStudio("ack-claim-v1", true);
    const j = await signupV1(s.studioId, { consent: true });
    expect((await claim(s.studioId, j.entry_id)).result).toBe("not_eligible");
    expect(await ledgerFor(j.entry_id!)).toHaveLength(0);
  });

  it("CONTROL: a direct row that joined a minute ago with its own v2 Yes IS claimable", async () => {
    const s = await waitlistStudio("ack-claim-control", true);
    const id = await insertEntry(s.studioId, { joinedAgo: "1 minute" });
    expect((await claim(s.studioId, id)).result).toBe("claimed");
  });

  it("an entry that joined 15 minutes ago or more: not_fresh", async () => {
    const s = await waitlistStudio("ack-claim-stale", true);
    for (const joinedAgo of ["15 minutes 1 second", "20 minutes", "3 days"]) {
      const id = await insertEntry(s.studioId, { joinedAgo });
      expect((await claim(s.studioId, id)).result, joinedAgo).toBe("not_fresh");
      expect(await ledgerFor(id)).toHaveLength(0);
    }
  });

  it("a public-form consent recorded OUTSIDE the join's own minute: not_eligible", async () => {
    const s = await waitlistStudio("ack-claim-late-consent", true);
    // After the minute, and before the join: neither is the join's own Yes.
    for (const consentAfterJoin of ["61 seconds", "3 minutes", "-1 second"]) {
      const id = await insertEntry(s.studioId, { joinedAgo: "5 minutes", consentAfterJoin });
      expect((await claim(s.studioId, id)).result, consentAfterJoin).toBe("not_eligible");
    }
  });

  it("an entry no longer waiting: not_eligible", async () => {
    const s = await waitlistStudio("ack-claim-invited", true);
    const id = await insertEntry(s.studioId, { joinedAgo: "1 minute", status: "invited" });
    expect((await claim(s.studioId, id)).result).toBe("not_eligible");
  });

  it("another studio's entry, a missing entry, or a missing argument writes nothing", async () => {
    const a = await waitlistStudio("ack-claim-tenant-a", true);
    const b = await waitlistStudio("ack-claim-tenant-b", true);
    const j = await signup(a.studioId);
    expect((await claim(b.studioId, j.entry_id)).result).toBe("not_found");
    expect((await claim(a.studioId, randomUUID())).result).toBe("not_found");
    expect((await claim(a.studioId, null)).result).toBe("invalid_input");
    expect(await ledgerFor(j.entry_id!)).toHaveLength(0);
  });
});

// ===========================================================================
// PEOPLE ALREADY WAITING ARE NEVER TEXTED BY IT
// ===========================================================================
describe("0210: existing entries, backfilled consent and the switch send nothing", () => {
  it("turning the switch on writes no row; consent recorded for existing people writes no row; none of them can be claimed", async () => {
    const s = await waitlistStudio("ack-existing", false);
    // Already waiting, in every shape that exists today.
    const emailOnly = (await signupV1(s.studioId, { phone: null, consent: false })).entry_id!;
    const v1Yes = (await signupV1(s.studioId, { consent: true })).entry_id!;
    const noAnswer = (await signupV1(s.studioId, { consent: false })).entry_id!;
    const ownerAdded = (
      await adminQuery(
        `select * from public.create_practitioner_waitlist_entry($1, $2, 'Owner Added', $3, $4, null)`,
        [s.studioId, s.userId, uniqueEmail("owner"), freshPhone()],
      )
    ).rows[0].entry_id as string;
    // The backfill's path: the owner records consent given outside Hone.
    for (const id of [noAnswer, ownerAdded]) {
      const r = await adminQuery(
        `select public.record_waitlist_sms_consent_by_practitioner($1, $2, $3, 'waitlist_operational',
                'Owner attestation: agreed directly with the studio', false, null) as r`,
        [s.studioId, id, s.userId],
      );
      expect(r.rows[0].r).toBe("recorded");
    }
    expect(await joinAckRowsIn(s.studioId)).toBe(0);

    // Waitlist texts ON: still nothing written by the switch itself...
    await setTexts(s.studioId, true);
    expect(await joinAckRowsIn(s.studioId)).toBe(0);

    // ...and no existing person can be claimed, whatever their consent.
    for (const id of [emailOnly, v1Yes, noAnswer, ownerAdded]) {
      expect((await claim(s.studioId, id)).result, id).toBe("not_eligible");
    }
    expect(await joinAckRowsIn(s.studioId)).toBe(0);
  });
});

// ===========================================================================
// ONE TEXT PER NUMBER PER DAY
// ===========================================================================
describe("0210: at most one join text per number per 24 hours, across studios", () => {
  it("a second join with the same number, another email and format, in another studio: recently_acknowledged", async () => {
    const a = await waitlistStudio("ack-number-a", true);
    const b = await waitlistStudio("ack-number-b", true);
    const d = freshDigits();
    const first = await signup(a.studioId, { phone: dashed(d) });
    expect((await claim(a.studioId, first.entry_id)).result).toBe("claimed");
    const second = await signup(b.studioId, { phone: `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)} ${d.slice(6)}` });
    expect(second.result).toBe("created");
    expect((await claim(b.studioId, second.entry_id)).result).toBe("recently_acknowledged");
    expect(await ledgerFor(second.entry_id!)).toHaveLength(0);
  });

  it("an earlier attempt that definitely reached no one (refused, skipped) does not count", async () => {
    const s = await waitlistStudio("ack-number-refused", true);
    const d = freshDigits();
    const first = await signup(s.studioId, { phone: dashed(d) });
    const c = await claim(s.studioId, first.entry_id);
    expect(c.result).toBe("claimed");
    await adminQuery(`select public.settle_sms_message($1, 'refused', null, 21211, null)`, [c.message_id]);
    const second = await signup(s.studioId, { phone: d });
    expect((await claim(s.studioId, second.entry_id)).result).toBe("claimed");
  });
});

// ===========================================================================
// THE PER-NUMBER RULE IS ATOMIC -- two (and six) real connections
// ===========================================================================
// Codex P1 4239431828 (D3 checkpoint: SMS04_JOIN_ACK_PER_NUMBER_RACE_ASSESSMENT
// _2026-10-10). Two entries that share a number lock different rows, and the
// 24-hour check reads committed rows only, so without a lock on the NUMBER both
// claims could pass it before either insert commits. The claim now takes a
// transaction-level advisory lock keyed by the normalized number before that
// check and holds it through the insert. Each case below holds one claim's
// transaction open on its own connection and drives a second claim on another.

/** A dedicated connection, so two claims really are two transactions. */
async function connection() {
  const c = new Client({ connectionString: resolveLocalDbUrl() });
  await c.connect();
  return c;
}

const CLAIM_RESULT = `select result from public.claim_waitlist_join_ack_sms($1, $2)`;

async function backendPid(c: Client): Promise<number> {
  return Number((await c.query("select pg_backend_pid() as pid")).rows[0].pid);
}

/** Poll pg_stat_activity (from the pool) until that backend waits on a lock. */
async function untilWaiting(pid: number) {
  let w: { wait_event_type: string | null; wait_event: string | null } | undefined;
  for (let i = 0; i < 100; i++) {
    w = (
      await adminQuery(`select wait_event_type, wait_event from pg_stat_activity where pid = $1`, [pid])
    ).rows[0];
    if (w?.wait_event_type === "Lock") return w;
    await new Promise((r) => setTimeout(r, 50));
  }
  return w;
}

/** True when the query has finished (either way) within `ms`. */
const settlesWithin = (q: Promise<unknown>, ms: number) =>
  Promise.race([
    q.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);

/** The same ten digits, written the other way. */
const spaced = (d: string) => `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)} ${d.slice(6)}`;

const joinAckRowsFor = async (entryIds: (string | null)[]) =>
  (
    await adminQuery(
      `select waitlist_entry_id, status from public.sms_outbound_messages
        where waitlist_entry_id = any($1::uuid[])`,
      [entryIds],
    )
  ).rows as { waitlist_entry_id: string; status: string }[];

describe("0210: the per-number rule is ATOMIC across entries and studios (real connections)", () => {
  it("the claim is VOLATILE, carries its own 5 s lock_timeout, and claims run READ COMMITTED", async () => {
    const r = await adminQuery(
      `select p.provolatile, p.proconfig from pg_proc p
        where p.oid = 'public.claim_waitlist_join_ack_sms(uuid, uuid)'::regprocedure`,
    );
    // VOLATILE: every statement in it takes a NEW snapshot, so the check after
    // the wait sees what the first claim committed.
    expect(r.rows[0].provolatile).toBe("v");
    expect(r.rows[0].proconfig).toEqual(expect.arrayContaining(["lock_timeout=5s"]));
    const c = await connection();
    try {
      // The isolation a claim actually runs at (PostgREST does not change it).
      expect((await c.query("show transaction_isolation")).rows[0].transaction_isolation).toBe("read committed");
      // The session asks for no bound of its own: the 5 s is the function's.
      expect((await c.query("show lock_timeout")).rows[0].lock_timeout).toBe("0");
    } finally {
      await c.end();
    }
  });

  it("same number, two studios, two formats: the second claim holds its own entry, WAITS on the number, then is refused; one row, still pending", async () => {
    const s1 = await waitlistStudio("ack-atomic-1", true);
    const s2 = await waitlistStudio("ack-atomic-2", true);
    const d = freshDigits();
    const a = await signup(s1.studioId, { phone: dashed(d) });
    const b = await signup(s2.studioId, { phone: spaced(d) });
    const ca = await connection();
    const cb = await connection();
    try {
      await ca.query("begin");
      expect((await ca.query(CLAIM_RESULT, [s1.studioId, a.entry_id])).rows[0].result).toBe("claimed");
      const pidB = await backendPid(cb);
      const second = cb.query(CLAIM_RESULT, [s2.studioId, b.entry_id]);
      // It waits on the ADVISORY lock -- the number -- not on a row ...
      expect(await untilWaiting(pidB)).toMatchObject({ wait_event_type: "Lock", wait_event: "advisory" });
      // ... while already holding ITS OWN entry row: entry first, number second.
      await expect(
        adminQuery(`select 1 from public.new_client_waitlist_entries where id = $1 for update nowait`, [b.entry_id]),
      ).rejects.toMatchObject({ code: "55P03" });
      expect(await settlesWithin(second, 300)).toBe(false);
      await ca.query("commit");
      // Its check ran after the wait, as a new statement: it sees the first claim.
      expect((await second).rows[0].result).toBe("recently_acknowledged");
    } finally {
      await ca.end();
      await cb.end();
    }
    const rows = await joinAckRowsFor([a.entry_id, b.entry_id]);
    expect(rows).toHaveLength(1);
    // The first claim is still PENDING (never settled) -- and a pending claim counts.
    expect(rows[0]).toMatchObject({ waitlist_entry_id: a.entry_id, status: "claimed" });
  });

  it("different numbers: both claim, and neither waits for the other", async () => {
    const s = await waitlistStudio("ack-atomic-diff", true);
    const a = await signup(s.studioId, { phone: dashed(freshDigits()) });
    const c = await signup(s.studioId, { phone: dashed(freshDigits()) });
    const ca = await connection();
    const cc = await connection();
    try {
      await ca.query("begin");
      expect((await ca.query(CLAIM_RESULT, [s.studioId, a.entry_id])).rows[0].result).toBe("claimed");
      const other = cc.query(CLAIM_RESULT, [s.studioId, c.entry_id]);
      // It finishes while the first claim's transaction is still open.
      expect(await settlesWithin(other, 2_000)).toBe(true);
      expect((await other).rows[0].result).toBe("claimed");
      await ca.query("commit");
    } finally {
      await ca.end();
      await cc.end();
    }
    expect(await joinAckRowsFor([a.entry_id, c.entry_id])).toHaveLength(2);
  });

  it("a rollback releases the number: the waiting claim then claims, and the rolled-back claim leaves no row", async () => {
    const s1 = await waitlistStudio("ack-atomic-rb-1", true);
    const s2 = await waitlistStudio("ack-atomic-rb-2", true);
    const d = freshDigits();
    const a = await signup(s1.studioId, { phone: dashed(d) });
    const b = await signup(s2.studioId, { phone: spaced(d) });
    const ca = await connection();
    const cb = await connection();
    try {
      await ca.query("begin");
      expect((await ca.query(CLAIM_RESULT, [s1.studioId, a.entry_id])).rows[0].result).toBe("claimed");
      const pidB = await backendPid(cb);
      const second = cb.query(CLAIM_RESULT, [s2.studioId, b.entry_id]);
      expect(await untilWaiting(pidB)).toMatchObject({ wait_event_type: "Lock", wait_event: "advisory" });
      await ca.query("rollback");
      expect((await second).rows[0].result).toBe("claimed");
    } finally {
      await ca.end();
      await cb.end();
    }
    const rows = await joinAckRowsFor([a.entry_id, b.entry_id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].waitlist_entry_id).toBe(b.entry_id);
  });

  it("BOUNDED: behind a holder that never finishes, a claim gives up at the 5 s lock_timeout (55P03) and writes nothing", async () => {
    const s1 = await waitlistStudio("ack-atomic-bound-1", true);
    const s2 = await waitlistStudio("ack-atomic-bound-2", true);
    const d = freshDigits();
    const a = await signup(s1.studioId, { phone: dashed(d) });
    const b = await signup(s2.studioId, { phone: spaced(d) });
    const ca = await connection();
    const cb = await connection();
    try {
      await ca.query("begin");
      expect((await ca.query(CLAIM_RESULT, [s1.studioId, a.entry_id])).rows[0].result).toBe("claimed");
      const t0 = Date.now();
      await expect(cb.query(CLAIM_RESULT, [s2.studioId, b.entry_id])).rejects.toMatchObject({ code: "55P03" });
      const waited = Date.now() - t0;
      expect(waited).toBeGreaterThanOrEqual(4_500);
      expect(waited).toBeLessThan(9_000);
      await ca.query("rollback");
    } finally {
      await ca.end();
      await cb.end();
    }
    // The timed-out claim wrote nothing (and the rolled-back one nothing either).
    expect(await joinAckRowsFor([a.entry_id, b.entry_id])).toHaveLength(0);
  }, 20_000);

  it("six simultaneous claims for one number across two studios: exactly one claims, five are refused, none deadlocks", async () => {
    const s1 = await waitlistStudio("ack-atomic-burst-1", true);
    const s2 = await waitlistStudio("ack-atomic-burst-2", true);
    const d = freshDigits();
    const entries: { studioId: string; entryId: string }[] = [];
    for (let i = 0; i < 6; i++) {
      const s = i % 2 === 0 ? s1 : s2;
      const j = await signup(s.studioId, { phone: i % 2 === 0 ? dashed(d) : spaced(d) });
      expect(j.result).toBe("created");
      entries.push({ studioId: s.studioId, entryId: j.entry_id! });
    }
    const conns = await Promise.all(entries.map(() => connection()));
    try {
      // Promise.all rejects on any error -- a deadlock (40P01) included.
      const results = await Promise.all(
        entries.map((e, i) => conns[i].query(CLAIM_RESULT, [e.studioId, e.entryId])),
      );
      const answers = results.map((r) => r.rows[0].result).sort();
      expect(answers).toEqual([
        "claimed",
        "recently_acknowledged",
        "recently_acknowledged",
        "recently_acknowledged",
        "recently_acknowledged",
        "recently_acknowledged",
      ]);
    } finally {
      await Promise.all(conns.map((c) => c.end()));
    }
    expect(await joinAckRowsFor(entries.map((e) => e.entryId))).toHaveLength(1);
  });

  it("MUTATION: the same claim WITHOUT the number lock reproduces the original race -- both claim, two rows", async () => {
    const def = (
      await adminQuery(
        `select pg_get_functiondef('public.claim_waitlist_join_ack_sms(uuid, uuid)'::regprocedure) as d`,
      )
    ).rows[0].d as string;
    const LOCK_BLOCK =
      /\n[ \t]*if v_number is not null then\n[ \t]*perform pg_catalog\.pg_advisory_xact_lock\(\n[ \t]*pg_catalog\.hashtextextended\('sms_join_ack_number:' \|\| v_number, 0\)\);\n[ \t]*end if;\n/;
    // The lock is really there to remove, exactly once.
    expect(def.match(new RegExp(LOCK_BLOCK.source, "g")) ?? []).toHaveLength(1);
    const mutant = def
      .replace(LOCK_BLOCK, "\n")
      .replace(
        "FUNCTION public.claim_waitlist_join_ack_sms(",
        "FUNCTION sms04_mutation.claim_without_number_lock(",
      );
    expect(mutant).not.toMatch(/pg_advisory_xact_lock/);
    expect(mutant).toContain("sms04_mutation.claim_without_number_lock(");

    const s1 = await waitlistStudio("ack-atomic-mutant-1", true);
    const s2 = await waitlistStudio("ack-atomic-mutant-2", true);
    const d = freshDigits();
    const a = await signup(s1.studioId, { phone: dashed(d) });
    const b = await signup(s2.studioId, { phone: spaced(d) });
    const MUTANT_RESULT = `select result from sms04_mutation.claim_without_number_lock($1, $2)`;
    await adminQuery("create schema sms04_mutation");
    const ca = await connection();
    const cb = await connection();
    try {
      await adminQuery(mutant);
      await ca.query("begin");
      expect((await ca.query(MUTANT_RESULT, [s1.studioId, a.entry_id])).rows[0].result).toBe("claimed");
      const second = cb.query(MUTANT_RESULT, [s2.studioId, b.entry_id]);
      // Nothing to wait on: it finishes while the first claim is uncommitted ...
      expect(await settlesWithin(second, 2_000)).toBe(true);
      // ... and claims too: the race Codex described.
      expect((await second).rows[0].result).toBe("claimed");
      await ca.query("commit");
    } finally {
      await ca.end();
      await cb.end();
      await adminQuery("drop schema if exists sms04_mutation cascade");
    }
    expect(await joinAckRowsFor([a.entry_id, b.entry_id])).toHaveLength(2);
  });
});

// ===========================================================================
// THE LEDGER'S NEW SUBJECT
// ===========================================================================
describe("0210 ledger: the join text's subject is tenant-bound, single and write-once", () => {
  it("a join text must name an entry, and only a join text may", async () => {
    const s = await waitlistStudio("ack-ledger-shape", true);
    const j = await signup(s.studioId);
    await expect(
      adminQuery(
        `insert into public.sms_outbound_messages (studio_id, purpose) values ($1, 'waitlist_join_acknowledgement')`,
        [s.studioId],
      ),
    ).rejects.toThrow(/subject_ck/);
    await expect(
      adminQuery(
        `insert into public.sms_outbound_messages (studio_id, purpose, appointment_id, waitlist_entry_id)
         values ($1, 'appointment_reminder_24h', gen_random_uuid(), $2)`,
        [s.studioId, j.entry_id],
      ),
    ).rejects.toThrow(/subject_ck|foreign key/);
  });

  it("another studio's entry cannot be named (composite same-studio key)", async () => {
    const a = await waitlistStudio("ack-ledger-fk-a", true);
    const b = await waitlistStudio("ack-ledger-fk-b", true);
    const j = await signup(a.studioId);
    await expect(
      adminQuery(
        `insert into public.sms_outbound_messages (studio_id, purpose, waitlist_entry_id)
         values ($1, 'waitlist_join_acknowledgement', $2)`,
        [b.studioId, j.entry_id],
      ),
    ).rejects.toThrow(/entry_same_studio_fk/);
  });

  it("the subject is write-once", async () => {
    const s = await waitlistStudio("ack-ledger-guard", true);
    const j1 = await signup(s.studioId);
    const j2 = await signup(s.studioId);
    const c = await claim(s.studioId, j1.entry_id);
    await expect(
      adminQuery(`update public.sms_outbound_messages set waitlist_entry_id = $2 where id = $1`, [
        c.message_id,
        j2.entry_id,
      ]),
    ).rejects.toThrow(/write-once/);
  });
});
