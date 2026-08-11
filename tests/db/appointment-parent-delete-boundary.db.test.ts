// APPOINTMENT BOUNDARY B4 — behavioural suite for 0173 GROUP 5 (L23).
//
// This closure was briefly drafted as a companion migration 0174 and withdrawn:
// the canonical appointment-DML program reserves 0174 for B5 (attribution +
// audit integrity), 0175 for B6, 0176 for B7 and 0177 for B8. B4 ships ONE
// migration, 0173, whose GROUP 5 carries L23.
//
// L23: 0172 closed DIRECT DML on `appointments`, but a FOREIGN-KEY REFERENTIAL
// ACTION runs as the CONSTRAINT's owner and consults neither the table ACL nor
// RLS. Deleting a PARENT row therefore still wrote `appointments` for a caller
// holding no privilege on it at all:
//
//   member deletes a `services` row       -> appointments.service_id      = NULL
//   owner  deletes a `practitioners` row  -> appointments.practitioner_id = NULL
//
// silently: no audit row, no updated_at touch, no outbox enqueue.
//
// WHY THIS FILE CARRIES A TWO-WAY SELF-TEST
//
// Every assertion here is of the form "the browser role cannot do X". That
// shape passes for the WRONG reason with depressing ease — if the seeded rows
// were invisible, if the delete matched nothing, or if the local stack simply
// never granted the privilege in the first place, "0 rows deleted" and
// "permission denied" both look like success.
//
// That is not hypothetical. The Supabase CLI is PINNED to 2.102.0 in
// .github/workflows/ci.yml precisely because a later CLI ships a `postgres`-role
// `pg_default_acl` that never grants anon/authenticated SELECT/INSERT/UPDATE/
// DELETE on migration-created tables at all. On such a stack this entire file
// would pass green while proving nothing whatsoever about GROUP 5.
//
// So the central test RESTORES the pre-GROUP-5 world inside a rolled-back
// transaction — re-granting DELETE and recreating the FOR ALL policy — and
// proves the appointment lineage really IS nulled that way. Only then is the
// post-GROUP-5 refusal evidence of anything.

import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  adminQuery,
  asUser,
  closePool,
  resolveLocalDbUrl,
  seedStudio,
  seedMember,
  type SeededStudio,
} from "./helpers/harness";

afterAll(async () => {
  await closePool();
});

// A transaction we control from the FIRST statement, so privileged setup
// (GRANT / CREATE POLICY) can precede `set local role`. Always rolled back:
// nothing this helper does survives the test.
async function inRolledBackTx<T>(
  fn: (q: (text: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: resolveLocalDbUrl() });
  await client.connect();
  try {
    await client.query("begin");
    return await fn((text, params = []) => client.query(text, params));
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function seedServiceAndAppointment(
  studio: SeededStudio,
): Promise<{ serviceId: string; appointmentId: string }> {
  const serviceId = randomUUID();
  const appointmentId = randomUUID();
  await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, active)
     values ($1, $2, 'L23 service', 60, true)`,
    [serviceId, studio.studioId],
  );
  await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id,
        starts_at, ends_at, duration_minutes, status)
     values ($1, $2, $3, $4, $5,
             now() + interval '30 days', now() + interval '30 days' + interval '60 minutes',
             60, 'confirmed')`,
    [appointmentId, studio.studioId, studio.practitionerId, studio.clientId, serviceId],
  );
  return { serviceId, appointmentId };
}

// ---------------------------------------------------------------------------

describe("0173 GROUP 5 — the L23 hazard is real (two-way self-test)", () => {
  it("RESTORING the pre-GROUP-5 grant + policy really does null appointments.service_id", async () => {
    // This is the control that makes every other test in this file meaningful.
    // If this ever stops nulling the column, the refusals below are proving
    // nothing and this suite must be re-examined before it is trusted.
    const studio = await seedStudio("l23-control");
    const { serviceId, appointmentId } = await seedServiceAndAppointment(studio);

    const observed = await inRolledBackTx(async (q) => {
      // Put the world back exactly as it was before GROUP 5.
      await q(`grant delete on table public.services to authenticated`);
      await q(`drop policy if exists "services_member_all" on public.services`);
      await q(
        `create policy "services_member_all" on public.services for all
           using (public.is_studio_member(studio_id))
           with check (public.is_studio_member(studio_id))`,
      );

      await q(`set local role authenticated`);
      await q(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: studio.userId, role: "authenticated" }),
      ]);

      const del = await q(`delete from public.services where id = $1`, [serviceId]);
      const read = await q(
        `select service_id from public.appointments where id = $1`,
        [appointmentId],
      );
      return {
        deleted: del.rowCount,
        serviceId: read.rows[0]?.service_id ?? null,
      };
    });

    expect(observed.deleted, "the member's DELETE must succeed pre-GROUP-5").toBe(1);
    expect(
      observed.serviceId,
      "the FK referential action must null the lineage pre-GROUP-5",
    ).toBeNull();

    // And the rollback really did undo it.
    const after = await adminQuery(
      `select service_id from public.appointments where id = $1`,
      [appointmentId],
    );
    expect(after.rows[0].service_id).toBe(serviceId);
  });
});

describe("0173 GROUP 5 — the privilege layer", () => {
  // 0178 SUPERSEDED THE PRACTITIONER HALF OF THIS BLOCK.
  //
  // 0173's claim was that its GROUP 5 revoke was SURGICAL — DELETE only, with
  // SELECT/INSERT/UPDATE deliberately untouched on BOTH tables. That is still
  // exactly true of `services`, which 0178 does not touch, so it keeps the
  // original assertions below.
  //
  // `practitioners` moved on: 0178 reduced it to SELECT-only for every runtime
  // role, because the recon census found the table still carried Supabase's
  // default ALL grant (INSERT/UPDATE/TRUNCATE/REFERENCES/TRIGGER) with RLS as
  // the only gate — and RLS never governed the last three. Its expectations
  // therefore live in tests/db/practitioner-identity-boundary.db.test.ts, which
  // asserts the stronger posture directly — SELECT-only, MAINTAIN included, with
  // zero column-level write authority. Re-asserting "INSERT/UPDATE are
  // untouched" here would pin a posture the product deliberately left behind,
  // and restating the DELETE half would duplicate that suite for no evidence.
  for (const table of ["services"] as const) {
    it(`${table}: DELETE is revoked from anon and authenticated`, async () => {
      const r = await adminQuery(
        `select r.rolname::text role,
                has_table_privilege(r.rolname, $1, 'DELETE') del
           from (values ('anon'),('authenticated')) r(rolname)`,
        [`public.${table}`],
      );
      for (const row of r.rows) {
        expect(row.del, `${row.role} must NOT hold DELETE on ${table}`).toBe(false);
      }
    });

    it(`${table}: SELECT / INSERT / UPDATE are untouched for authenticated`, async () => {
      // The revoke must be surgical. If this ever goes false, GROUP 5 has
      // taken the settings pages down with it.
      const r = await adminQuery(
        `select has_table_privilege('authenticated', $1, 'SELECT') sel,
                has_table_privilege('authenticated', $1, 'INSERT') ins,
                has_table_privilege('authenticated', $1, 'UPDATE') upd`,
        [`public.${table}`],
      );
      expect(r.rows[0].sel).toBe(true);
      expect(r.rows[0].ins).toBe(true);
      expect(r.rows[0].upd).toBe(true);
    });

    it(`${table}: service_role RETAINS DELETE for maintenance`, async () => {
      const r = await adminQuery(
        `select has_table_privilege('service_role', $1, 'DELETE') del`,
        [`public.${table}`],
      );
      expect(r.rows[0].del, "service_role maintenance must survive").toBe(true);
    });
  }

});

describe("0173 GROUP 5 — the policy layer", () => {
  it("no DELETE-capable policy remains on services or practitioners", async () => {
    const r = await adminQuery(
      `select tablename::text tbl, policyname::text pol, cmd::text
         from pg_policies
        where schemaname = 'public'
          and tablename in ('services','practitioners')
          and cmd in ('DELETE','ALL')`,
    );
    expect(
      r.rows,
      `no policy may permit DELETE, found: ${JSON.stringify(r.rows)}`,
    ).toHaveLength(0);
  });

  it("services keeps exactly select/insert/update, all TO authenticated", async () => {
    const r = await adminQuery(
      `select cmd::text, roles::text
         from pg_policies where schemaname='public' and tablename='services'
        order by cmd`,
    );
    expect(r.rows.map((x) => x.cmd).sort()).toEqual([
      "INSERT",
      "SELECT",
      "UPDATE",
    ]);
    for (const row of r.rows) {
      expect(row.roles, "no policy may apply to PUBLIC/anon").toBe(
        "{authenticated}",
      );
    }
  });

  it("anon reads zero services — the TO authenticated narrowing is inert", async () => {
    // The narrowing only matters if anon could read services before. It could
    // not: is_studio_member() resolves auth.uid() to null for anon.
    const studio = await seedStudio("l23-anon");
    await seedServiceAndAppointment(studio);
    const visible = await inRolledBackTx(async (q) => {
      await q(`set local role anon`);
      const r = await q(`select count(*)::int n from public.services`);
      return r.rows[0].n as number;
    });
    expect(visible).toBe(0);
  });
});

describe("0173 GROUP 5 — appointment lineage is no longer reachable through a parent delete", () => {
  it("a MEMBER can no longer null appointments.service_id", async () => {
    const studio = await seedStudio("l23-service");
    const member = await seedMember(studio, "l23-service-m");
    const { serviceId, appointmentId } = await seedServiceAndAppointment(studio);

    const failure = await asUser(member.userId, async (q) => {
      try {
        await q(`delete from public.services where id = $1`, [serviceId]);
        return null;
      } catch (e) {
        return e as { code?: string; message?: string };
      }
    });

    expect(failure, "the member's DELETE must fail").not.toBeNull();
    // 42501 is shared by the privilege and RLS layers; the message is the only
    // discriminator, and GROUP 5's enforcement is the PRIVILEGE.
    expect(failure?.code).toBe("42501");
    expect(failure?.message ?? "").toMatch(/permission denied for table services/i);

    const after = await adminQuery(
      `select service_id from public.appointments where id = $1`,
      [appointmentId],
    );
    expect(after.rows[0].service_id, "lineage must be intact").toBe(serviceId);
  });

  it("an OWNER can no longer null appointments.practitioner_id", async () => {
    const studio = await seedStudio("l23-practitioner");
    const victim = await seedMember(studio, "l23-victim");
    const appointmentId = randomUUID();
    await adminQuery(
      `insert into public.appointments
         (id, studio_id, practitioner_id, client_id, service_id,
          starts_at, ends_at, duration_minutes, status)
       values ($1, $2, $3, $4, null,
               now() + interval '31 days', now() + interval '31 days' + interval '60 minutes',
               60, 'confirmed')`,
      [appointmentId, studio.studioId, victim.practitionerId, studio.clientId],
    );

    // studio.userId is the OWNER — the role the old policy authorized.
    const failure = await asUser(studio.userId, async (q) => {
      try {
        await q(`delete from public.practitioners where id = $1`, [
          victim.practitionerId,
        ]);
        return null;
      } catch (e) {
        return e as { code?: string; message?: string };
      }
    });

    expect(failure, "the owner's DELETE must fail").not.toBeNull();
    expect(failure?.code).toBe("42501");
    expect(failure?.message ?? "").toMatch(
      /permission denied for table practitioners/i,
    );

    const after = await adminQuery(
      `select practitioner_id from public.appointments where id = $1`,
      [appointmentId],
    );
    expect(after.rows[0].practitioner_id, "lineage must be intact").toBe(
      victim.practitionerId,
    );
  });

  it("no FK reaches appointments through an ON UPDATE action either", async () => {
    // L23 is an ON DELETE story, but ON UPDATE is the same mechanism: a
    // referential action runs as the constraint's owner and consults neither
    // the ACL nor RLS. `authenticated` still holds UPDATE on services and
    // practitioners (GROUP 5 deliberately kept it — that is how the settings pages
    // work), so an ON UPDATE CASCADE on either parent key would reopen exactly
    // the hazard GROUP 5 just closed, by a different verb. Every FK is currently
    // NO ACTION; this pins it.
    const r = await adminQuery(
      `select c.conname, c.confupdtype::text
         from pg_constraint c
        where c.contype = 'f'
          and c.confrelid in ('public.services'::regclass,
                              'public.practitioners'::regclass,
                              'public.clients'::regclass,
                              'public.studios'::regclass)
          and c.confupdtype <> 'a'`,
    );
    expect(
      r.rows,
      `every FK on an appointment parent must be ON UPDATE NO ACTION, found: ${JSON.stringify(r.rows)}`,
    ).toHaveLength(0);
  });

  it("the two CASCADE parents remain default-denied (unchanged by GROUP 5)", async () => {
    // clients + studios were already denied at the RLS layer by 0087 and 0001;
    // GROUP 5 does not touch them. Pinned so a DELETE policy appearing on either
    // fails CI rather than silently widening the edge to "the appointment
    // disappears".
    const r = await adminQuery(
      `select tablename::text tbl, policyname::text pol
         from pg_policies
        where schemaname='public' and tablename in ('clients','studios')
          and cmd in ('DELETE','ALL')`,
    );
    expect(r.rows).toHaveLength(0);
  });
});

describe("0173 GROUP 5 — the product workflows it must not break", () => {
  it("a member can still read, create and UPDATE a service", async () => {
    const studio = await seedStudio("l23-crud");
    const member = await seedMember(studio, "l23-crud-m");
    const serviceId = randomUUID();

    await asUser(member.userId, async (q) => {
      await q(
        `insert into public.services (id, studio_id, name, default_duration_minutes, active)
         values ($1, $2, 'Member created', 45, true)`,
        [serviceId, studio.studioId],
      );
      const read = await q(`select name from public.services where id = $1`, [
        serviceId,
      ]);
      expect(read.rows[0].name).toBe("Member created");
      await q(`update public.services set name = 'Renamed' where id = $1`, [
        serviceId,
      ]);
    });

    const after = await adminQuery(
      `select name from public.services where id = $1`,
      [serviceId],
    );
    expect(after.rows[0].name).toBe("Renamed");
  });

  it("DEACTIVATION — the real product workflow — still works for a member", async () => {
    const studio = await seedStudio("l23-deactivate");
    const { serviceId } = await seedServiceAndAppointment(studio);

    await asUser(studio.userId, async (q) => {
      await q(`update public.services set active = false where id = $1`, [
        serviceId,
      ]);
    });

    const after = await adminQuery(
      `select active from public.services where id = $1`,
      [serviceId],
    );
    expect(after.rows[0].active, "deactivation is how services retire").toBe(
      false,
    );
  });

  it("an owner can still deactivate a practitioner — now via the governed command", async () => {
    // 0173's point was that DEACTIVATION, not deletion, is how a practitioner
    // retires — and that is unchanged. What changed in 0178 is the ROUTE: the
    // direct authenticated UPDATE this used to perform is now a privilege
    // error, and the capability lives in `set_practitioner_active_locked`,
    // which is owner-gated per studio and multi-owner safe.
    //
    // Both halves are asserted, because proving only the new path would leave
    // the old door open and proving only the closure would look like a
    // regression.
    const studio = await seedStudio("l23-deactivate-p");
    const member = await seedMember(studio, "l23-deactivate-pm");

    await expect(
      asUser(studio.userId, (q) =>
        q(`update public.practitioners set active = false where id = $1`, [
          member.practitionerId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const code = await adminQuery(
      `select public.set_practitioner_active_locked($1,$2,$3,false) code`,
      [studio.studioId, studio.practitionerId, member.practitionerId],
    );
    expect(code.rows[0].code).toBe("ok");

    const after = await adminQuery(
      `select active from public.practitioners where id = $1`,
      [member.practitionerId],
    );
    expect(after.rows[0].active).toBe(false);
  });

  it("service_role can still hard-delete a service (maintenance is retained)", async () => {
    const studio = await seedStudio("l23-svc-role");
    const serviceId = randomUUID();
    await adminQuery(
      `insert into public.services (id, studio_id, name, default_duration_minutes, active)
       values ($1, $2, 'Maintenance target', 30, true)`,
      [serviceId, studio.studioId],
    );

    const deleted = await inRolledBackTx(async (q) => {
      await q(`set local role service_role`);
      const r = await q(`delete from public.services where id = $1`, [serviceId]);
      return r.rowCount;
    });
    expect(deleted, "service_role maintenance must still work").toBe(1);
  });
});

describe("0173 GROUP 5 — 0172's boundary is not disturbed", () => {
  it("direct appointment DML remains denied for both browser roles", async () => {
    const studio = await seedStudio("l23-appt-dml");
    const { appointmentId } = await seedServiceAndAppointment(studio);

    const failure = await asUser(studio.userId, async (q) => {
      try {
        await q(
          `update public.appointments set notes = 'direct' where id = $1`,
          [appointmentId],
        );
        return null;
      } catch (e) {
        return e as { code?: string; message?: string };
      }
    });
    expect(failure, "direct UPDATE must still be refused").not.toBeNull();
    expect(failure?.code).toBe("42501");
    expect(failure?.message ?? "").toMatch(
      /permission denied for table appointments/i,
    );
  });
});
