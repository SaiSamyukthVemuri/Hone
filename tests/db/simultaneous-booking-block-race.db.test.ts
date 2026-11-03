import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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

type Outcome = { kind: "created" | "refused" | "error"; detail: string };
// A refusal is honest when it is the hard-overlap exclusion, or a named (non-exception) result from the booking command.
const classify = (e: unknown): Outcome => {
  const code = (e as { code?: string }).code ?? "unknown";
  return { kind: code === "23P01" ? "refused" : "error", detail: code };
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

/** A 60-minute timed block. practitioner null = studio-wide. */
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
    return result === "created" ? { kind: "created", detail: "created" } : { kind: "refused", detail: result };
  } catch (e) {
    return classify(e);
  }
};
const bookerDesk = (target: () => string, start: string) => async (): Promise<Outcome> => {
  try {
    const r = await asUser(deskUserId, (x) => x(`select * from public.receptionist_create_appointment($1,$2,$3,$4,$5::timestamptz)`, [B.studioId, target(), B.clientId, serviceId, start]));
    const result = (r.rows[0] as { result: string }).result;
    return result === "created" ? { kind: "created", detail: "created" } : { kind: "refused", detail: result };
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
const KNOWN_DEFECT_HON48_DEADLOCK = true; // flip to false when Willow's fix lands
const recorded: string[] = []; // every allowed 40P01, for the run summary
afterAll(() => {
  if (recorded.length) console.info(`HON-48-DEADLOCK recorded ${recorded.length} allowed 40P01 outcome(s) (KNOWN_DEFECT_HON48_DEADLOCK=${KNOWN_DEFECT_HON48_DEADLOCK}):\n${recorded.join("\n")}`);
});

type Round = { tag: string; results: Outcome[]; blockDelta: number; bookingDelta: number };
/**
 * The contract checks, run on EVERY round whether or not a racer errored: no booking inside a block, no error other than the known
 * deadlock, and the row counts equal the outcomes (an errored racer left nothing behind).
 */
async function checkRound(i: number, results: Outcome[], before: { blocks: number; bookings: number }, blockIndex: number | null): Promise<Round> {
  const tag = `round ${i}: ${JSON.stringify(results)}`;
  expect(await bookingsInsideBlocks(), tag).toBe(0);
  const allowed = (o: Outcome) => KNOWN_DEFECT_HON48_DEADLOCK && o.detail === KNOWN_DEADLOCK;
  expect(results.filter((o) => o.kind === "error" && !allowed(o)), tag).toHaveLength(0);
  for (const o of results) if (o.kind === "error") recorded.push(tag);
  const after = await counts();
  const blockWon = blockIndex !== null && results[blockIndex].kind === "created";
  const bookingsWon = results.filter((o, k) => k !== blockIndex && o.kind === "created").length;
  expect(after.blocks - before.blocks, tag).toBe(blockWon ? 1 : 0);
  expect(after.bookings - before.bookings, tag).toBe(bookingsWon);
  return { tag, results, blockDelta: after.blocks - before.blocks, bookingDelta: after.bookings - before.bookings };
}

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
        const rounds: Round[] = [];
        for (let i = 0; i < ROUNDS; i += 1) {
          const start = T(`${HOURS[i]}:00`);
          const before = await counts();
          const results = await Promise.all([blocker(start, scope.practitioner())(), bookerService(owner, start)(), bookerDesk(owner, start)()]);
          const round = await checkRound(i, results, before, 0);
          // At most one of block and booking exists (they are the same time); a deadlocked racer can leave none, never two.
          expect(round.blockDelta + round.bookingDelta, round.tag).toBeLessThanOrEqual(1);
          rounds.push(round);
        }
        return rounds;
      };
      const partial = async (): Promise<Round[]> => {
        const rounds: Round[] = [];
        for (let i = 0; i < ROUNDS; i += 1) {
          const hh = HOURS[i];
          const before = await counts();
          const results = await Promise.all([blocker(T(`${hh}:00`), scope.practitioner())(), bookerService(owner, T(plus(`${hh}:00`, 30)))()]);
          const round = await checkRound(i, results, before, 0);
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
        const rounds: Round[] = [];
        for (let i = 0; i < ROUNDS; i += 1) {
          const start = T(`${HOURS[i]}:00`);
          const before = await counts();
          const results = await Promise.all([blocker(start, owner())(), bookerService(member, start)()]);
          rounds.push(await checkRound(i, results, before, 0));
        }
        return rounds;
      };
      it("a block scoped to the OWNER and a booking for the SECOND practitioner at the same time: the block always lands, nothing is inside a block", async () => {
        const rounds = await unrelated();
        for (const r of rounds) {
          expect(r.results[0].kind, r.tag).not.toBe("refused"); // the owner's block is never refused by an unrelated booking
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
