import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asUser, closePool } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";

// HON-48 simultaneous booking, MOVE versus BOOK. #1337 proves booking against booking. This file proves a move racing a booking
// for the same time: the owner moves an existing appointment into a time while the front desk, a second practitioner or the owner
// books that same time, on separate connections, through the real writers (move_or_reassign_appointment, create_internal_appointment_v2,
// receptionist_create_appointment). For BOTH capacity modes:
//   * exactly ONE appointment holds the contested time (OFF: studio-wide; ON: per practitioner);
//   * the loser gets an HONEST refusal (a named result or the 23P01 exclusion the app maps to "no longer available"), never a
//     deadlock (40P01), serialisation failure (40001), lock timeout (55P03) or any other error;
//   * ground truth agrees: a move that won frees the old time, a move that lost leaves the appointment where it was, and no
//     appointment is ever lost or duplicated.
// Synthetic data on the run's own stack only. Test-only; stacked on #1337's harness. Run on e9723b829's chain (own isolated stack):
// passes; no 40P01 has been seen in this file's runs, and there is NO deadlock allowance here: a 40P01 in a move race fails (BL-4/BK4).

let B: SynthStudio;
let serviceId: string;
let deskUserId: string;
const owner = () => B.practitioners[0].practitionerId;
const member = () => B.practitioners[1].practitionerId;
const DATE = "2031-09-16";
const DOW = new Date(`${DATE}T12:00:00Z`).getUTCDay();
const T = (hhmm: string) => `${DATE}T${hhmm}:00.000Z`;
const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

type Outcome = { kind: "created" | "moved" | "refused" | "error"; detail: string };
const HONEST_REFUSALS = new Set(["buffer_conflict", "23P01"]);
const classify = (e: unknown): Outcome => {
  const code = (e as { code?: string }).code ?? "unknown";
  return { kind: HONEST_REFUSALS.has(code) ? "refused" : "error", detail: code };
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

/** An existing confirmed appointment, created through the real command so its times are exactly what the move command expects. */
async function existing(practitionerId: string, start: string): Promise<{ id: string; startsAt: string; endsAt: string }> {
  const r = await adminQuery(
    `select * from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,false)`,
    [B.studioId, owner(), practitionerId, B.clientId, serviceId, start, hash64()],
  );
  expect((r.rows[0] as { result: string }).result).toBe("created");
  const a = await adminQuery(
    `select id, starts_at::text as s, ends_at::text as e from public.appointments where studio_id=$1 and practitioner_id=$2 and starts_at=$3::timestamptz and status='confirmed'`,
    [B.studioId, practitionerId, start],
  );
  return { id: a.rows[0].id as string, startsAt: a.rows[0].s as string, endsAt: a.rows[0].e as string };
}

const mover = (appt: { id: string; startsAt: string; endsAt: string }, newStart: string) => async (): Promise<Outcome> => {
  try {
    const r = await adminQuery(
      `select * from public.move_or_reassign_appointment($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,false)`,
      [appt.id, B.studioId, owner(), null, appt.startsAt, appt.endsAt, newStart],
    );
    const result = (r.rows[0] as { result: string }).result;
    if (result === "moved") return { kind: "moved", detail: "moved" };
    return { kind: HONEST_REFUSALS.has(result) ? "refused" : "error", detail: result };
  } catch (e) {
    return classify(e);
  }
};
const bookerService = (actor: () => string, target: () => string, start: string) => async (): Promise<Outcome> => {
  try {
    const r = await adminQuery(
      `select * from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,false)`,
      [B.studioId, actor(), target(), B.clientId, serviceId, start, hash64()],
    );
    const row = r.rows[0] as { result: string };
    if (row.result === "created") return { kind: "created", detail: "created" };
    return { kind: HONEST_REFUSALS.has(row.result) ? "refused" : "error", detail: row.result };
  } catch (e) {
    return classify(e);
  }
};
const bookerDesk = (target: () => string, start: string) => async (): Promise<Outcome> => {
  try {
    const r = await asUser(deskUserId, (x) => x(`select * from public.receptionist_create_appointment($1,$2,$3,$4,$5::timestamptz)`, [B.studioId, target(), B.clientId, serviceId, start]));
    const row = r.rows[0] as { result: string };
    if (row.result === "created") return { kind: "created", detail: "created" };
    return { kind: HONEST_REFUSALS.has(row.result) ? "refused" : "error", detail: row.result };
  } catch (e) {
    return classify(e);
  }
};

const confirmedAt = async (start: string, practitionerId?: string) =>
  (await adminQuery(
    `select count(*)::int n from public.appointments where studio_id=$1 and status='confirmed' and starts_at=$2::timestamptz and ($3::uuid is null or practitioner_id=$3::uuid)`,
    [B.studioId, start, practitionerId ?? null],
  )).rows[0].n as number;
const totalConfirmed = async () =>
  (await adminQuery(`select count(*)::int n from public.appointments where studio_id=$1 and status='confirmed'`, [B.studioId])).rows[0].n as number;

afterEach(async () => { if (B) await dropSynthStudio(B); });
afterAll(async () => { await closePool(); });

const ROUNDS = 6;
// Rounds are 4 hours apart (origin, target): a 60-minute visit plus the 30-minute soft buffer never touches the next round's times.
const ORIGIN = ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"];
const TARGET = ["02:00", "06:00", "10:00", "14:00", "18:00", "22:00"];

for (const capacity of [false, true]) {
  const mode = capacity ? "capacity ON (one resource per practitioner)" : "capacity OFF (the studio is one resource)";
  describe(`HON-48 move versus book: ${mode}`, () => {
    beforeEach(async () => { await setup(capacity); });

    it("the owner moves an appointment into a time while the front desk books that same time for the same practitioner: one holds it", async () => {
      for (let i = 0; i < ROUNDS; i += 1) {
        const appt = await existing(owner(), T(ORIGIN[i]));
        const before = await totalConfirmed();
        const results = await Promise.all([mover(appt, T(TARGET[i]))(), bookerDesk(owner, T(TARGET[i]))()]);
        const tag = `round ${i}: ${JSON.stringify(results)}`;
        expect(results.filter((o) => o.kind === "error"), tag).toHaveLength(0);
        expect(await confirmedAt(T(TARGET[i]), owner()), tag).toBe(1);
        const moved = results[0].kind === "moved";
        // A winning move frees the old time and leaves the count unchanged; a losing move leaves the appointment where it was and the desk's booking added.
        expect(await confirmedAt(T(ORIGIN[i]), owner()), tag).toBe(moved ? 0 : 1);
        expect(await totalConfirmed(), tag).toBe(moved ? before : before + 1);
        expect(results.filter((o) => o.kind === "refused"), tag).toHaveLength(1);
      }
    });

    it("a move and a service booking by the owner into the same time for the owner: one holds it, the other is refused honestly", async () => {
      for (let i = 0; i < ROUNDS; i += 1) {
        const appt = await existing(owner(), T(ORIGIN[i]));
        const results = await Promise.all([mover(appt, T(TARGET[i]))(), bookerService(owner, owner, T(TARGET[i]))()]);
        const tag = `round ${i}: ${JSON.stringify(results)}`;
        expect(results.filter((o) => o.kind === "error"), tag).toHaveLength(0);
        expect(await confirmedAt(T(TARGET[i]), owner()), tag).toBeLessThanOrEqual(1);
        expect(results.filter((o) => o.kind === "moved" || o.kind === "created"), tag).toHaveLength(1);
      }
    });

    it("two moves into the same time (the owner's appointment and the second practitioner's): the contested time is held per the capacity mode", async () => {
      // Per 6-hour block: owner's visit 00:00, the second practitioner's 01:30 (a 30-minute gap, so capacity OFF accepts both), contested target 04:00.
      for (let i = 0; i < 4; i += 1) {
        const base = i * 6;
        const hh = (h: number, m = 0) => `${String(base + h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        const a = await existing(owner(), T(hh(0)));
        const b = await existing(member(), T(hh(1, 30)));
        const results = await Promise.all([mover(a, T(hh(4)))(), mover(b, T(hh(4)))()]);
        const tag = `round ${i}: ${JSON.stringify(results)}`;
        expect(results.filter((o) => o.kind === "error"), tag).toHaveLength(0);
        // OFF: the studio is one resource, so exactly one move lands. ON: each practitioner has their own resource, so both may land.
        const landed = results.filter((o) => o.kind === "moved").length;
        expect(landed, tag).toBeGreaterThanOrEqual(1);
        expect(landed, tag).toBeLessThanOrEqual(capacity ? 2 : 1);
        expect(await confirmedAt(T(hh(4))), tag).toBe(landed);
        expect(await totalConfirmed(), tag).toBe((i + 1) * 2);
      }
    });

    it("a refused racer leaves no duplicate and no lost appointment", async () => {
      const appt = await existing(owner(), T("00:00"));
      await Promise.all([mover(appt, T("06:00"))(), bookerDesk(owner, T("06:00"))(), bookerService(owner, owner, T("06:00"))()]);
      expect(await confirmedAt(T("06:00"), owner())).toBe(1);
      const total = await totalConfirmed();
      // Either the move won (1 appointment in total) or a booking won (the original plus the winner).
      expect([1, 2]).toContain(total);
      const ids = (await adminQuery(`select id from public.appointments where studio_id=$1 and status='confirmed'`, [B.studioId])).rows.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
}
