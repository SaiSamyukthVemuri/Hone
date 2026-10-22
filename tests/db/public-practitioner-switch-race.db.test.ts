import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool } from "./helpers/harness";
import {
  FETT_DEMO_SLOT_SQL,
  dropFettStudio,
  seedFettStudio,
  setFettCapacityState,
  type FettStudio,
} from "./helpers/fett-fixture";

// CODEX P1 (4253666090) + P2 (4253666098), proved by DIRECT RPC.
//
// Both findings were about the TRANSACTION BOUNDARY, which is exactly where an
// application check cannot reach:
//
//   P1 the switch race. `practitioner_capacity_booking_enabled` (0136) was
//      read only in TypeScript. An operator disabling it after that read but
//      before the RPC won the studio row lock left the practitioner accepted
//      and the booking committed. Both commands now read the flag inside the
//      transaction -- 0222 in the same `for update` that takes the row lock.
//
//   P2 the orphan client. 0225 inserted the new client BEFORE the delegate
//      validated the practitioner, and the delegate RETURNS a refusal rather
//      than raising, so the client row (contact details, possibly SMS consent)
//      committed while no appointment existed. 0225 now refuses before the
//      resolve-or-create.
//
// These are direct-RPC tests on purpose. The race lives between an application
// read and a lock acquisition, so no amount of browser driving can demonstrate
// it: the only way to stand in that window is to call the command with the flag
// already flipped.
// db-integration lane, real migrated schema.

afterAll(async () => {
  await closePool();
});

const tok = () => randomBytes(32).toString("hex");

async function setAdmissionOpen(fett: FettStudio) {
  const r = await asUser(fett.userId, (q) =>
    q(`select * from public.set_new_client_admission_mode($1, $2)`, [
      fett.studioId,
      "open",
    ]),
  );
  expect(r.rows[0]?.outcome).toBe("ok");
}

async function bookAsNewClient(fett: FettStudio, practitionerId: string | null) {
  const email = `g1-race-${randomUUID().slice(0, 8)}@synth.local`;
  const r = await adminQuery(
    `select * from public.create_public_appointment_for_new_client_v2(
       $1, null, $2, $3, null, null, $4, ${FETT_DEMO_SLOT_SQL}, $5, false, null, null, null, $6)`,
    [
      fett.studioId,
      `SYNTH-FETT race ${email.slice(0, 12)}`,
      email,
      fett.services.treatmentId,
      tok(),
      practitionerId,
    ],
  );
  return {
    row: r.rows[0] as {
      result: string;
      appointment_id: string | null;
      client_id: string | null;
      practitioner_id: string | null;
    },
    email,
  };
}

/** Rows this command could have left behind, counted by the email it was given. */
async function residue(studioId: string, email: string) {
  const c = await adminQuery(
    `select count(*)::int as n from public.clients
      where studio_id = $1 and normalized_email = lower(btrim($2))`,
    [studioId, email],
  );
  const a = await adminQuery(
    `select count(*)::int as n from public.appointments where studio_id = $1`,
    [studioId],
  );
  return { clients: c.rows[0].n as number, appointments: a.rows[0].n as number };
}

describe("G1: the assignment switch is honoured at the COMMIT boundary", () => {
  it("refuses a non-null practitioner when the switch is flipped off after the action's check", async () => {
    const fett = await seedFettStudio({ treatingCount: 2, capacity: "live" });
    try {
      await setAdmissionOpen(fett);
      const chosen = fett.practitioners[0]!.practitionerId;

      // The booking is viable right now: this is the state the action validated.
      const ok = await bookAsNewClient(fett, chosen);
      expect(ok.row.result, "baseline booking must succeed, or the refusal below proves nothing").toBe("created");
      expect(ok.row.practitioner_id ?? null).toBe(chosen);

      // THE WINDOW. The operator disables public assignment. In the real race
      // this lands after the TypeScript read and before the RPC takes the row
      // lock; calling now reproduces exactly that ordering.
      await setFettCapacityState(fett.studioId, "ready"); // capacity ON, booking OFF

      const refused = await bookAsNewClient(fett, chosen);
      expect(refused.row.result).toBe("practitioner_assignment_disabled");
      expect(refused.row.appointment_id).toBeNull();
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("refuses at the 0222 command too, which the existing-client path reaches directly", async () => {
    const fett = await seedFettStudio({ treatingCount: 2, capacity: "ready" });
    try {
      const chosen = fett.practitioners[0]!.practitionerId;
      const client = await adminQuery(
        `insert into public.clients (studio_id, name, email)
         values ($1, $2, $3) returning id`,
        [fett.studioId, "SYNTH-FETT existing", `g1-ex-${randomUUID().slice(0, 8)}@synth.local`],
      );
      const r = await adminQuery(
        `select * from public.create_public_appointment_v2(
           $1, $2, $3, ${FETT_DEMO_SLOT_SQL}, $4, null, null, $5)`,
        [fett.studioId, client.rows[0].id, fett.services.treatmentId, tok(), chosen],
      );
      expect(r.rows[0].result).toBe("practitioner_assignment_disabled");
      expect(r.rows[0].appointment_id).toBeNull();
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("LEGACY IS UNTOUCHED: a NULL practitioner still books with the switch off", async () => {
    // The whole point of the gate is that it refuses a CHOICE, never a booking.
    // A legacy studio has both flags false and sends NULL, which must behave
    // exactly as it did before G1.
    const fett = await seedFettStudio({ treatingCount: 2, capacity: "legacy" });
    try {
      await setAdmissionOpen(fett);
      const r = await bookAsNewClient(fett, null);
      expect(r.row.result).toBe("created");
      expect(r.row.appointment_id).not.toBeNull();
    } finally {
      await dropFettStudio(fett);
    }
  });
});

describe("G1: a refused practitioner leaves NO orphan client or consent row", () => {
  // P2. Each case below would previously have committed a `clients` row --
  // name, email, phone and possibly `sms_consent_at` with source
  // 'public_booking' -- while returning an error and creating no appointment.
  it("deactivated practitioner: refused, and no client row is written", async () => {
    const fett = await seedFettStudio({ treatingCount: 2, capacity: "live" });
    try {
      await setAdmissionOpen(fett);
      // A TREATING practitioner, deliberately: practitioners[0] is the OWNER
      // (the fixture builds [owner, ...treating]) and `set_practitioner_active`
      // refuses to modify an owner, so deactivating one is a state the product
      // cannot reach.
      const chosen = fett.practitioners[1]!.practitionerId;
      await adminQuery(`update public.practitioners set active = false where id = $1`, [chosen]);

      const before = await residue(fett.studioId, "unused@synth.local");
      const r = await bookAsNewClient(fett, chosen);
      expect(r.row.result).toBe("invalid_practitioner");
      expect(r.row.appointment_id).toBeNull();
      expect(r.row.client_id).toBeNull();

      const after = await residue(fett.studioId, r.email);
      expect(after.clients, "a refused booking must write NO client row").toBe(0);
      expect(after.appointments).toBe(before.appointments);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("unpinned from the service: refused, and no client row is written", async () => {
    const fett = await seedFettStudio({ treatingCount: 2, capacity: "live" });
    try {
      await setAdmissionOpen(fett);
      // UNPIN IT EXPLICITLY, which is what the finding describes: eligible when
      // the action checked, removed from the list before this transaction won
      // the lock. The fixture seeds eligibility for the treating practitioners
      // as well as the owner, so there is nothing already-off-list to borrow --
      // my first two attempts assumed otherwise. The assertions below are what
      // caught that, and they stay: without them a vacuously-eligible
      // practitioner would make this test pass while proving nothing.
      const unpinned = fett.practitioners[1]!.practitionerId;
      await adminQuery(
        `delete from public.service_practitioners
          where service_id = $1 and practitioner_id = $2`,
        [fett.services.treatmentId, unpinned],
      );
      const pinned = await adminQuery(
        `select exists (select 1 from public.service_practitioners
                         where service_id = $1 and practitioner_id = $2) as on_list,
                exists (select 1 from public.service_practitioners
                         where service_id = $1) as list_exists`,
        [fett.services.treatmentId, unpinned],
      );
      expect(pinned.rows[0].list_exists, "the eligibility rule only applies when a list exists").toBe(true);
      expect(pinned.rows[0].on_list, "this practitioner must NOT be on the list").toBe(false);

      const r = await bookAsNewClient(fett, unpinned);
      expect(r.row.result).toBe("not_eligible");
      expect(r.row.appointment_id).toBeNull();

      const after = await residue(fett.studioId, r.email);
      expect(after.clients, "a refused booking must write NO client row").toBe(0);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("switch off: refused, and no client row is written", async () => {
    const fett = await seedFettStudio({ treatingCount: 2, capacity: "ready" });
    try {
      await setAdmissionOpen(fett);
      const r = await bookAsNewClient(fett, fett.practitioners[0]!.practitionerId);
      expect(r.row.result).toBe("practitioner_assignment_disabled");
      const after = await residue(fett.studioId, r.email);
      expect(after.clients, "a refused booking must write NO client row").toBe(0);
    } finally {
      await dropFettStudio(fett);
    }
  });
});
