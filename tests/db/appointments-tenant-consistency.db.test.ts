import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asRole,
  closePool,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// Migration 0151: appointments tenant-consistency composite FKs, proven on the
// REAL migrated local database (0001..0151 applied via `supabase db reset --local`).
// An appointment may never carry studio_id=A while pointing at a client / service /
// practitioner from studio B. Migration 0094 hardened the clinical/import child
// tables the same way but OMITTED appointments; 0151 closes that gap.
//
// adminQuery (postgres, bypassrls) is used for the FK-violation cases to prove the
// composite FK holds even for the service-role/admin path (FKs are enforced
// regardless of BYPASSRLS — the strongest guarantee); a userQuery pair shows the
// authenticated app path; an RLS read is the confidentiality regression.

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

let A: SeededStudio;
let B: SeededStudio;
let serviceA: string;
let serviceB: string;

// distinct far-future slots so the per-studio double-booking exclusion never
// collides and starts_at > now() guards always hold.
let slotDay = 0;
function nextSlot(): { start: string; end: string } {
  slotDay += 1;
  const day = String(slotDay).padStart(2, "0");
  return { start: `2032-04-${day}T10:00:00Z`, end: `2032-04-${day}T11:00:00Z` };
}

// Direct appointment insert (bypasses the app RPC so we can attempt the forged
// cross-studio references the app layer would refuse). Column shape mirrors the
// capacity DB tests; the 0029 snapshot trigger fills buffer_minutes_snapshot /
// blocked_ends_at.
async function insertAppt(opts: {
  studioId: string;
  clientId: string;
  serviceId?: string | null;
  practitionerId?: string | null;
}): Promise<string> {
  const { start, end } = nextSlot();
  const r = await adminQuery(
    `insert into public.appointments
       (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
        duration_minutes, status, cancellation_token_hash)
     values (gen_random_uuid(), $1, $2, $3, $4, $5::timestamptz, $6::timestamptz,
             60, 'confirmed', $7)
     returning id`,
    [opts.studioId, opts.practitionerId ?? null, opts.clientId, opts.serviceId ?? null, start, end, hash64()],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  A = await seedStudio("appt-tc-A");
  B = await seedStudio("appt-tc-B");
  for (const s of [A, B]) {
    await adminQuery(`update public.studios set buffer_minutes = 0 where id = $1`, [s.studioId]);
  }
  const sa = await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1,$2,'Service A',60,0,true) returning id`,
    [randomUUID(), A.studioId],
  );
  serviceA = sa.rows[0].id as string;
  const sb = await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
     values ($1,$2,'Service B',60,0,true) returning id`,
    [randomUUID(), B.studioId],
  );
  serviceB = sb.rows[0].id as string;
});

afterAll(async () => {
  await closePool();
});

describe("0151: same-studio appointment creation succeeds", () => {
  it("(1) accepts an appointment whose client + service + practitioner are all same-studio", async () => {
    const id = await insertAppt({
      studioId: A.studioId,
      clientId: A.clientId,
      serviceId: serviceA,
      practitionerId: A.practitionerId,
    });
    const r = await adminQuery(
      `select studio_id, client_id, service_id, practitioner_id from public.appointments where id=$1`,
      [id],
    );
    expect(r.rows[0].studio_id).toBe(A.studioId);
    expect(r.rows[0].client_id).toBe(A.clientId);
    expect(r.rows[0].service_id).toBe(serviceA);
    expect(r.rows[0].practitioner_id).toBe(A.practitionerId);
  });
});

describe("0151: cross-studio references are rejected (23503)", () => {
  const isFk = (e: unknown) => (e as { code?: string })?.code === "23503";

  it("(2) Alpha appointment + Beta client -> rejected", async () => {
    await expect(insertAppt({ studioId: A.studioId, clientId: B.clientId })).rejects.toMatchObject({ code: "23503" });
  });
  it("(3) Alpha appointment + Beta service -> rejected", async () => {
    await expect(
      insertAppt({ studioId: A.studioId, clientId: A.clientId, serviceId: serviceB }),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("(4) Alpha appointment + Beta practitioner -> rejected", async () => {
    await expect(
      insertAppt({ studioId: A.studioId, clientId: A.clientId, practitionerId: B.practitionerId }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("(5) symmetric: Beta appointment + Alpha client / service / practitioner all rejected", async () => {
    await expect(insertAppt({ studioId: B.studioId, clientId: A.clientId })).rejects.toMatchObject({ code: "23503" });
    await expect(
      insertAppt({ studioId: B.studioId, clientId: B.clientId, serviceId: serviceA }),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      insertAppt({ studioId: B.studioId, clientId: B.clientId, practitionerId: A.practitionerId }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  // -------------------------------------------------------------------------
  // T4.1 — the FK is defence in depth for the role that ACTUALLY writes.
  //
  // This used to be proven on the authenticated app path ("RLS WITH CHECK
  // passes, the FK still fails"). Migration 0172 removed that path: an
  // authenticated INSERT is now refused at the privilege layer and never
  // reaches the FK, so the old test could no longer prove what it claimed.
  //
  // Flipping its expected SQLSTATE from 23503 to 42501 would have DESTROYED the
  // FK coverage — a privilege refusal proves nothing about the constraint. The
  // proof is therefore re-pointed at `service_role`, which is the role the
  // command layer actually writes as, and which 0172 deliberately leaves
  // untouched. That is a STRONGER guarantee than the old one: service_role
  // carries BYPASSRLS, so nothing but the constraint itself can be stopping it.
  // -------------------------------------------------------------------------
  it("(T4.1) service_role — the role the command layer writes as — is still blocked by the composite FK", async () => {
    const { start, end } = nextSlot();
    await expect(
      asRole("service_role", (q) =>
        q(
          `insert into public.appointments
             (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
              duration_minutes, status, cancellation_token_hash)
           values (gen_random_uuid(), $1, null, $2, null, $3::timestamptz, $4::timestamptz,
                   60, 'confirmed', $5)`,
          [A.studioId, B.clientId, start, end, hash64()],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    void isFk;
  });

  it("(T4.1b) service_role CAN insert the same-studio row — so 23503 above is the FK, not a lost privilege", async () => {
    // Two-way self-test. Without it, a service_role revoke would turn the test
    // above green for entirely the wrong reason (42501 is not 23503, but a
    // future widening of the expectation would hide it).
    const { start, end } = nextSlot();
    await expect(
      asRole("service_role", (q) =>
        q(
          `insert into public.appointments
             (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
              duration_minutes, status, cancellation_token_hash)
           values (gen_random_uuid(), $1, null, $2, null, $3::timestamptz, $4::timestamptz,
                   60, 'confirmed', $5)`,
          [A.studioId, A.clientId, start, end, hash64()],
        ),
      ),
    ).resolves.toBeDefined();
  });

  it("(T4.5) an authenticated Alpha owner can no longer insert AT ALL — refused by privilege, before the FK", async () => {
    // The case 0172 closes. Before it, RLS WITH CHECK is_studio_member(A)
    // PASSED here (own studio_id) and only the composite FK stopped the forged
    // Beta client_id. Now the statement never reaches either.
    //
    // 42501 is asserted with its MESSAGE, because an RLS WITH CHECK violation
    // raises the very same SQLSTATE — /permission denied/ vs /row-level
    // security/ is the only thing that tells them apart.
    const { start, end } = nextSlot();
    let failure: { code?: string; message?: string } | null = null;
    try {
      await userQuery(
        A.userId,
        `insert into public.appointments
           (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
            duration_minutes, status, cancellation_token_hash)
         values (gen_random_uuid(), $1, null, $2, null, $3::timestamptz, $4::timestamptz,
                 60, 'confirmed', $5)`,
        [A.studioId, B.clientId, start, end, hash64()],
      );
    } catch (e) {
      failure = e as { code?: string; message?: string };
    }
    expect(failure, "the insert must be refused").not.toBeNull();
    expect(failure!.code).toBe("42501");
    expect(failure!.message, "a PRIVILEGE denial").toMatch(/permission denied/i);
    expect(failure!.message, "NOT an RLS denial wearing the same SQLSTATE").not.toMatch(
      /row-level security/i,
    );
  });

  it("(T4.5b) the same authenticated owner is refused even for a fully VALID same-studio row", async () => {
    // Removes the last doubt that the refusal is about the forged reference:
    // this row would satisfy every FK and every RLS predicate. The privilege is
    // simply gone.
    const { start, end } = nextSlot();
    let failure: { code?: string; message?: string } | null = null;
    try {
      await userQuery(
        A.userId,
        `insert into public.appointments
           (id, studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
            duration_minutes, status, cancellation_token_hash)
         values (gen_random_uuid(), $1, null, $2, null, $3::timestamptz, $4::timestamptz,
                 60, 'confirmed', $5)`,
        [A.studioId, A.clientId, start, end, hash64()],
      );
    } catch (e) {
      failure = e as { code?: string; message?: string };
    }
    expect(failure, "a valid same-studio row must ALSO be refused now").not.toBeNull();
    expect(failure!.code).toBe("42501");
    expect(failure!.message).toMatch(/permission denied/i);
  });
});

describe("0151: rejected inserts leave no appointment / reservation / audit row (6)", () => {
  it("(6) a rejected cross-studio insert creates no partial rows", async () => {
    const before = await adminQuery(
      `select
         (select count(*)::int from public.appointments where studio_id=$1) as appts,
         (select count(*)::int from public.studio_calendar_reservations where studio_id=$1) as reservations,
         (select count(*)::int from public.appointment_audit aa
            join public.appointments a on a.id = aa.appointment_id
            where a.studio_id=$1) as audit`,
      [A.studioId],
    );
    await expect(insertAppt({ studioId: A.studioId, clientId: B.clientId })).rejects.toMatchObject({ code: "23503" });
    const after = await adminQuery(
      `select
         (select count(*)::int from public.appointments where studio_id=$1) as appts,
         (select count(*)::int from public.studio_calendar_reservations where studio_id=$1) as reservations,
         (select count(*)::int from public.appointment_audit aa
            join public.appointments a on a.id = aa.appointment_id
            where a.studio_id=$1) as audit`,
      [A.studioId],
    );
    expect(after.rows[0].appts).toBe(before.rows[0].appts);
    expect(after.rows[0].reservations).toBe(before.rows[0].reservations);
    expect(after.rows[0].audit).toBe(before.rows[0].audit);
  });
});

describe("0151: delete semantics preserved (8,9,10,11)", () => {
  it("(9) service deletion nulls only service_id; (11) studio_id preserved", async () => {
    const svc = (
      await adminQuery(
        `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active)
         values ($1,$2,'Del Svc',60,0,true) returning id`,
        [randomUUID(), A.studioId],
      )
    ).rows[0].id as string;
    const id = await insertAppt({ studioId: A.studioId, clientId: A.clientId, serviceId: svc, practitionerId: A.practitionerId });
    await adminQuery(`delete from public.services where id=$1`, [svc]);
    const r = await adminQuery(
      `select service_id, studio_id, practitioner_id from public.appointments where id=$1`,
      [id],
    );
    expect(r.rows[0].service_id).toBeNull();
    expect(r.rows[0].studio_id).toBe(A.studioId); // (11) unchanged, not null
    expect(r.rows[0].practitioner_id).toBe(A.practitionerId); // untouched by service delete
  });

  it("(10) practitioner deletion nulls only practitioner_id; (11) studio_id preserved", async () => {
    // extra non-owner practitioner so we can hard-delete it without touching the owner
    const pracId = randomUUID();
    const uid = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [uid, `del-prac-${uid.slice(0, 8)}@harness.local`]);
    await adminQuery(
      `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
       values ($1,$2,$3,'Del Prac',$4,'practitioner',true)`,
      [pracId, A.studioId, uid, `del-prac-${uid.slice(0, 8)}@harness.local`],
    );
    const id = await insertAppt({ studioId: A.studioId, clientId: A.clientId, serviceId: serviceA, practitionerId: pracId });
    await adminQuery(`delete from public.practitioners where id=$1`, [pracId]);
    const r = await adminQuery(
      `select practitioner_id, studio_id, service_id from public.appointments where id=$1`,
      [id],
    );
    expect(r.rows[0].practitioner_id).toBeNull();
    expect(r.rows[0].studio_id).toBe(A.studioId); // (11)
    expect(r.rows[0].service_id).toBe(serviceA); // untouched by practitioner delete
  });

  it("(8) client deletion cascades its same-studio appointments", async () => {
    // dedicated client so the cascade does not disturb other tests
    const cid = randomUUID();
    await adminQuery(`insert into public.clients (id, studio_id, name) values ($1,$2,'Cascade Client')`, [cid, A.studioId]);
    const id = await insertAppt({ studioId: A.studioId, clientId: cid, serviceId: serviceA, practitionerId: A.practitionerId });
    await adminQuery(`delete from public.clients where id=$1`, [cid]);
    const r = await adminQuery(`select count(*)::int as n from public.appointments where id=$1`, [id]);
    expect(r.rows[0].n).toBe(0);
  });
});

describe("0151: RLS confidentiality unchanged (12)", () => {
  it("(12) a foreign-studio member still cannot read studio A's appointments", async () => {
    const id = await insertAppt({ studioId: A.studioId, clientId: A.clientId, serviceId: serviceA, practitionerId: A.practitionerId });
    // Beta owner (member of B only) reads by exact id -> zero rows (RLS).
    const asBeta = await userQuery(B.userId, `select id from public.appointments where id=$1`, [id]);
    expect(asBeta.rowCount).toBe(0);
    // Alpha owner reads own -> visible (authorized access retained).
    const asAlpha = await userQuery(A.userId, `select id from public.appointments where id=$1`, [id]);
    expect(asAlpha.rowCount).toBe(1);
  });
});

describe("0151: exactly one FK per parent (13) + correct definitions (7,15)", () => {
  async function fkDefs(parent: string): Promise<string[]> {
    const r = await adminQuery(
      `select pg_get_constraintdef(oid) as def
         from pg_constraint
        where contype='f' and conrelid='public.appointments'::regclass
          and confrelid=$1::regclass`,
      [`public.${parent}`],
    );
    return r.rows.map((x) => x.def as string);
  }

  it("(13) exactly one appointments FK to each of clients / services / practitioners", async () => {
    expect(await fkDefs("clients")).toHaveLength(1);
    expect(await fkDefs("services")).toHaveLength(1);
    expect(await fkDefs("practitioners")).toHaveLength(1);
  });

  it("(7,15) each is the composite (child_id, studio_id) FK with the mirrored ON DELETE action", async () => {
    const [client] = await fkDefs("clients");
    const [service] = await fkDefs("services");
    const [prac] = await fkDefs("practitioners");
    expect(client).toMatch(/FOREIGN KEY \(client_id, studio_id\) REFERENCES clients\(id, studio_id\)/);
    expect(client).toMatch(/ON DELETE CASCADE/);
    expect(service).toMatch(/FOREIGN KEY \(service_id, studio_id\) REFERENCES services\(id, studio_id\)/);
    expect(service).toMatch(/ON DELETE SET NULL \(service_id\)/);
    expect(prac).toMatch(/FOREIGN KEY \(practitioner_id, studio_id\) REFERENCES practitioners\(id, studio_id\)/);
    expect(prac).toMatch(/ON DELETE SET NULL \(practitioner_id\)/);
    // (15) the migration applied on the clean chain: none of the prior single-column
    // FKs survive under their old names.
    const oldNames = await adminQuery(
      `select conname from pg_constraint
        where conrelid='public.appointments'::regclass
          and conname in ('appointments_client_id_fkey','appointments_service_id_fkey','appointments_practitioner_id_fkey')`,
    );
    expect(oldNames.rowCount).toBe(0);
  });
});

describe("0151: preflight fails safely on corrupt data, unchanged otherwise (14)", () => {
  it("(14) the preflight detects a cross-studio row and aborts, rolling back with no change", async () => {
    // Reproduce 0151's preflight against a deliberately corrupted fixture WITHOUT
    // mutating the live schema: one autocommit DO block drops the composite FK,
    // inserts a forged cross-studio appointment, runs the SAME preflight count, and
    // RAISES — so the whole statement (drop + insert) rolls back atomically. This
    // proves the preflight both detects corruption and aborts before any persistent
    // constraint change.
    // A DO block cannot take bind parameters, so the trusted seed UUIDs
    // (randomUUID() — hex + hyphens only, no injection surface) are inlined.
    await expect(
      adminQuery(
        `do $$
         declare v_bad bigint;
         begin
           alter table public.appointments drop constraint appointments_client_same_studio_fk;
           insert into public.appointments
             (id, studio_id, client_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
           values (gen_random_uuid(), '${A.studioId}'::uuid, '${B.clientId}'::uuid,
                   '2033-01-01T10:00:00Z', '2033-01-01T11:00:00Z', 60, 'confirmed',
                   replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));
           select count(*) into v_bad
             from public.appointments a join public.clients c on c.id = a.client_id
             where c.studio_id <> a.studio_id;
           if v_bad > 0 then
             raise exception 'appointment tenant-consistency preflight failed: cross-studio appointment reference(s) present; aborting before constraint replacement'
               using errcode = 'raise_exception';
           end if;
         end $$;`,
      ),
    ).rejects.toThrow(/preflight failed: cross-studio appointment reference/);

    // The DO block rolled back: the composite FK is intact and no corrupt row persisted.
    const fk = await adminQuery(
      `select 1 from pg_constraint where conname='appointments_client_same_studio_fk'
         and conrelid='public.appointments'::regclass`,
    );
    expect(fk.rowCount).toBe(1);
    const corrupt = await adminQuery(
      `select count(*)::int as n from public.appointments a
         join public.clients c on c.id=a.client_id where c.studio_id <> a.studio_id`,
    );
    expect(corrupt.rows[0].n).toBe(0);
  });
});
