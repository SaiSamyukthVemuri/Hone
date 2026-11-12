import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, closePool, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";

// Migration 0338: ONE manual fee per appointment, across BOTH fee types, enforced by a partial unique index over
// (appointment_id, stripe_livemode) for status in (ready, pending_stripe, succeeded). Real database, real concurrency
// (separate pooled connections), synthetic rows only. Failed and cancelled attempts free the appointment; a refunded fee is
// still `succeeded` and still holds it; session_payment is outside the index; test and live modes are independent.

const INDEX = "payment_charge_attempts_one_fee_per_appointment_uniq";
type Reason = "no_show_fee" | "late_cancellation_fee";
let s: SeededStudio;
let slot = 0;

beforeAll(async () => {
  s = await seedStudio("one-fee");
});
afterAll(async () => {
  await closePool();
});

async function seedAppointment(): Promise<string> {
  const id = randomUUID();
  // A distinct calendar day per appointment (date arithmetic: a month-day counter overflows past 31).
  const day = new Date(Date.UTC(2031, 0, 1 + slot++)).toISOString().slice(0, 10);
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, client_id, starts_at, ends_at, duration_minutes, buffer_minutes_snapshot, blocked_ends_at)
     values ($1, $2, $3, $4, $5, 60, 0, $5)`,
    [id, s.studioId, s.clientId, `${day}T10:00:00Z`, `${day}T11:00:00Z`],
  );
  return id;
}

const INSERT = `insert into public.payment_charge_attempts
  (id, studio_id, client_id, appointment_id, charge_reason, created_by_practitioner_id, amount_cents, status, stripe_livemode, stripe_account_id)
  values ($1, $2, $3, $4, $5, $6, 3000, $7, $8, $9)`;
const args = (id: string, appt: string, reason: Reason, status: string, live: boolean) => [
  id, s.studioId, s.clientId, appt, reason, s.practitionerId, status, live, live ? "acct_one_fee_live" : null,
];
const insert = (appt: string, reason: Reason, status = "ready", live = false, id = randomUUID()) =>
  adminQuery(INSERT, args(id, appt, reason, status, live));

async function expectDuplicate(p: Promise<unknown>) {
  await expect(p).rejects.toMatchObject({ code: "23505" });
}
async function holders(appt: string, live = false): Promise<number> {
  const r = await adminQuery(
    `select count(*)::int as n from public.payment_charge_attempts
      where appointment_id = $1 and stripe_livemode = $2 and charge_reason in ('no_show_fee','late_cancellation_fee')
        and status in ('ready','pending_stripe','succeeded')`,
    [appt, live],
  );
  return r.rows[0].n as number;
}

describe("the index exists with the exact predicate", () => {
  it("is unique, over (appointment_id, stripe_livemode), and the status set is ready / pending_stripe / succeeded", async () => {
    const r = await adminQuery(`select indexdef from pg_indexes where schemaname = 'public' and indexname = $1`, [INDEX]);
    expect(r.rows).toHaveLength(1);
    const def = r.rows[0].indexdef as string;
    expect(def).toMatch(/CREATE UNIQUE INDEX/);
    expect(def).toMatch(/\(appointment_id, stripe_livemode\)/);
    expect(def).toMatch(/'late_cancellation_fee'/);
    expect(def).toMatch(/'no_show_fee'/);
    for (const st of ["ready", "pending_stripe", "succeeded"]) expect(def).toContain(`'${st}'`);
    for (const st of ["failed", "cancelled", "blocked"]) expect(def).not.toContain(`'${st}'`);
  });
});

describe("the second fee of the OTHER type fails at insert with 23505 (and names the index)", () => {
  for (const status of ["ready", "pending_stripe", "succeeded"]) {
    it(`a ${status} late-cancel blocks a no-show prepare, and the reverse`, async () => {
      const a = await seedAppointment();
      await insert(a, "late_cancellation_fee", status);
      await expectDuplicate(insert(a, "no_show_fee"));
      const b = await seedAppointment();
      await insert(b, "no_show_fee", status);
      await expectDuplicate(insert(b, "late_cancellation_fee"));
      await adminQuery("select 1");
      const err = await insert(a, "no_show_fee").catch((e) => e as { message: string });
      expect((err as { message: string }).message).toContain(INDEX);
    });
  }
  it("a REFUNDED fee still blocks the other type (a refund leaves status succeeded)", async () => {
    const a = await seedAppointment();
    const id = randomUUID();
    await insert(a, "no_show_fee", "succeeded", false, id);
    await adminQuery(
      `update public.payment_charge_attempts set refund_status = 'succeeded', refund_amount_cents = 3000 where id = $1`,
      [id],
    );
    expect((await adminQuery(`select status from public.payment_charge_attempts where id = $1`, [id])).rows[0].status).toBe("succeeded");
    await expectDuplicate(insert(a, "late_cancellation_fee"));
  });
});

describe("only a failed or cancelled attempt frees the appointment", () => {
  for (const freed of ["failed", "cancelled"]) {
    it(`after a ${freed} attempt the other type (and the same type) can be prepared`, async () => {
      const a = await seedAppointment();
      await insert(a, "late_cancellation_fee", freed);
      await insert(a, "no_show_fee");
      expect(await holders(a)).toBe(1);
    });
  }
  it("two terminal attempts plus one active is fine; a second active is not", async () => {
    const a = await seedAppointment();
    await insert(a, "no_show_fee", "failed");
    await insert(a, "late_cancellation_fee", "cancelled");
    await insert(a, "no_show_fee", "ready");
    await expectDuplicate(insert(a, "late_cancellation_fee", "ready"));
  });
  it("an UNCERTAIN earlier outcome (still pending_stripe) keeps blocking; a definite failure then frees it", async () => {
    const a = await seedAppointment();
    const earlier = randomUUID();
    await insert(a, "late_cancellation_fee", "pending_stripe", false, earlier);
    await expectDuplicate(insert(a, "no_show_fee"));
    await adminQuery(`update public.payment_charge_attempts set status = 'failed', failed_at = now() where id = $1`, [earlier]);
    await insert(a, "no_show_fee");
    expect(await holders(a)).toBe(1);
  });
  it("a status transition INTO the set is also refused while another fee holds the appointment", async () => {
    const a = await seedAppointment();
    const dead = randomUUID();
    await insert(a, "no_show_fee", "cancelled", false, dead);
    await insert(a, "late_cancellation_fee", "ready");
    await expectDuplicate(adminQuery(`update public.payment_charge_attempts set status = 'ready' where id = $1`, [dead]));
  });
});

describe("concurrency: two prepares of DIFFERENT types, real parallel connections, both orders", () => {
  async function race(first: Reason, second: Reason, live = false) {
    const a = await seedAppointment();
    const results = await Promise.allSettled([insert(a, first, "ready", live), insert(a, second, "ready", live)]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const dup = results.filter((r) => r.status === "rejected" && (r.reason as { code?: string }).code === "23505").length;
    expect({ ok, dup }).toEqual({ ok: 1, dup: 1 });
    expect(await holders(a, live)).toBe(1);
  }
  it("late-cancel vs no-show submitted together: exactly one row", async () => race("late_cancellation_fee", "no_show_fee"));
  it("no-show vs late-cancel submitted together: exactly one row", async () => race("no_show_fee", "late_cancellation_fee"));
  it("repeated 15 times in alternating order: never two", async () => {
    for (let i = 0; i < 15; i++) {
      await race(i % 2 ? "no_show_fee" : "late_cancellation_fee", i % 2 ? "late_cancellation_fee" : "no_show_fee");
    }
  });
  it("the interleaving Insurance described: the first transaction is open (uncommitted) when the second inserts; the second WAITS, then fails on commit", async () => {
    const a = await seedAppointment();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    let firstInserted!: () => void;
    const inserted = new Promise<void>((r) => (firstInserted = r));
    const first = adminTx(async (q) => {
      await q(INSERT, args(randomUUID(), a, "late_cancellation_fee", "ready", false));
      firstInserted();
      await gate; // hold the transaction open: the row is not yet visible to anyone else
    });
    await inserted;
    let secondSettled = false;
    const second = insert(a, "no_show_fee").then(
      () => ({ ok: true }),
      (e: { code?: string }) => ({ ok: false, code: e.code }),
    ).finally(() => (secondSettled = true));
    await new Promise((r) => setTimeout(r, 400));
    expect(secondSettled, "the second insert must WAIT on the open first transaction, not slip past it").toBe(false);
    releaseFirst();
    await first;
    expect(await second).toEqual({ ok: false, code: "23505" });
    expect(await holders(a)).toBe(1);
  });
  it("if the first transaction ROLLS BACK instead, the second succeeds (the slot is not leaked)", async () => {
    const a = await seedAppointment();
    let firstInserted!: () => void;
    const inserted = new Promise<void>((r) => (firstInserted = r));
    const first = adminTx(async (q) => {
      await q(INSERT, args(randomUUID(), a, "late_cancellation_fee", "ready", false));
      firstInserted();
      await new Promise((r) => setTimeout(r, 300));
      throw new Error("abort first");
    }).catch(() => "rolled back");
    await inserted;
    await insert(a, "no_show_fee");
    expect(await first).toBe("rolled back");
    expect(await holders(a)).toBe(1);
  });
  it("two simultaneous claims of the SAME ready attempt still give exactly one 'claimed' (the 0105 same-type path is unchanged)", async () => {
    const a = await seedAppointment();
    const id = randomUUID();
    await insert(a, "no_show_fee", "ready", false, id);
    const claim = () => adminQuery(`select (public.claim_session_payment_charge_attempt($1, $2, $3)).result as result`, [id, s.practitionerId, `hone:no_show_fee:${id}:v1`]);
    const rs = await Promise.all([claim(), claim()]);
    const results = rs.map((r) => r.rows[0].result as string).sort();
    expect(results.filter((x) => x === "claimed")).toHaveLength(1);
  });
});

describe("what the index must NOT touch", () => {
  it("session_payment is unaffected: a session payment and a fee on the same client coexist; two sessions' payments are independent", async () => {
    const a = await seedAppointment();
    await insert(a, "no_show_fee");
    const { sessionId } = await seedSession(s);
    await adminQuery(
      `insert into public.payment_charge_attempts
         (id, studio_id, client_id, session_id, charge_reason, created_by_practitioner_id, amount_cents, status, stripe_livemode)
       values ($1, $2, $3, $4, 'session_payment', $5, 2500, 'ready', false)`,
      [randomUUID(), s.studioId, s.clientId, sessionId, s.practitionerId],
    );
    expect(await holders(a)).toBe(1);
  });
  it("test and live modes are independent: a test fee does not block a live fee of the other type, and live blocks live", async () => {
    const a = await seedAppointment();
    await insert(a, "late_cancellation_fee", "ready", false);
    await insert(a, "no_show_fee", "ready", true);
    await expectDuplicate(insert(a, "late_cancellation_fee", "ready", true));
    expect(await holders(a, false)).toBe(1);
    expect(await holders(a, true)).toBe(1);
  });
  it("a different appointment is never blocked", async () => {
    const a = await seedAppointment();
    const b = await seedAppointment();
    await insert(a, "no_show_fee");
    await insert(b, "late_cancellation_fee");
    expect(await holders(a)).toBe(1);
    expect(await holders(b)).toBe(1);
  });
});
