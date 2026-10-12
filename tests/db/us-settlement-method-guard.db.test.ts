import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// ===========================================================================
// 0224 — PAY-CCY-07 (#824, option B): a US studio does not record Interac
// e-Transfer. Against a REAL database, through the REAL 0187 commands, as the
// studio's own owner.
//
//   G1  US + paid_e_transfer: refused, nothing written.
//   G2  US + paid_other_external (Zelle / Venmo / check): recorded, in usd.
//   G3  CANADIAN REGRESSION: CA + paid_e_transfer recorded exactly as before.
//   G4  every other method is unaffected in a US studio.
//   G5  the owner's correction cannot turn a US settlement INTO e-transfer,
//       and can still correct one to paid_other_external.
// ===========================================================================

const created: SeededStudio[] = [];
let slot = 0;

async function studio(label: string, country: "CA" | "US"): Promise<SeededStudio> {
  const s = await seedStudio(`usg-${label}`);
  created.push(s);
  if (country === "US") {
    const r = await adminQuery(
      `select out_result from public.set_studio_payment_jurisdiction($1,'US','usd','operator:test','verified US business',false)`,
      [s.studioId],
    );
    expect(r.rows[0].out_result).toBe("changed");
  }
  return s;
}

async function completedAppointment(s: SeededStudio): Promise<string> {
  slot += 1;
  const base = Date.now() - slot * 2 * 3_600_000;
  const r = await adminQuery(
    `insert into public.appointments
       (studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
     values ($1,$2,$3,$4,$5,60,'completed') returning id`,
    [s.studioId, s.practitionerId, s.clientId, new Date(base - 3_600_000).toISOString(), new Date(base).toISOString()],
  );
  return r.rows[0].id as string;
}

async function record(s: SeededStudio, appt: string, method: string) {
  return asUser(s.userId, async (q) => {
    const r = await q(
      `select * from public.record_appointment_settlement($1,$2,$3,4500,null,false)`,
      [s.studioId, appt, method],
    );
    return r.rows[0] as { result: string; settlement_id: string };
  });
}

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the database to refuse");
}

async function settlements(appt: string) {
  const r = await adminQuery(
    `select method, currency, superseded_at is null as live
       from public.appointment_settlements where appointment_id = $1 order by recorded_at`,
    [appt],
  );
  return r.rows as Array<{ method: string; currency: string; live: boolean }>;
}

afterAll(async () => {
  // Settlements are undeletable by design (0187); studios that hold one stay
  // behind, exactly as in the other settlement suites.
  for (const s of created) {
    await adminQuery(`delete from public.studios where id=$1`, [s.studioId]).catch(() => undefined);
  }
  await closePool();
});

describe("0224 US settlement-method guard", () => {
  it("G1: a US studio cannot record paid_e_transfer; nothing is written", async () => {
    const s = await studio("g1", "US");
    const appt = await completedAppointment(s);
    expect(await refused(record(s, appt, "paid_e_transfer"))).toMatch(/settlement_method_unavailable/);
    expect(await settlements(appt)).toEqual([]);
  });

  it("G2: a US Zelle/Venmo/check payment is recorded as paid_other_external, in usd", async () => {
    const s = await studio("g2", "US");
    const appt = await completedAppointment(s);
    expect((await record(s, appt, "paid_other_external")).result).toBe("recorded");
    expect(await settlements(appt)).toEqual([{ method: "paid_other_external", currency: "usd", live: true }]);
  });

  it("G3 CANADIAN REGRESSION: a CA studio records paid_e_transfer exactly as before", async () => {
    const s = await studio("g3", "CA");
    const appt = await completedAppointment(s);
    expect((await record(s, appt, "paid_e_transfer")).result).toBe("recorded");
    expect(await settlements(appt)).toEqual([{ method: "paid_e_transfer", currency: "cad", live: true }]);
  });

  it("G4: every other method is unaffected in a US studio", async () => {
    const s = await studio("g4", "US");
    for (const m of ["paid_cash", "still_owes"]) {
      const appt = await completedAppointment(s);
      expect((await record(s, appt, m)).result).toBe("recorded");
    }
  });

  it("G5: the owner's correction cannot turn a US settlement into e-transfer, and can correct to other", async () => {
    const s = await studio("g5", "US");
    const appt = await completedAppointment(s);
    const first = await record(s, appt, "paid_cash");
    expect(first.result).toBe("recorded");

    const correct = (method: string) =>
      asUser(s.userId, async (q) => {
        const r = await q(
          `select * from public.supersede_appointment_settlement($1,$2,$3,4500,'client paid another way',null,false)`,
          [s.studioId, first.settlement_id, method],
        );
        return r.rows[0] as { result: string };
      });

    expect(await refused(correct("paid_e_transfer"))).toMatch(/settlement_method_unavailable/);
    // The refused correction left the original live and untouched.
    expect(await settlements(appt)).toEqual([{ method: "paid_cash", currency: "usd", live: true }]);

    expect((await correct("paid_other_external")).result).toBe("corrected");
    expect(await settlements(appt)).toEqual([
      { method: "paid_cash", currency: "usd", live: false },
      { method: "paid_other_external", currency: "usd", live: true },
    ]);
  });
});
