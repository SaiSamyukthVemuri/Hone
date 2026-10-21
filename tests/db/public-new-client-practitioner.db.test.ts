import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool } from "./helpers/harness";
import {
  FETT_DEMO_SLOT_SQL,
  dropFettStudio,
  seedFettStudio,
  type FettStudio,
} from "./helpers/fett-fixture";

// Proves 0225 — the NEW-CLIENT public path, which is the RENDERED public
// booking form, honouring a chosen practitioner.
//
// 0222 made create_public_appointment practitioner-aware, but the public page
// reaches that command only on its EXISTING-client branch, and that branch is
// dead UI (PublicBookForm says so, and a browser run confirmed it). The
// reachable form is the new-client form on an OPEN studio, which commits
// through create_public_appointment_for_new_client. 0225 gives that path a v2
// that DELEGATES to create_public_appointment_v2.
//
// So the point of these tests is not to re-prove 0222's guarantees — they are
// inherited by delegation — but to prove the two things delegation could break:
// that the practitioner actually reaches the delegate, and that the ADMISSION
// GATES still refuse above it.
// db-integration lane, real migrated schema (chain 0211-0225).

afterAll(async () => {
  await closePool();
});

const tok = () => randomBytes(32).toString("hex");

async function setAdmission(
  fett: FettStudio,
  mode: "open" | "waitlist" | "closed",
) {
  // THROUGH THE ONE SANCTIONED WRITER, AS THE OWNER. Two guards had to be
  // satisfied here, and neither may be bypassed to make a test pass:
  //
  //   1. a direct UPDATE is refused by `studios_admission_mode_guard`
  //      ("new-client admission has exactly one writer, and this is not it");
  //   2. `set_new_client_admission_mode` is set-returning and answers
  //      `outcome: 'not_authorized'` to a service-role caller — it requires the
  //      authenticated OWNER.
  //
  // Both of my earlier attempts looked like they worked. The direct UPDATE
  // "passed" for 'open' because the column already defaults to 'open', so a
  // no-op never trips the guard; and the setter call "passed" because I
  // discarded its result row and never saw the refusal. The waitlist/closed
  // cases are what exposed each one. Assert the outcome.
  const r = await asUser(fett.userId, (q) =>
    q(`select * from public.set_new_client_admission_mode($1, $2)`, [
      fett.studioId,
      mode,
    ]),
  );
  expect(r.rows[0]?.outcome, `admission setter refused: ${mode}`).toBe("ok");
  expect(r.rows[0]?.mode).toBe(mode);
}

async function bookAsNewClient(
  fett: FettStudio,
  practitionerId: string | null,
  opts: { email?: string; startsAtSql?: string; consentAt?: string } = {},
) {
  const email = opts.email ?? `g1-nc-${randomUUID().slice(0, 8)}@synth.local`;
  const startsAtSql = opts.startsAtSql ?? FETT_DEMO_SLOT_SQL;
  const r = await adminQuery(
    `select * from public.create_public_appointment_for_new_client_v2(
       $1, null, $2, $3, null, $7, $4, ${startsAtSql}, $5, false, null, null, null, $6)`,
    [
      fett.studioId,
      `SYNTH-FETT new client ${email.slice(0, 12)}`,
      email,
      fett.services.treatmentId,
      tok(),
      practitionerId,
      opts.consentAt ?? null,
    ],
  );
  return r.rows[0] as {
    result: string;
    appointment_id: string | null;
    practitioner_id: string | null;
    starts_at: Date | null;
    client_id: string | null;
  };
}

async function countAppointments(studioId: string) {
  return Number(
    (
      await adminQuery(
        `select count(*) n from public.appointments where studio_id = $1`,
        [studioId],
      )
    ).rows[0].n,
  );
}

/** The refused booking's own client row, if the wrapper left one behind.
 *  Counting APPOINTMENTS cannot see an orphan client, which is precisely how
 *  this gap survived: the refusal writes no appointment either way. */
async function clientByEmail(studioId: string, email: string) {
  const r = await adminQuery(
    `select id, phone, sms_consent_at from public.clients
      where studio_id = $1 and lower(email) = lower($2)`,
    [studioId, email],
  );
  return (r.rows[0] as { id: string; phone: string | null; sms_consent_at: Date | null }) ?? null;
}

describe("0225 — the chosen practitioner reaches the delegate", () => {
  it("books a NEW client with the NAMED practitioner, not the owner", async () => {
    const fett = await seedFettStudio({ treatingCount: 2 });
    try {
      await setAdmission(fett, "open");
      const chosen = fett.treating[1].practitionerId;
      const res = await bookAsNewClient(fett, chosen);
      expect(res.result).toBe("created");
      expect(res.practitioner_id).toBe(chosen);
      expect(res.practitioner_id).not.toBe(fett.practitionerId);
      // A new client row really was created by this command.
      expect(res.client_id).toBeTruthy();
      const row = await adminQuery(
        `select a.practitioner_id, c.id as client_id
           from public.appointments a join public.clients c on c.id = a.client_id
          where a.id = $1`,
        [res.appointment_id],
      );
      expect(row.rows[0].practitioner_id).toBe(chosen);
      expect(row.rows[0].client_id).toBe(res.client_id);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("NULL reproduces 0204 exactly — the active owner, on a LEGACY studio", async () => {
    // NARROWED TO ITS ACTUAL SUBJECT, the same way its 0222 sibling was.
    //
    // This asserted owner assignment on a studio `seedFettStudio` had left
    // capacity-LIVE, because `capacity: "live"` is the FIXTURE DEFAULT -- never
    // a product decision, and invisible here because this file never mentions a
    // capacity flag. So it read as "legacy parity" while actually pinning the
    // capacity-ON branch, and it went red the moment fair assignment stopped
    // privileging the owner.
    //
    // The equivalence it legitimately protects is CAPACITY-OFF: pointing the
    // new-client route at v2 must not change what today's studios get, and
    // today every studio has the assignment switch off. That path is unchanged.
    //
    // NOT WEAKENED: the capacity-ON default is asserted far harder than this
    // ever did, by tests/db/public-fair-assignment.db.test.ts, which requires
    // that the owner does NOT receive bookings by privilege.
    const fett = await seedFettStudio({ treatingCount: 2, capacity: "legacy" });
    try {
      await setAdmission(fett, "open");
      const res = await bookAsNewClient(fett, null);
      expect(res.result).toBe("created");
      expect(res.practitioner_id).toBe(fett.practitionerId);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("refuses a practitioner who is not this studio's, active and eligible", async () => {
    const a = await seedFettStudio({ treatingCount: 1 });
    const b = await seedFettStudio({ treatingCount: 1 });
    try {
      await setAdmission(a, "open");
      const cross = await bookAsNewClient(a, b.treating[0].practitionerId);
      expect(cross.result).toBe("invalid_practitioner");
      expect(cross.appointment_id).toBeNull();
      // A REFUSED booking writes NO client row either — the gate and the
      // delegate both run before any insert this command owns.
      expect(await countAppointments(a.studioId)).toBe(0);
    } finally {
      await dropFettStudio(a);
      await dropFettStudio(b);
    }
  });
});

describe("0225 — a practitioner choice cannot bypass an ADMISSION gate", () => {
  // The reason delegation was the right shape: WAITLIST and CLOSED are decided
  // in the body carried verbatim from 0204, ABOVE the delegate. If a choice
  // could carry a booking past them, this migration would have turned a product
  // gate into a bypass.
  for (const mode of ["waitlist", "closed"] as const) {
    it(`${mode}: refused with a practitioner chosen, and nothing is written`, async () => {
      const fett = await seedFettStudio({ treatingCount: 2 });
      try {
        await setAdmission(fett, mode);
        const res = await bookAsNewClient(fett, fett.treating[0].practitionerId);
        expect(res.result).not.toBe("created");
        expect(res.appointment_id).toBeNull();
        expect(await countAppointments(fett.studioId)).toBe(0);

        // CONTROL: the same call on an OPEN studio succeeds, so the refusal is
        // the gate and not something broken about the call itself.
        await setAdmission(fett, "open");
        const ok = await bookAsNewClient(fett, fett.treating[0].practitionerId);
        expect(ok.result).toBe("created");
      } finally {
        await dropFettStudio(fett);
      }
    });
  }
});

describe("0225 — capacity decides parallelism on the new-client path too", () => {
  it("LIVE: two NEW clients take the SAME instant with DIFFERENT practitioners", async () => {
    const fett = await seedFettStudio({ treatingCount: 2 });
    try {
      await setAdmission(fett, "open");
      const first = await bookAsNewClient(fett, fett.treating[0].practitionerId);
      const second = await bookAsNewClient(fett, fett.treating[1].practitionerId);
      expect(first.result).toBe("created");
      expect(second.result).toBe("created");
      expect(second.starts_at!.getTime()).toBe(first.starts_at!.getTime());
      expect(second.practitioner_id).not.toBe(first.practitioner_id);
      expect(await countAppointments(fett.studioId)).toBe(2);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("the SAME practitioner is REFUSED for that instant", async () => {
    // THE CONTROL. Scoping is only correct if the practitioner stays protected
    // against themselves on this path as well.
    const fett = await seedFettStudio({ treatingCount: 2 });
    try {
      await setAdmission(fett, "open");
      const p1 = fett.treating[0].practitionerId;
      const first = await bookAsNewClient(fett, p1);
      expect(first.result).toBe("created");
      // A GENUINELY NEW email, and SMS consent offered with it, so the
      // wrapper would have to create a client row to proceed.
      const orphanEmail = `g1-orphan-${randomUUID().slice(0, 8)}@synth.local`;
      const second = await bookAsNewClient(fett, p1, {
        email: orphanEmail,
        consentAt: "2026-01-01T00:00:00Z",
      });
      expect(second.result).not.toBe("created");
      expect(second.appointment_id).toBeNull();
      expect(await countAppointments(fett.studioId)).toBe(1);

      // P3 — NO ORPHAN. Counting appointments is not enough and never was: the
      // refusal writes no appointment on either side of the fix, so the only
      // way to see the defect is to look for the CLIENT the refused attempt
      // would have created. Before 0225's scoped-slot pre-check this committed
      // the row, its contact details and this SMS consent, with no appointment.
      expect(second.client_id).toBeNull();
      expect(await clientByEmail(fett.studioId, orphanEmail)).toBeNull();
    } finally {
      await dropFettStudio(fett);
    }
  });
});
