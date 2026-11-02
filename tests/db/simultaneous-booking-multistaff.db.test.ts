import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asUser, closePool } from "./helpers/harness";
import { dropSynthStudio, seedSynthStudioB, type SynthStudio } from "./helpers/synth-fleet";

// HON-48 simultaneous booking. Several actors (the owner, a second practitioner,
// a receptionist) try to book the SAME time at the same moment, on separate
// connections, through the three real writers: create_internal_appointment_v2
// (practitioner / owner) and receptionist_create_appointment (front desk, as an
// authenticated user). The contract proved here, for BOTH capacity modes:
//   * exactly ONE booking per contested resource survives (OFF: the whole
//     studio is one resource; ON: one per practitioner);
//   * every loser gets an HONEST refusal: a named refusal result or the
//     exclusion error the app maps to "that time is no longer available"
//     (23P01). Never a second booking, never a deadlock (40P01), a
//     serialisation failure (40001), a lock timeout (55P03) or any other error;
//   * ground truth in the table and the audit agrees with the winners.
// Synthetic data on the run's own stack only.

let B: SynthStudio;
let serviceId: string;
let deskUserId: string;
const owner = () => B.practitioners[0].practitionerId;
const member = () => B.practitioners[1].practitionerId;
const DATE = "2031-09-16";
const DOW = new Date(`${DATE}T12:00:00Z`).getUTCDay();
const T = (hhmm: string) => `${DATE}T${hhmm}:00.000Z`;
const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

type Outcome = { kind: "created" | "refused" | "error"; detail: string };
type Racer = { name: string; run: (start: string) => Promise<Outcome> };

// Refusals a loser may honestly return. buffer_conflict is the soft-gap refusal;
// 23P01 is the hard actual-overlap exclusion (the app maps it to "slot taken").
const HONEST_REFUSALS = new Set(["buffer_conflict", "23P01"]);

async function setup(capacity: boolean) {
  B = await seedSynthStudioB();
  await adminQuery(
    `update public.studios set practitioner_capacity_enabled = $2,
       practitioner_capacity_booking_enabled = $2, timezone = 'UTC', buffer_minutes = 30
     where id = $1`,
    [B.studioId, capacity],
  );
  const svc = await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1,$2,'Consult',60,0,true) returning id`,
    [randomUUID(), B.studioId],
  );
  serviceId = svc.rows[0].id as string;
  await adminQuery(
    `insert into public.studio_availability_default (id, studio_id, day_of_week, is_open, open_time, close_time)
     values (gen_random_uuid(),$1,$2,true,'00:00','23:59')`,
    [B.studioId, DOW],
  );
  for (const p of B.practitioners) {
    await adminQuery(
      `insert into public.service_practitioners (studio_id, service_id, practitioner_id)
       values ($1,$2,$3) on conflict do nothing`,
      [B.studioId, serviceId, p.practitionerId],
    );
  }
  deskUserId = randomUUID();
  await adminQuery("insert into auth.users(id,email) values ($1,$2)", [deskUserId, `desk-${deskUserId.slice(0, 8)}@harness.local`]);
  await adminQuery(
    "insert into public.studio_receptionists(studio_id,user_id,display_name,active) values ($1,$2,'Synthetic Front Desk',true)",
    [B.studioId, deskUserId],
  );
}

const classify = (e: unknown): Outcome => {
  const code = (e as { code?: string }).code ?? "unknown";
  return { kind: HONEST_REFUSALS.has(code) ? "refused" : "error", detail: code };
};

// A practitioner (or owner) booking through the service-role command.
const practitionerBooks =
  (name: string, actor: () => string, target: () => string, outside = false): Racer => ({
    name,
    run: async (start) => {
      try {
        const r = await adminQuery(
          `select * from public.create_internal_appointment_v2($1,$2,$3,$4,$5,$6::timestamptz,$7,null,null,$8)`,
          [B.studioId, actor(), target(), B.clientId, serviceId, start, hash64(), outside],
        );
        const row = r.rows[0] as { result: string };
        if (row.result === "created") return { kind: "created", detail: "created" };
        return { kind: HONEST_REFUSALS.has(row.result) ? "refused" : "error", detail: row.result };
      } catch (e) {
        return classify(e);
      }
    },
  });

// The front desk, as the authenticated user the app presents to Postgres.
const receptionistBooks = (name: string, target: () => string): Racer => ({
  name,
  run: async (start) => {
    try {
      const r = await asUser(deskUserId, (x) =>
        x(`select * from public.receptionist_create_appointment($1,$2,$3,$4,$5::timestamptz)`, [
          B.studioId,
          target(),
          B.clientId,
          serviceId,
          start,
        ]),
      );
      const row = r.rows[0] as { result: string };
      if (row.result === "created") return { kind: "created", detail: "created" };
      return { kind: HONEST_REFUSALS.has(row.result) ? "refused" : "error", detail: row.result };
    } catch (e) {
      return classify(e);
    }
  },
});

async function race(racers: Racer[], start: string) {
  const settled = await Promise.all(racers.map(async (r) => ({ name: r.name, outcome: await r.run(start) })));
  return settled;
}

const confirmedAt = async (start: string, practitionerId?: string) =>
  (
    await adminQuery(
      `select count(*)::int n from public.appointments
        where studio_id=$1 and status='confirmed' and starts_at=$2::timestamptz
          and ($3::uuid is null or practitioner_id=$3::uuid)`,
      [B.studioId, start, practitionerId ?? null],
    )
  ).rows[0].n as number;

const createdAuditAt = async (start: string) =>
  (
    await adminQuery(
      `select count(*)::int n from public.appointment_audit au
         join public.appointments a on a.id = au.appointment_id
        where a.studio_id=$1 and a.starts_at=$2::timestamptz and au.action='created'`,
      [B.studioId, start],
    )
  ).rows[0].n as number;

afterEach(async () => {
  if (B) await dropSynthStudio(B);
});
afterAll(async () => {
  await closePool();
});

const ROUNDS = 6;
const HOURS = ["08", "09", "10", "11", "12", "13", "14", "15", "16", "17"];

for (const capacity of [false, true]) {
  const mode = capacity ? "capacity ON (one resource per practitioner)" : "capacity OFF (the studio is one resource)";

  describe(`HON-48 simultaneous booking: ${mode}`, () => {
    beforeEach(async () => {
      await setup(capacity);
    });

    it("two practitioners and the front desk booking the SAME time at once: exactly one booking per resource, honest refusals for the rest", async () => {
      for (let i = 0; i < ROUNDS; i += 1) {
        const start = T(`${HOURS[i]}:00`);
        // Owner books the owner, the second practitioner books themself, the desk books each of them.
        const racers = [
          practitionerBooks("owner->owner", owner, owner),
          practitionerBooks("member->member", member, member),
          receptionistBooks("desk->owner", owner),
          receptionistBooks("desk->member", member),
        ];
        const results = await race(racers, start);
        const created = results.filter((r) => r.outcome.kind === "created");
        const errors = results.filter((r) => r.outcome.kind === "error");
        expect(errors, `round ${i}: ${JSON.stringify(results)}`).toHaveLength(0);
        // OFF: one studio-wide resource -> 1. ON: one per practitioner -> 2.
        const expected = capacity ? 2 : 1;
        expect(created, `round ${i}: ${JSON.stringify(results)}`).toHaveLength(expected);
        expect(await confirmedAt(start)).toBe(expected);
        expect(await createdAuditAt(start)).toBe(expected);
        if (capacity) {
          expect(await confirmedAt(start, owner())).toBe(1);
          expect(await confirmedAt(start, member())).toBe(1);
        }
      }
    });

    it("three actors fighting for ONE practitioner's time: exactly one wins (owner override included)", async () => {
      for (let i = 0; i < ROUNDS; i += 1) {
        const start = T(`${HOURS[i]}:00`);
        const racers = [
          practitionerBooks("owner->member", owner, member),
          practitionerBooks("member->member", member, member),
          practitionerBooks("owner->member (override)", owner, member, true),
          receptionistBooks("desk->member", member),
        ];
        const results = await race(racers, start);
        expect(results.filter((r) => r.outcome.kind === "error"), JSON.stringify(results)).toHaveLength(0);
        expect(results.filter((r) => r.outcome.kind === "created"), JSON.stringify(results)).toHaveLength(1);
        expect(await confirmedAt(start, member())).toBe(1);
        expect(await confirmedAt(start)).toBe(1);
      }
    });

    it("PARTLY overlapping starts (12:30 vs 13:00 for one hour) race: exactly one survives", async () => {
      for (let i = 0; i < ROUNDS; i += 1) {
        const hh = HOURS[i];
        const a = practitionerBooks("owner->owner A", owner, owner);
        const b = receptionistBooks("desk->owner B", owner);
        const [ra, rb] = await Promise.all([a.run(T(`${hh}:00`)), b.run(T(`${hh}:30`))]);
        expect([ra, rb].filter((o) => o.kind === "error"), JSON.stringify([ra, rb])).toHaveLength(0);
        expect([ra, rb].filter((o) => o.kind === "created"), JSON.stringify([ra, rb])).toHaveLength(1);
        const n = (
          await adminQuery(
            `select count(*)::int n from public.appointments
              where studio_id=$1 and status='confirmed' and practitioner_id=$2
                and starts_at >= $3::timestamptz and starts_at < $4::timestamptz`,
            [B.studioId, owner(), T(`${hh}:00`), T(`${HOURS[i]}:59`)],
          )
        ).rows[0].n as number;
        // On capacity OFF the booking is studio-wide; either way it is a single row for the owner's window.
        expect(n).toBeLessThanOrEqual(1);
      }
    });

    it("back-to-back times inside the soft buffer race: exactly one is created, the other refused honestly", async () => {
      for (let i = 0; i < ROUNDS; i += 1) {
        const hh = Number(HOURS[i]);
        const first = `${String(hh).padStart(2, "0")}:00`;
        const second = `${String(hh + 1).padStart(2, "0")}:00`; // touches the end of the first; inside the 30-minute gap
        const a = practitionerBooks("owner->owner early", owner, owner);
        const b = receptionistBooks("desk->owner late", owner);
        const [ra, rb] = await Promise.all([a.run(T(first)), b.run(T(second))]);
        const outcomes = [ra, rb];
        expect(outcomes.filter((o) => o.kind === "error"), JSON.stringify(outcomes)).toHaveLength(0);
        expect(outcomes.filter((o) => o.kind === "created"), JSON.stringify(outcomes)).toHaveLength(1);
        expect(outcomes.filter((o) => o.kind === "refused"), JSON.stringify(outcomes)).toHaveLength(1);
        expect(outcomes.find((o) => o.kind === "refused")?.detail).toBe("buffer_conflict");
      }
    });

    it("a refused racer leaves no row, no audit and no side effect behind", async () => {
      const start = T("09:00");
      const results = await race(
        [
          practitionerBooks("owner->owner", owner, owner),
          receptionistBooks("desk->owner", owner),
          practitionerBooks("owner->owner (2nd)", owner, owner),
        ],
        start,
      );
      expect(results.filter((r) => r.outcome.kind === "created")).toHaveLength(1);
      const rows = await adminQuery(
        `select count(*)::int n from public.appointments where studio_id=$1`,
        [B.studioId],
      );
      expect(rows.rows[0].n).toBe(1);
      expect(await createdAuditAt(start)).toBe(1);
    });
  });
}
