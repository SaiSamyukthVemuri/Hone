import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// Removal is immediate at the database (the old-JWT path of the S4 revocation proof). The identity a receptionist
// function trusts is read LIVE from studio_receptionists on every call, never from the token, so a JWT minted
// before the owner removed the access gets no further answer. The browser path (old session cookie) is proved in
// e2e/receptionist-removal.spec.ts. Synthetic values only.
//
// Every function a receptionist may reach directly through PostgREST is exercised: the same `authenticated` JWT
// claims, before and after set_studio_receptionist_active(false). Each has a positive control first (the gate
// passes while the membership is active), so a refusal afterwards cannot be a vacuous one.

let studio: SeededStudio;
let deskUser: string;
let receptionistId: string;
let apptId: string;
let serviceId: string;

type Call = { name: string; run: (uid: string) => Promise<{ rows: Array<Record<string, unknown>> }> };

const FROM = "2031-03-01T00:00:00Z";
const TO = "2031-03-10T00:00:00Z";
const q = (uid: string, sql: string, params: unknown[]) => asUser(uid, (x) => x(sql, params));

// The eight functions granted to `authenticated` that resolve a receptionist (0216/0220/0266/0274).
function calls(): Call[] {
  const s = studio.studioId;
  return [
    { name: "receptionist_calendar_v2", run: (u) => q(u, "select * from public.receptionist_calendar_v2($1,$2,$3)", [s, FROM, TO]) },
    { name: "receptionist_client_directory", run: (u) => q(u, "select * from public.receptionist_client_directory($1,null,null,'name',0,25)", [s]) },
    { name: "receptionist_studio_timezone", run: (u) => q(u, "select public.receptionist_studio_timezone($1) as tz", [s]) },
    { name: "receptionist_client_contacts_v2", run: (u) => q(u, "select * from public.receptionist_client_contacts_v2($1,null,25)", [s]) },
    { name: "receptionist_booking_options", run: (u) => q(u, "select * from public.receptionist_booking_options($1)", [s]) },
    {
      name: "receptionist_create_appointment",
      run: (u) => q(u, "select * from public.receptionist_create_appointment($1,$2,$3,$4,$5)", [s, studio.practitionerId, studio.clientId, serviceId, "2031-03-05T15:00:00Z"]),
    },
    { name: "receptionist_cancel_appointment", run: (u) => q(u, "select * from public.receptionist_cancel_appointment($1,$2,$3)", [s, apptId, "synthetic"]) },
    {
      name: "receptionist_move_appointment",
      run: (u) =>
        q(u, "select * from public.receptionist_move_appointment($1,$2,$3,$4,$5,$6)", [s, apptId, studio.practitionerId, "2031-03-04T15:00:00Z", "2031-03-04T16:00:00Z", "2031-03-06T15:00:00Z"]),
    },
  ];
}

const WRITES = new Set(["receptionist_create_appointment", "receptionist_cancel_appointment", "receptionist_move_appointment"]);

/** Refused = the call raises (42501 or any error) or answers only 'not_authorized' / nothing. */
async function outcome(call: Call, uid: string): Promise<"refused" | "gate-passed"> {
  try {
    const r = await call.run(uid);
    if (WRITES.has(call.name)) return r.rows.length > 0 && r.rows.every((row) => row.result === "not_authorized") ? "refused" : "gate-passed";
    return "gate-passed";
  } catch {
    return "refused";
  }
}

beforeAll(async () => {
  studio = await seedStudio("desk-removal");
  deskUser = randomUUID();
  await adminQuery("insert into auth.users(id,email) values ($1,$2)", [deskUser, `desk-removal-${deskUser.slice(0, 8)}@harness.local`]);
  const r = await adminQuery(
    "insert into public.studio_receptionists(studio_id,user_id,display_name,active) values ($1,$2,'Synthetic Front Desk',true) returning id",
    [studio.studioId, deskUser],
  );
  receptionistId = r.rows[0].id as string;
  serviceId = randomUUID();
  await adminQuery("insert into public.services(id,studio_id,name,default_duration_minutes,active) values ($1,$2,'Synthetic Service',60,true)", [serviceId, studio.studioId]);
  apptId = randomUUID();
  await adminQuery(
    `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
     values ($1, $2, $3, $4, '2031-03-04T15:00:00Z', '2031-03-04T16:00:00Z', 60, 'confirmed', encode(sha256(gen_random_uuid()::text::bytea), 'hex'))`,
    [apptId, studio.studioId, studio.practitionerId, studio.clientId],
  );
});

afterAll(async () => {
  await closePool();
});

describe("removal is immediate for a JWT minted before it", () => {
  it("every receptionist function passes its gate while active, then refuses the same claims after removal", async () => {
    for (const call of calls()) {
      expect(await outcome(call, deskUser), `${call.name}: positive control (active)`).toBe("gate-passed");
    }
    const removed = await asRole("service_role", (x) =>
      x("select public.set_studio_receptionist_active($1,$2,$3,false) as r", [studio.studioId, studio.practitionerId, receptionistId]),
    );
    expect(removed.rows[0].r).toBe("updated");
    for (const call of calls()) {
      expect(await outcome(call, deskUser), `${call.name}: refused after removal`).toBe("refused");
    }
  });

  it("the membership row stays, deactivated, and removal is idempotent (a second call changes nothing)", async () => {
    const row = await adminQuery("select active, deactivated_at is not null as stamped from public.studio_receptionists where id=$1", [receptionistId]);
    expect(row.rows[0]).toMatchObject({ active: false, stamped: true });
    const again = await asRole("service_role", (x) =>
      x("select public.set_studio_receptionist_active($1,$2,$3,false) as r", [studio.studioId, studio.practitionerId, receptionistId]),
    );
    expect(again.rows[0].r).toBe("no_change");
  });

  it("the removal command itself is service_role only: authenticated (owner included) and anon are refused", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(
        asRole(role, (x) => x("select public.set_studio_receptionist_active($1,$2,$3,false)", [studio.studioId, studio.practitionerId, receptionistId])),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });
});

describe("flag off is not revocation", () => {
  it("HONE_RECEPTIONIST_DESK_ENABLED does not exist in the database: only the membership gates these functions", async () => {
    // Reactivate in this test only to show an ACTIVE membership still answers regardless of any app flag.
    await asRole("service_role", (x) =>
      x("select public.set_studio_receptionist_active($1,$2,$3,true)", [studio.studioId, studio.practitionerId, receptionistId]),
    );
    const call = calls()[0];
    expect(await outcome(call, deskUser)).toBe("gate-passed");
    await asRole("service_role", (x) =>
      x("select public.set_studio_receptionist_active($1,$2,$3,false)", [studio.studioId, studio.practitionerId, receptionistId]),
    );
    expect(await outcome(call, deskUser)).toBe("refused");
  });
});
