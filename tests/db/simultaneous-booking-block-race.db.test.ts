import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { adminQuery, asUser, closePool } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";

// HON-48 simultaneous booking, BOOKING versus a timed BLOCK. A block (or break) and a booking are created at the same moment for the
// same practitioner and time, on separate connections, through the real writers (an insert into studio_timed_blocks, which the
// reservation synchroniser guards with the GiST exclusion, versus create_internal_appointment_v2 and receptionist_create_appointment).
// For BOTH capacity modes. Capacity OFF: the block is studio-wide (a scoped block needs capacity ON, 0137). Capacity ON: the block is
// scoped to the owner (the same practitioner), and a studio-wide block is raced too.
// The contract: either the block refuses the booking or the booking lands before the block (the block is then refused); never a
// booking inside a block. Every loser gets an HONEST refusal (a named result, or the 23P01 exclusion the app maps to "that time is no
// longer available"), never a serialisation failure (40001), lock timeout (55P03) or any other error. Ground truth: no confirmed
// appointment ever overlaps a block that applies to its practitioner.
// KNOWN DEFECT (HON-48-DEADLOCK; diagnosis routed to Willow by OPS, 3 Nov 2026): run on e9723b829, one racer in these races
// intermittently gets a raw 40P01 (deadlock detected) instead of a clean created/refused result, including an unrelated
// practitioner's booking in the capacity-ON scoped-block case. The defect is intermittent, so it is NOT an expected-fail: while
// KNOWN_DEFECT_HON48_DEADLOCK is true a 40P01 is an ALLOWED but RECORDED outcome (printed in the run summary) and every other error
// still fails. The invariant (no booking inside a block) and the counts (row deltas equal the outcomes) are HARD on every round, error
// or not. When the fix lands, set the constant to false: any 40P01 then fails, and the unrelated-practitioner case must land both.
// Synthetic data on the run's own stack only. Test-only; stacked on #1337's harness.

let B: SynthStudio;
let serviceId: string;
let deskUserId: string;
const owner = () => B.practitioners[0].practitionerId;
const member = () => B.practitioners[1].practitionerId;
const DATE = "2031-09-16";
const DOW = new Date(`${DATE}T12:00:00Z`).getUTCDay();
const T = (hhmm: string) => `${DATE}T${hhmm}:00.000Z`;
const plus = (hhmm: string, minutes: number) => {
  const [h, m] = hhmm.split(":").map(Number);
  const t = h * 60 + m + minutes;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};
const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

type Outcome = { kind: "created" | "refused" | "error"; detail: string; ctx?: string };
// BK1 (Privacy PEER-1346): ONLY these are honest refusals: the hard-overlap exclusion the app maps to "that time is no longer
// available", and the buffer conflict. Any other named result (not_eligible, invalid_service, not_authorized, ...) means the setup or
// the actor is wrong, not that the block won, so it is an ERROR and fails the round instead of passing vacuously.
const HONEST_REFUSALS = new Set(["23P01", "buffer_conflict"]);
// A refusal is honest when it is the hard-overlap exclusion, or a named (non-exception) result from the booking command.
const classify = (e: unknown): Outcome => {
  const code = (e as { code?: string }).code ?? "unknown";
  const pg = e as { detail?: string; where?: string };
  // ctx = the server's DETAIL (which processes wait on which lock) and CONTEXT (which statement/function), used to tell the known deadlock from any other.
  return { kind: HONEST_REFUSALS.has(code) ? "refused" : "error", detail: code, ctx: `${pg.detail ?? ""} | ${pg.where ?? ""}`.replace(/\s+/g, " ").trim() };
};

async function setup(capacity: boolean) {
  B = await seedSynthStudioB();
  await adminQuery(
    `update public.studios set practitioner_capacity_enabled = $2, practitioner_capacity_booking_enabled = $2, timezone = 'UTC', buffer_minutes = 30 where id = $1`,
    [B.studioId, capacity],
  );
  const svc = await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active) values ($1,$2,'Consult',60,0,true) returning id`,
    [randomUUID(), B.studioId],
  );
  serviceId = svc.rows[0].id as string;
  await adminQuery(
    `insert into public.studio_availability_default (id, studio_id, day_of_week, is_open, open_time, close_time) values (gen_random_uuid(),$1,$2,true,'00:00','23:59')`,
    [B.studioId, DOW],
  );
  for (const p of B.practitioners) {
    await adminQuery(`insert into public.service_practitioners (studio_id, service_id, practitioner_id) values ($1,$2,$3) on conflict do nothing`, [B.studioId, serviceId, p.practitionerId]);
  }
  deskUserId = randomUUID();
  await adminQuery("insert into auth.users(id,email) values ($1,$2)", [deskUserId, `desk-${deskUserId.slice(0, 8)}@harness.local`]);
  await adminQuery("insert into public.studio_receptionists(studio_id,user_id,display_name,active) values ($1,$2,'Synthetic Front Desk',true)", [B.studioId, deskUserId]);
}

/**
 * A 60-minute timed block. practitioner null = studio-wide. BK3: this is a direct insert on the admin connection, the statement the
 * block writers ultimately run; whether it mirrors the app's block-writing path exactly is for Willow's HON-48-DEADLOCK diagnosis to confirm.
 */
const blocker = (start: string, practitionerId: string | null) => async (): Promise<Outcome> => {
  try {
    await adminQuery(
      `insert into public.studio_timed_blocks (id, studio_id, starts_at, ends_at, category, practitioner_id) values ($1,$2,$3::timestamptz,$3::timestamptz + interval '60 minutes','break',$4)`,
      [randomUUID(), B.studioId, start, practitionerId],
    );
    return { kind: "created", detail: "block created" };
  } catch (e) {
    return classify(e);
  }
};
const bookerService = (target: () => string, start: string) => async (): Promise<Outcome> => {
  try {
    const r = await adminQuery(
      `select * from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,false)`,
      [B.studioId, owner(), target(), B.clientId, serviceId, start, hash64()],
    );
    const result = (r.rows[0] as { result: string }).result;
    return result === "created" ? { kind: "created", detail: "created" } : { kind: HONEST_REFUSALS.has(result) ? "refused" : "error", detail: result };
  } catch (e) {
    return classify(e);
  }
};
const bookerDesk = (target: () => string, start: string) => async (): Promise<Outcome> => {
  try {
    const r = await asUser(deskUserId, (x) => x(`select * from public.receptionist_create_appointment($1,$2,$3,$4,$5::timestamptz)`, [B.studioId, target(), B.clientId, serviceId, start]));
    const result = (r.rows[0] as { result: string }).result;
    return result === "created" ? { kind: "created", detail: "created" } : { kind: HONEST_REFUSALS.has(result) ? "refused" : "error", detail: result };
  } catch (e) {
    return classify(e);
  }
};

/** Ground truth: confirmed appointments that overlap a block applying to their practitioner (studio-wide blocks apply to everyone). Must be 0. */
const bookingsInsideBlocks = async () =>
  (await adminQuery(
    `select count(*)::int n from public.appointments a
       join public.studio_timed_blocks b on b.studio_id = a.studio_id
        and (b.practitioner_id is null or b.practitioner_id = a.practitioner_id)
        and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
      where a.studio_id = $1 and a.status = 'confirmed'`,
    [B.studioId],
  )).rows[0].n as number;
const counts = async () => ({
  blocks: (await adminQuery(`select count(*)::int n from public.studio_timed_blocks where studio_id=$1`, [B.studioId])).rows[0].n as number,
  bookings: (await adminQuery(`select count(*)::int n from public.appointments where studio_id=$1 and status='confirmed'`, [B.studioId])).rows[0].n as number,
});

afterEach(async () => { if (B) await dropSynthStudio(B); });
afterAll(async () => { await closePool(); });

const ROUNDS = 6;
const HOURS = ["00", "03", "06", "09", "12", "15"]; // 3 hours apart: a 60-minute visit plus the 30-minute buffer never touches the next round
const KNOWN_DEADLOCK = "40P01";
// OWNER: Willow (diagnosis of HON-48-DEADLOCK, routed by OPS 3 Nov 2026). Flip to false when the fix merges. It EXPIRES on
// KNOWN_DEFECT_EXPIRES: the guard test below fails after that date while this is still true, forcing a decision (fix landed, or OPS
// and Sam accept the known defect for longer and move the date).
const KNOWN_DEFECT_HON48_DEADLOCK = false;
const KNOWN_DEFECT_EXPIRES = "2026-11-24";
// BA-1 (Insurance PEER-1346): the allowance is narrowed to the KNOWN cycle only: SQLSTATE 40P01 AND the error's DETAIL/CONTEXT matches this
// signature (the lock/function names seen in the observed deadlock) AND it happened in one of the scenarios where it was observed. A
// different deadlock (other tables, other functions, another scenario) fails the round.
// Pinned from a capture run at e9723b829 (13 deadlocks across the 7 scenarios, two shapes of ONE cycle family): the studio-capacity advisory
// lock (acquire_studio_capacity_lock, reached through create_internal_appointment_v2 / create_appointment_core) against a transaction
// lock, either as the booking command waiting on the advisory lock (11) or as the block insert's foreign-key check on the studios row
// (FOR KEY SHARE, 2). DETAIL must show BOTH waits, and CONTEXT must name the capacity-lock function or the studios row.
// BL-1/BL2: the DETAIL must also show EXACTLY two processes (a three-way cycle is a different deadlock). The block-victim shape's captured
// CONTEXT names the studios foreign-key check, not the studio_timed_blocks statement, so the statement cannot be required without data
// we do not have; this pattern is therefore a family match, not proof of the exact cycle (Willow's diagnosis is the authority).
const KNOWN_DEADLOCK_CONTEXT = /^(?=.*ExclusiveLock on advisory lock)(?=.*ShareLock on transaction)(?=(?:.*?Process \d+ waits for){2})(?!(?:.*?Process \d+ waits for){3})(?=.*(acquire_studio_capacity_lock|relation "studios"))/;
// BL-2/BL2: this set lists every scenario the file runs, so it is a TYPO GUARD (a new scenario must be added here on purpose), not a
// narrowing; the block-insert-versus-booking pair comes from the structure of the tests (checkRound is only called with the block racer).
const KNOWN_DEADLOCK_SCENARIOS = new Set<string>([
  "off|studio-wide block|same-time", "off|studio-wide block|partial",
  "on|block scoped to the owner|same-time", "on|block scoped to the owner|partial",
  "on|studio-wide block|same-time", "on|studio-wide block|partial",
  "on|owner-block-vs-second-practitioner|unrelated",
]);
const recorded: string[] = []; // every allowed 40P01 with its DETAIL/CONTEXT, for the run summary
// Durable record (not console-only) and a ceiling: the defect getting WORSE must not stay green. Observed at e9723b829: 13, 16 and 17 allowed
// deadlock outcomes per run (of 42 race rounds); the ceiling leaves headroom but fails a collapse (Privacy BK2/BL3).
const MAX_ALLOWED_DEADLOCK_OUTCOMES = 30;
afterAll(() => {
  if (recorded.length) {
    try {
      const dir = process.env.HON48_DEADLOCK_RECORD_DIR ?? path.join(process.cwd(), "test-results");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "hon48-deadlock-record.json"), JSON.stringify({ known_defect: "HON-48-DEADLOCK", allowed_outcomes: recorded.length, ceiling: MAX_ALLOWED_DEADLOCK_OUTCOMES, rounds: recorded }, null, 1));
    } catch { /* the record is best-effort; the ceiling test below is the gate */ }
  }
  if (recorded.length) console.info(`HON-48-DEADLOCK recorded ${recorded.length} allowed 40P01 outcome(s) (KNOWN_DEFECT_HON48_DEADLOCK=${KNOWN_DEFECT_HON48_DEADLOCK}):\n${recorded.join("\n")}`);
});

type Round = { tag: string; results: Outcome[]; blockDelta: number; bookingDelta: number };
/**
 * The contract checks, run on EVERY round whether or not a racer errored: no booking inside a block, no error other than the known
 * deadlock, and the row counts equal the outcomes (an errored racer left nothing behind).
 */
async function checkRound(i: number, results: Outcome[], before: { blocks: number; bookings: number }, blockIndex: number | null, scenario: string): Promise<Round> {
  const tag = `round ${i}: ${JSON.stringify(results)}`;
  expect(await bookingsInsideBlocks(), tag).toBe(0);
  // The racing pair is always (block insert, booking command): checkRound is only called with the block racer at blockIndex.
  const allowed = (o: Outcome) =>
    KNOWN_DEFECT_HON48_DEADLOCK && o.detail === KNOWN_DEADLOCK && blockIndex !== null && KNOWN_DEADLOCK_SCENARIOS.has(scenario) && KNOWN_DEADLOCK_CONTEXT.test(o.ctx ?? "");
  expect(results.filter((o) => o.kind === "error" && !allowed(o)), tag).toHaveLength(0);
  for (const o of results) if (o.kind === "error") recorded.push(`${scenario} ${tag} ctx=${o.ctx}`);
  const after = await counts();
  const blockWon = blockIndex !== null && results[blockIndex].kind === "created";
  const bookingsWon = results.filter((o, k) => k !== blockIndex && o.kind === "created").length;
  expect(after.blocks - before.blocks, tag).toBe(blockWon ? 1 : 0);
  expect(after.bookings - before.bookings, tag).toBe(bookingsWon);
  // Non-vacuous: someone won every round (a block or a booking), so a round of refusals/errors alone cannot pass.
  expect(results.filter((o) => o.kind === "created").length, tag).toBeGreaterThanOrEqual(1);
  return { tag, results, blockDelta: after.blocks - before.blocks, bookingDelta: after.bookings - before.bookings };
}

/**
 * Positive control, run at the start of every race test on the same fresh studio: with NO competing block a service booking and a
 * front-desk booking both land, and a block in an empty hour lands. This proves the actors, service and setup can book at all, so a
 * race round where the booking is refused is a real refusal and not a broken fixture (BK1).
 */
async function positiveControl() {
  expect(await bookerService(owner, T("18:00"))(), "control: service booking with no block must land").toEqual({ kind: "created", detail: "created" });
  expect(await bookerDesk(owner, T("21:00"))(), "control: front-desk booking with no block must land").toEqual({ kind: "created", detail: "created" });
  // The SECOND practitioner can book too (a 30-minute gap from the other bookings, which both capacity modes accept), so a refusal of
  // their booking in a race is a real refusal and not a fixture problem (Privacy BL1).
  expect(await bookerService(member, T("19:30"))(), "control: the second practitioner's booking with no block must land").toEqual({ kind: "created", detail: "created" });
  expect(await blocker(T("23:00"), null)(), "control: a block in an empty hour must land").toEqual({ kind: "created", detail: "block created" });
}

// BA-1: the signature accepts the two captured shapes and REJECTS a different deadlock (pure, no database).
describe("HON-48-DEADLOCK signature", () => {
  const bookingVictim = 'Process 1 waits for ExclusiveLock on advisory lock [5,1,2,1]; blocked by process 2. Process 2 waits for ShareLock on transaction 9; blocked by process 1. | SQL function "acquire_studio_capacity_lock" statement 1 SQL statement "SELECT public.acquire_studio_capacity_lock(p_studio_id)" PL/pgSQL function public.create_appointment_core(text) line 23 at PERFORM';
  const blockVictim = 'Process 1 waits for ShareLock on transaction 9; blocked by process 2. Process 2 waits for ExclusiveLock on advisory lock [5,1,2,1]; blocked by process 1. | while locking tuple (0,16) in relation "studios" SQL statement "SELECT 1 FROM ONLY "public"."studios" x WHERE "id" OPERATOR(pg_catalog.=) $1 FOR KEY SHARE OF x"';
  it("accepts the two captured shapes", () => {
    expect(KNOWN_DEADLOCK_CONTEXT.test(bookingVictim)).toBe(true);
    expect(KNOWN_DEADLOCK_CONTEXT.test(blockVictim)).toBe(true);
  });
  it("rejects a three-process cycle even when the locks and function match", () => {
    expect(KNOWN_DEADLOCK_CONTEXT.test(`${bookingVictim} Process 3 waits for ShareLock on transaction 7; blocked by process 1.`)).toBe(false);
  });
  it("rejects a different deadlock (other locks, other tables or functions) and an empty context", () => {
    expect(KNOWN_DEADLOCK_CONTEXT.test('Process 1 waits for ShareLock on transaction 9; blocked by process 2. Process 2 waits for ShareLock on transaction 8; blocked by process 1. | while updating tuple (0,3) in relation "appointments"')).toBe(false);
    expect(KNOWN_DEADLOCK_CONTEXT.test('Process 1 waits for ExclusiveLock on advisory lock [5,1,2,1]; blocked by process 2. | PL/pgSQL function public.some_other_function() line 4')).toBe(false);
    expect(KNOWN_DEADLOCK_CONTEXT.test("")).toBe(false);
  });
});

// BK2 expiry guard: fails after KNOWN_DEFECT_EXPIRES while the known-defect allowance is still on.
describe("HON-48-DEADLOCK known-defect expiry", () => {
  it(`the allowance for the known deadlock is not past its expiry (${KNOWN_DEFECT_EXPIRES}, owner Willow)`, () => {
    const expiresAt = Date.parse(`${KNOWN_DEFECT_EXPIRES}T23:59:59Z`);
    const expired = Date.now() > expiresAt;
    // BL-3: warn for the last 7 days (visible in the run) before this turns the DB lane red; the decision belongs in the decision log.
    if (KNOWN_DEFECT_HON48_DEADLOCK && !expired && expiresAt - Date.now() < 7 * 24 * 3600 * 1000) {
      console.warn(`KNOWN_DEFECT_HON48_DEADLOCK expires ${KNOWN_DEFECT_EXPIRES}: decide now (fix landed? flip to false; otherwise OPS and Sam extend it).`);
    }
    expect(
      KNOWN_DEFECT_HON48_DEADLOCK && expired,
      `KNOWN_DEFECT_HON48_DEADLOCK is still true after ${KNOWN_DEFECT_EXPIRES}. If Willow's HON-48-DEADLOCK fix has merged set it to false; otherwise OPS and Sam must accept the defect for longer and move KNOWN_DEFECT_EXPIRES.`,
    ).toBe(false);
  });
});

for (const capacity of [false, true]) {
  const mode = capacity ? "capacity ON (one resource per practitioner)" : "capacity OFF (the studio is one resource)";
  // OFF: only a studio-wide block exists. ON: the same practitioner's SCOPED block, and the studio-wide one.
  const scopes: Array<{ name: string; practitioner: () => string | null }> = capacity
    ? [{ name: "block scoped to the owner", practitioner: owner }, { name: "studio-wide block", practitioner: () => null }]
    : [{ name: "studio-wide block", practitioner: () => null }];

  describe(`HON-48 booking versus block: ${mode}`, () => {
    beforeEach(async () => { await setup(capacity); });

    for (const scope of scopes) {
      const sameTime = async (): Promise<Round[]> => {
        await positiveControl();
        const rounds: Round[] = [];
        for (let i = 0; i < ROUNDS; i += 1) {
          const start = T(`${HOURS[i]}:00`);
          const before = await counts();
          const results = await Promise.all([blocker(start, scope.practitioner())(), bookerService(owner, start)(), bookerDesk(owner, start)()]);
          const round = await checkRound(i, results, before, 0, `${capacity ? "on" : "off"}|${scope.name}|same-time`);
          // At most one of block and booking exists (they are the same time); a deadlocked racer can leave none, never two.
          expect(round.blockDelta + round.bookingDelta, round.tag).toBeLessThanOrEqual(1);
          rounds.push(round);
        }
        return rounds;
      };
      const partial = async (): Promise<Round[]> => {
        await positiveControl();
        const rounds: Round[] = [];
        for (let i = 0; i < ROUNDS; i += 1) {
          const hh = HOURS[i];
          const before = await counts();
          const results = await Promise.all([blocker(T(`${hh}:00`), scope.practitioner())(), bookerService(owner, T(plus(`${hh}:00`, 30)))()]);
          const round = await checkRound(i, results, before, 0, `${capacity ? "on" : "off"}|${scope.name}|partial`);
          // They overlap, so they cannot both exist.
          expect(round.blockDelta + round.bookingDelta, round.tag).toBeLessThanOrEqual(1);
          rounds.push(round);
        }
        return rounds;
      };

      it(`${scope.name} and a booking for the owner at the SAME time (service and front desk): never a booking inside a block, whatever the racers return`, async () => {
        await sameTime();
      });

      it(`${scope.name} and a booking that only PARTLY overlaps it: never a booking inside a block, whatever the racers return`, async () => {
        await partial();
      });
    }

    if (capacity) {
      const unrelated = async (): Promise<Round[]> => {
        await positiveControl();
        const rounds: Round[] = [];
        for (let i = 0; i < ROUNDS; i += 1) {
          const start = T(`${HOURS[i]}:00`);
          const before = await counts();
          const results = await Promise.all([blocker(start, owner())(), bookerService(member, start)()]);
          rounds.push(await checkRound(i, results, before, 0, "on|owner-block-vs-second-practitioner|unrelated"));
        }
        return rounds;
      };
      it("a block scoped to the OWNER and a booking for the SECOND practitioner at the same time: the owner's block is never refused, nothing is inside a block (both-land is asserted only once the known defect is cleared)", async () => {
        const rounds = await unrelated();
        for (const r of rounds) {
          expect(r.results[0].kind, r.tag).not.toBe("refused"); // the owner's block is never refused by an unrelated booking
          // Regardless of the constant: an owner's block must never refuse ANOTHER practitioner's booking in capacity ON (created, or the allowed deadlock).
          expect(r.results[1].kind === "created" || r.results[1].kind === "error", `second practitioner's booking was refused: ${r.tag}`).toBe(true);
          if (!KNOWN_DEFECT_HON48_DEADLOCK) expect(r.results.map((o) => o.kind), r.tag).toEqual(["created", "created"]);
        }
      });
    } else {
      it("a SCOPED block cannot be created while capacity is OFF (refused with 42501, not silently widened)", async () => {
        const o = await blocker(T("00:00"), owner())();
        expect(o.kind).toBe("error"); // the scope guard's 42501 is not an overlap refusal: it is the documented refusal for this state
        expect(o.detail).toBe("42501");
        expect((await counts()).blocks).toBe(0);
      });
    }
  });
}

// Ceiling on the allowed known deadlock per run. Runs last in the file; a filtered run that skipped the race tests records none.
describe("HON-48-DEADLOCK ceiling", () => {
  it(`allowed deadlock outcomes stay at or under ${MAX_ALLOWED_DEADLOCK_OUTCOMES} per run`, () => {
    expect(recorded.length, `the known deadlock hit ${recorded.length} outcomes; the ceiling is ${MAX_ALLOWED_DEADLOCK_OUTCOMES}. It is getting worse: tell Willow.`).toBeLessThanOrEqual(MAX_ALLOWED_DEADLOCK_OUTCOMES);
  });
});
