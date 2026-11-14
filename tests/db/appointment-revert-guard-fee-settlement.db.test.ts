// 0344 — the outcome-revert guard also refuses while a no-show / late-cancel
// fee (payment_charge_attempts) or a live settlement exists for the appointment.
//
// Every refusal is asserted as a TOTAL no-op (row and audit unchanged), the
// existing payment_state / manual_fee reasons are asserted unchanged, a fee
// that is failed or cancelled does not block, and a superseded settlement does
// not block. Negative control: the same state with the new clause removed lets
// the revert through (see the last describe).

import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  adminQuery,
  adminTx,
  closePool,
  seedStudio,
  seedHistoricalAppointmentAudit,
  type SeededStudio,
} from "./helpers/harness";

afterAll(async () => {
  await closePool();
});

async function seedAppt(
  studio: SeededStudio,
  status: "no_show" | "cancelled" | "completed",
  daysAhead = 30,
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id,
        starts_at, ends_at, duration_minutes, status)
     values ($1, $2, $3, $4, null,
        now() + ($6 || ' days')::interval, now() + ($6 || ' days')::interval + interval '60 minutes', 60, $5)`,
    [id, studio.studioId, studio.practitionerId, studio.clientId, status, String(daysAhead)],
  );
  await seedHistoricalAppointmentAudit({
    appointmentId: id,
    actorType: "practitioner",
    actorId: studio.practitionerId,
    action:
      status === "no_show"
        ? "marked_no_show"
        : status === "cancelled"
          ? "cancelled"
          : "marked_complete",
    createdAtSql: `now() - interval '1 hour'`,
  });
  return id;
}

async function insertFee(
  studio: SeededStudio,
  appt: string,
  reason: "no_show_fee" | "late_cancellation_fee",
  status: string,
  livemode: boolean,
) {
  await adminQuery(
    `insert into public.payment_charge_attempts
       (id, studio_id, client_id, appointment_id, charge_reason,
        created_by_practitioner_id, amount_cents, status,
        stripe_livemode, stripe_account_id)
     values ($1, $2, $3, $4, $5, $6, 3000, $7, $8, $9)`,
    [
      randomUUID(), studio.studioId, studio.clientId, appt, reason,
      studio.practitionerId, status, livemode,
      livemode ? "acct_revert_guard_live" : null,
    ],
  );
}

async function insertSettlement(studio: SeededStudio, appt: string): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.appointment_settlements
       (id, studio_id, appointment_id, method, amount_cents, recorded_by_practitioner_id)
     values ($1, $2, $3, 'paid_cash', 3000, $4)`,
    [id, studio.studioId, appt, studio.practitionerId],
  );
  return id;
}

async function reasonFor(studio: SeededStudio, appt: string): Promise<string | null> {
  const r = await adminQuery(
    `select public.appointment_has_blocking_dependents($1, $2) r`,
    [appt, studio.studioId],
  );
  return r.rows[0].r as string | null;
}

async function snapshot(id: string): Promise<string> {
  const r = await adminQuery(
    `select to_jsonb(a.*) j from public.appointments a where a.id = $1`,
    [id],
  );
  return JSON.stringify(r.rows[0]?.j ?? null);
}

async function auditCount(id: string): Promise<number> {
  const r = await adminQuery(
    `select count(*)::int n from public.appointment_audit where appointment_id = $1`,
    [id],
  );
  return r.rows[0].n as number;
}

async function revert(studio: SeededStudio, appt: string, expected: string): Promise<string> {
  const r = await adminQuery(
    `select public.revert_appointment_outcome($1, $2, $3, $4, $5) code`,
    [appt, studio.studioId, studio.userId, expected, "Marked by mistake, client rebooked"],
  );
  return r.rows[0].code as string;
}

async function expectBlocked(
  studio: SeededStudio,
  appt: string,
  expected: string,
  code: string,
) {
  const before = await snapshot(appt);
  const beforeAudit = await auditCount(appt);
  expect(await revert(studio, appt, expected)).toBe(code);
  expect(await snapshot(appt), "row must be untouched").toBe(before);
  expect(await auditCount(appt), "audit must be untouched").toBe(beforeAudit);
}

describe("0344 — fee_charge blocks the revert", () => {
  for (const reason of ["no_show_fee", "late_cancellation_fee"] as const) {
    for (const livemode of [false, true]) {
      for (const status of ["ready", "pending_stripe", "succeeded"]) {
        it(`${reason} / ${status} / ${livemode ? "live" : "test"} refuses with blocked_fee_charge`, async () => {
          const studio = await seedStudio("g0344-fee");
          const appt = await seedAppt(studio, reason === "no_show_fee" ? "no_show" : "cancelled");
          await insertFee(studio, appt, reason, status, livemode);
          expect(await reasonFor(studio, appt)).toBe("fee_charge");
          await expectBlocked(
            studio,
            appt,
            reason === "no_show_fee" ? "no_show" : "cancelled",
            "blocked_fee_charge",
          );
        });
      }
    }
  }

  for (const status of ["failed", "cancelled"]) {
    it(`a ${status} fee does not block`, async () => {
      const studio = await seedStudio("g0344-free");
      const appt = await seedAppt(studio, "no_show");
      await insertFee(studio, appt, "no_show_fee", status, false);
      expect(await reasonFor(studio, appt)).toBeNull();
      expect(await revert(studio, appt, "no_show")).not.toMatch(/^blocked_/);
    });
  }

  it("a session_payment attempt on the appointment is not a fee and does not trip fee_charge", async () => {
    const studio = await seedStudio("g0344-sp");
    const appt = await seedAppt(studio, "completed");
    // A fee on ANOTHER appointment of the same studio must not block this one.
    const other = await seedAppt(studio, "no_show", 40);
    await insertFee(studio, other, "no_show_fee", "succeeded", false);
    expect(await reasonFor(studio, appt)).toBeNull();
  });
});

describe("0344 — settlement blocks the revert", () => {
  it("a live settlement refuses with blocked_settlement", async () => {
    const studio = await seedStudio("g0344-set");
    const appt = await seedAppt(studio, "completed");
    await insertSettlement(studio, appt);
    expect(await reasonFor(studio, appt)).toBe("settlement");
    await expectBlocked(studio, appt, "completed", "blocked_settlement");
  });

  it("a corrected settlement chain still blocks, through its single live row", async () => {
    const studio = await seedStudio("g0344-chain");
    const appt = await seedAppt(studio, "completed");
    const first = await insertSettlement(studio, appt);
    const second = randomUUID();
    await adminTx(async (q) => {
      // The superseded_by FK is deferred to commit, so the retire-then-insert
      // order the correction chain uses is legal inside one transaction.
      await q(
        `update public.appointment_settlements
            set superseded_at = now(), superseded_by_settlement_id = $2
          where id = $1`,
        [first, second],
      );
      await q(
        `insert into public.appointment_settlements
           (id, studio_id, appointment_id, method, amount_cents, recorded_by_practitioner_id)
         values ($1, $2, $3, 'paid_e_transfer', 3000, $4)`,
        [second, studio.studioId, appt, studio.practitionerId],
      );
    });
    const live = await adminQuery(
      `select count(*)::int n from public.appointment_settlements
        where appointment_id = $1 and superseded_at is null`,
      [appt],
    );
    expect(live.rows[0].n).toBe(1);
    expect(await reasonFor(studio, appt)).toBe("settlement");
  });
});

describe("0344 — earlier reasons and ordering are unchanged", () => {
  it("a fee and a settlement together report fee_charge (fixed order, fee first)", async () => {
    const studio = await seedStudio("g0344-order");
    const appt = await seedAppt(studio, "no_show");
    await insertFee(studio, appt, "no_show_fee", "succeeded", false);
    await insertSettlement(studio, appt);
    expect(await reasonFor(studio, appt)).toBe("fee_charge");
  });

  it("an earlier reason still wins over the new ones (linked_session)", async () => {
    const studio = await seedStudio("g0344-earlier");
    const appt = await seedAppt(studio, "completed");
    await insertFee(studio, appt, "no_show_fee", "succeeded", false);
    await adminQuery(
      `update public.appointments set rescheduled_to_appointment_id = $2 where id = $1`,
      [appt, await seedAppt(studio, "completed", 50)],
    );
    expect(await reasonFor(studio, appt)).toBe("rescheduled");
  });

  it("a clean appointment still reports null", async () => {
    const studio = await seedStudio("g0344-clean");
    const appt = await seedAppt(studio, "no_show");
    expect(await reasonFor(studio, appt)).toBeNull();
  });
});

describe("0344 — negative control", () => {
  // Re-install the 0177 function (the down file's body) inside a transaction,
  // so the new clauses are GONE, and roll back. With them gone the same fee or
  // settlement state no longer blocks the revert; with them present it does.
  const down = readFileSync(
    join(__dirname, "..", "..", "supabase", "rollbacks", "0344_revert_guard_fee_settlement.down.sql"),
    "utf8",
  );
  const fnStart = down.indexOf("create or replace function public.appointment_has_blocking_dependents(");
  const oldFn = down.slice(fnStart, down.indexOf("$$;", fnStart) + 3);

  async function revertWithoutNewClauses(studio: SeededStudio, appt: string, expected: string) {
    const ROLLBACK = new Error("rollback");
    let code = "";
    await adminTx(async (q) => {
      await q(oldFn);
      const r = await q(
        `select public.revert_appointment_outcome($1, $2, $3, $4, $5) code`,
        [appt, studio.studioId, studio.userId, expected, "Marked by mistake, client rebooked"],
      );
      code = r.rows[0].code as string;
      throw ROLLBACK; // adminTx rolls back on throw: the 0177 function is not left installed
    }).catch((e) => {
      if (e !== ROLLBACK) throw e;
    });
    return code;
  }

  it("fee: the revert is blocked now, and goes through once the fee clause is gone", async () => {
    const studio = await seedStudio("g0344-negf");
    const appt = await seedAppt(studio, "no_show");
    await insertFee(studio, appt, "no_show_fee", "succeeded", false);
    expect(await revert(studio, appt, "no_show")).toBe("blocked_fee_charge");
    expect(await revertWithoutNewClauses(studio, appt, "no_show")).toBe("ok");
    expect(await reasonFor(studio, appt), "rollback restored the new function").toBe("fee_charge");
  });

  it("settlement: the revert is blocked now, and goes through once the settlement clause is gone", async () => {
    const studio = await seedStudio("g0344-negs");
    const appt = await seedAppt(studio, "completed");
    await insertSettlement(studio, appt);
    expect(await revert(studio, appt, "completed")).toBe("blocked_settlement");
    expect(await revertWithoutNewClauses(studio, appt, "completed")).toBe("ok");
    expect(await reasonFor(studio, appt)).toBe("settlement");
  });
});
