import { afterAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedHistoricalAppointmentAudit,
} from "./helpers/harness";
import {
  detectFettCapabilities,
  dropFettStudio,
  seedFettReceptionist,
  seedFettStudio,
} from "./helpers/fett-fixture";

// Proves the Fett rehearsal fixture (#824) instead of asserting it:
//  (1) the LA timezone is REAL, not the 'America/Toronto' column default;
//  (2) owner + five treating practitioners, with the owner excluded from
//      `treating` (the count the rehearsal script depends on);
//  (3) the receptionist limb is genuinely OPTIONAL — it returns null on this
//      chain WITHOUT throwing, so the rehearsal cannot be gated by #838/#850;
//  (4) the capability probe is NOT VACUOUS — a false answer is derived from a
//      real constraint, not from a query that matched nothing;
//  (5) teardown leaves zero residue even AFTER an appointment_audit row makes
//      studios deletion RESTRICT-blocked, with a control proving the purge is
//      load-bearing rather than decorative.
// db-integration lane, real migrated schema.

afterAll(async () => {
  await closePool();
});

async function count(sql: string, params: unknown[]): Promise<number> {
  const r = await adminQuery(sql, params);
  return Number(r.rows[0].n);
}

describe("Fett rehearsal fixture — shape", () => {
  it("seeds an LA studio with owner + five treating practitioners", async () => {
    const fett = await seedFettStudio();
    try {
      // (1) The load-bearing timezone assertion. The studios.timezone DEFAULT
      // is 'America/Toronto' (0010_booking_v1.sql:20), so this would pass
      // vacuously if the fixture simply omitted the column — assert the value
      // AND that it is not the default.
      const tz = await adminQuery(
        `select timezone from public.studios where id = $1`,
        [fett.studioId],
      );
      expect(tz.rows[0].timezone).toBe("America/Los_Angeles");
      expect(tz.rows[0].timezone).not.toBe("America/Toronto");

      // (2) Six practitioner rows: one owner, five treating.
      expect(
        await count(
          `select count(*) n from public.practitioners where studio_id = $1`,
          [fett.studioId],
        ),
      ).toBe(6);
      expect(
        await count(
          `select count(*) n from public.practitioners
            where studio_id = $1 and role = 'owner'`,
          [fett.studioId],
        ),
      ).toBe(1);
      expect(
        await count(
          `select count(*) n from public.practitioners
            where studio_id = $1 and role = 'practitioner'`,
          [fett.studioId],
        ),
      ).toBe(5);
      // The owner must NOT appear in `treating` — a rehearsal booking "any
      // available practitioner" would otherwise double-count the owner.
      expect(fett.treating).toHaveLength(5);
      expect(fett.treating.map((p) => p.practitionerId)).not.toContain(
        fett.practitionerId,
      );
      expect(fett.practitioners).toHaveLength(6);

      // Recognizably synthetic — nothing shares an identifier space with a
      // real tenant.
      expect(fett.name.startsWith("SYNTH-FETT")).toBe(true);
      for (const p of fett.practitioners) {
        expect(p.email.endsWith("@synth.local")).toBe(true);
      }

      // Two electrolysis services, durations inside services_duration_check.
      const svc = await adminQuery(
        `select count(*)::text n,
                min(default_duration_minutes)::text min,
                max(default_duration_minutes)::text max
           from public.services where studio_id = $1 and active`,
        [fett.studioId],
      );
      expect(svc.rows[0].n).toBe("2");
      expect(Number(svc.rows[0].min)).toBeGreaterThanOrEqual(5);
      expect(Number(svc.rows[0].max)).toBeLessThanOrEqual(480);

      // Mon-Fri studio-wide availability (practitioner_id NULL).
      expect(
        await count(
          `select count(*) n from public.studio_availability_default
            where studio_id = $1 and practitioner_id is null and is_open`,
          [fett.studioId],
        ),
      ).toBe(5);
    } finally {
      await dropFettStudio(fett);
    }
  });

  it("honours treatingCount so the fixture is not pinned to five", async () => {
    const fett = await seedFettStudio({ treatingCount: 2, days: [1] });
    try {
      expect(fett.treating).toHaveLength(2);
      expect(
        await count(
          `select count(*) n from public.practitioners where studio_id = $1`,
          [fett.studioId],
        ),
      ).toBe(3);
      expect(
        await count(
          `select count(*) n from public.studio_availability_default
            where studio_id = $1 and is_open`,
          [fett.studioId],
        ),
      ).toBe(1);
    } finally {
      await dropFettStudio(fett);
    }
  });
});

describe("Fett rehearsal fixture — the receptionist limb is optional", () => {
  it("the capability probe is not vacuous: 'false' comes from a real constraint", async () => {
    // (4) THE CONTROL. detectFettCapabilities answers `false` by finding a
    // constraint that excludes 'receptionist'. If its query matched NOTHING,
    // `.some()` would also be false — indistinguishable from a real exclusion.
    // So prove the constraint it reads actually exists and is the right one.
    const role = await adminQuery(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public'
          and t.relname = 'practitioners'
          and c.contype = 'c'
          and pg_get_constraintdef(c.oid) ilike '%role%'`,
    );
    expect(role.rows.length).toBeGreaterThanOrEqual(1);
    const defs = role.rows.map((r) => r.def.toLowerCase()).join(" | ");
    // The constraint genuinely enumerates the two live roles...
    expect(defs).toContain("owner");
    expect(defs).toContain("practitioner");
    // ...and genuinely omits the third. THIS is what makes `false` meaningful.
    expect(defs).not.toContain("receptionist");

    // Same vacuity check for the command probe: the pg_proc shape it uses must
    // be able to find a function that DOES exist on this chain.
    const known = await adminQuery(
      `select count(*)::text as n
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'create_public_appointment'`,
    );
    expect(known.rows[0].n).not.toBe("0");

    const caps = await detectFettCapabilities();
    expect(caps.receptionistRole).toBe(false);
    expect(caps.receptionistCommand).toBe(false);
    expect(caps.receptionist).toBe(false);
  });

  it("returns null rather than throwing when the chain cannot represent one", async () => {
    // (3) The rehearsal must never die because #838/#850 are unmerged.
    const fett = await seedFettStudio();
    try {
      expect(fett.capabilities.receptionist).toBe(false);
      expect(fett.receptionist).toBeNull();
      // Called directly, it is a no-op returning null — not a throw.
      await expect(seedFettReceptionist(fett.studioId)).resolves.toBeNull();
      // And it wrote nothing: still exactly the six seeded practitioners.
      expect(
        await count(
          `select count(*) n from public.practitioners where studio_id = $1`,
          [fett.studioId],
        ),
      ).toBe(6);
    } finally {
      await dropFettStudio(fett);
    }
  });
});

describe("Fett rehearsal fixture — teardown", () => {
  it("leaves zero residue even when appointment_audit blocks studio deletion", async () => {
    // (5) appointment_audit.studio_id is ON DELETE RESTRICT (0174) with no
    // runtime path to remove the trail, so a naive teardown fails exactly
    // once a rehearsal has booked anything. Force that state, then prove the
    // teardown still clears it.
    const fett = await seedFettStudio({ treatingCount: 1, days: [1] });
    const userIds = fett.practitioners.map((p) => p.userId);

    const client = await adminQuery(
      `select id from public.clients where studio_id = $1 limit 1`,
      [fett.studioId],
    );
    const apptId = (
      await adminQuery(
        `insert into public.appointments
           (studio_id, practitioner_id, client_id, service_id,
            starts_at, ends_at, duration_minutes, status)
         values ($1, $2, $3, $4,
                 now() + interval '10 days', now() + interval '10 days 1 hour',
                 60, 'confirmed')
         returning id`,
        [
          fett.studioId,
          fett.practitionerId,
          client.rows[0].id,
          fett.services.treatmentId,
        ],
      )
    ).rows[0].id;
    expect(apptId).toBeTruthy();

    // A raw appointments INSERT writes NO audit row — the trail is written by
    // the command functions (0170:906, 0133:126, 0146:323, ...), not by a
    // trigger on the table. Measured: without this step the RESTRICT state
    // below never arises and the test proves nothing. Seed it through the
    // harness fixture that exists for exactly this.
    await seedHistoricalAppointmentAudit({
      appointmentId: apptId,
      actorType: "practitioner",
      actorId: fett.practitionerId,
      action: "created",
      createdAtSql: "now()",
      studioId: fett.studioId,
    });

    // Ground truth: an audit trail now exists.
    expect(
      await count(
        `select count(*) n from public.appointment_audit where studio_id = $1`,
        [fett.studioId],
      ),
    ).toBeGreaterThan(0);

    // THE CONTROL that makes this test load-bearing. If a bare studios delete
    // succeeded here, dropFettStudio's purge would be decorative and deleting
    // it from the helper would not fail anything. Prove the RESTRICT bites.
    await expect(
      adminQuery(`delete from public.studios where id = $1`, [fett.studioId]),
    ).rejects.toThrow();
    expect(
      await count(`select count(*) n from public.studios where id = $1`, [
        fett.studioId,
      ]),
    ).toBe(1);

    await dropFettStudio(fett);

    expect(
      await count(`select count(*) n from public.studios where id = $1`, [
        fett.studioId,
      ]),
    ).toBe(0);
    expect(
      await count(
        `select count(*) n from public.practitioners where studio_id = $1`,
        [fett.studioId],
      ),
    ).toBe(0);
    expect(
      await count(`select count(*) n from public.clients where studio_id = $1`, [
        fett.studioId,
      ]),
    ).toBe(0);
    expect(
      await count(
        `select count(*) n from public.appointment_audit where studio_id = $1`,
        [fett.studioId],
      ),
    ).toBe(0);
    for (const userId of userIds) {
      expect(
        await count(`select count(*) n from auth.users where id = $1`, [userId]),
      ).toBe(0);
    }
  });
});
