import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// RBAC Deliverable 2, dimension 3 (API/DB with real role sessions): the receptionist
// surface that EXISTS in production today (0216 reads, 0220 scheduling commands).
// A receptionist is a studio_receptionists row, never a practitioners row, so every
// is_studio_member policy refuses by construction; the only reach is the granted
// functions. Marker method: privacy/RBAC-FORBIDDEN-DATA-MARKERS.md (unique
// alphanumeric sentinels, owner positive control on the same fixture).
// Synthetic data only. Each probe runs in a rolled-back or discarded session.
//
// NOT RUN at authoring time (the heavy slot is held). Runs in the CI DB lane.

const SENTINEL = {
  storedName: "RBACZZSTORED01",
  email: "rbaczzemail01@harness.local",
  phone: "RBACZZPHONE01",
  allergies: "RBACZZALLERGY01",
  pronouns: "RBACZZPRON01",
};

// The columns each v1 read returns TODAY. If a column is added or removed this
// fails, so a widening is a reviewed change and not a silent one (Privacy P-1/P-2).
const RETURNS = {
  receptionist_calendar:
    "appointment_id uuid, starts_at timestamp with time zone, ends_at timestamp with time zone, status text, practitioner_id uuid, practitioner_display_name text, practitioner_color text, service_id uuid, service_name text, client_id uuid, client_display_name text",
  receptionist_calendar_closures:
    "source_kind text, starts_at timestamp with time zone, ends_at timestamp with time zone, resource_practitioner_id uuid",
  receptionist_client_contacts:
    "client_id uuid, name text, phone text, email text, intake_status text, intake_submitted_at timestamp with time zone, consent_accepted_at timestamp with time zone",
  receptionist_booking_options:
    "kind text, id uuid, name text, duration_minutes integer, color text",
} as const;

const GRANTED_TO_AUTHENTICATED = [
  "receptionist_calendar(uuid, timestamptz, timestamptz)",
  "receptionist_calendar_closures(uuid, timestamptz, timestamptz)",
  "receptionist_client_contacts(uuid, text, integer)",
  "receptionist_booking_options(uuid)",
  "receptionist_create_appointment(uuid, uuid, uuid, uuid, timestamptz)",
  "receptionist_cancel_appointment(uuid, uuid, text)",
  "receptionist_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz)",
] as const;

const ADMIN_ONLY = [
  "add_studio_receptionist(uuid, uuid, uuid, text, text)",
  "set_studio_receptionist_active(uuid, uuid, uuid, boolean)",
] as const;

let a: SeededStudio;
let b: SeededStudio;
let practitioner: { userId: string; practitionerId: string };
let receptionistUserId: string;

async function seedReceptionist(
  studio: SeededStudio,
): Promise<{ userId: string; membershipId: string }> {
  const userId = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
    userId,
    `rcp-${userId.slice(0, 8)}@harness.local`,
  ]);
  const added = await adminQuery(
    `select public.add_studio_receptionist($1, $2, $3, $4, $5) as id`,
    [studio.studioId, studio.practitionerId, userId, "Desk", `rcp-${userId.slice(0, 8)}@harness.local`],
  );
  return { userId, membershipId: added.rows[0].id as string };
}

beforeAll(async () => {
  a = await seedStudio("rbac-a");
  b = await seedStudio("rbac-b");
  practitioner = await seedMember(a, "rbac-pr");
  receptionistUserId = (await seedReceptionist(a)).userId;
  // Forbidden-field sentinels on the SAME client the owner control reads.
  await adminQuery(
    `update public.clients
        set name = $2, email = $3, phone = $4, allergies = $5, pronouns = $6
      where id = $1`,
    [a.clientId, SENTINEL.storedName, SENTINEL.email, SENTINEL.phone, SENTINEL.allergies, SENTINEL.pronouns],
  );
});

afterAll(async () => {
  await closePool();
});

describe("receptionist v1 surface: grants", () => {
  it.each(GRANTED_TO_AUTHENTICATED)("%s is executable by authenticated only", async (sig) => {
    const r = await adminQuery(
      `select has_function_privilege('authenticated', 'public.${sig}', 'execute') as authed,
              has_function_privilege('anon', 'public.${sig}', 'execute') as anon,
              has_function_privilege('service_role', 'public.${sig}', 'execute') as svc,
              has_function_privilege('public', 'public.${sig}', 'execute') as pub`,
    );
    expect(r.rows[0]).toEqual({ authed: true, anon: false, svc: false, pub: false });
  });

  it.each(ADMIN_ONLY)("%s is service_role only (a receptionist cannot add or reactivate anyone)", async (sig) => {
    const r = await adminQuery(
      `select has_function_privilege('authenticated', 'public.${sig}', 'execute') as authed,
              has_function_privilege('anon', 'public.${sig}', 'execute') as anon,
              has_function_privilege('service_role', 'public.${sig}', 'execute') as svc`,
    );
    expect(r.rows[0]).toEqual({ authed: false, anon: false, svc: true });
  });
});

describe("receptionist v1 surface: exact columns returned", () => {
  it.each(Object.entries(RETURNS))("%s returns exactly the pinned columns", async (fn, cols) => {
    const r = await adminQuery(
      `select pg_get_function_result(p.oid) as result
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`,
      [fn],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].result).toBe(`TABLE(${cols})`);
  });

  it("no receptionist read returns a price, note, clinical or card column", async () => {
    const all = Object.values(RETURNS).join(" ");
    for (const forbidden of ["price", "amount", "notes", "allerg", "stripe", "card", "dob", "birth", "pronoun", "legal", "signed_url", "storage"]) {
      expect(all.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe("receptionist v1 surface: runtime, real receptionist session", () => {
  it("owner positive control: the owner reads the sentinel client through member RLS", async () => {
    const r = await asUser(a.userId, (q) =>
      q(`select name, email, allergies from public.clients where id = $1`, [a.clientId]),
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].allergies).toBe(SENTINEL.allergies);
  });

  it("the receptionist reads NO row of the member tables directly (zero rows or refused)", async () => {
    for (const table of ["clients", "appointments", "practitioners", "services", "client_pricing", "payment_charge_attempts", "appointment_settlements", "client_intake_forms", "audit_logs"]) {
      let rows = 0;
      try {
        const r = await asUser(receptionistUserId, (q) => q(`select count(*)::int as n from public.${table}`));
        rows = r.rows[0].n;
      } catch (e) {
        expect((e as { code?: string }).code, `${table}: refusal must be a privilege error`).toBe("42501");
      }
      expect(rows, `${table} must show a receptionist no rows`).toBe(0);
    }
  });

  it("contacts returns the desk fields and NONE of the forbidden sentinels", async () => {
    const r = await asUser(receptionistUserId, (q) =>
      q(`select * from public.receptionist_client_contacts($1, null, 25)`, [a.studioId]),
    );
    const mine = r.rows.find((row: { client_id: string }) => row.client_id === a.clientId);
    expect(mine, "the receptionist must see the desk contact row (control for the absence checks)").toBeTruthy();
    const body = JSON.stringify(r.rows);
    for (const forbidden of [SENTINEL.allergies, SENTINEL.pronouns]) {
      expect(body).not.toContain(forbidden);
    }
    expect(Object.keys(mine).sort()).toEqual(
      ["client_id", "consent_accepted_at", "email", "intake_status", "intake_submitted_at", "name", "phone"],
    );
  });

  it("KNOWN P-1 (characterization): v1 contacts returns and searches the STORED name", async () => {
    const r = await asUser(receptionistUserId, (q) =>
      q(`select name from public.receptionist_client_contacts($1, $2, 25)`, [a.studioId, SENTINEL.storedName]),
    );
    // Recorded as production behaviour today. The held 0258+0266+0274 package
    // changes it; when it does this assertion is the one to revisit, deliberately.
    expect(r.rows.map((x: { name: string }) => x.name)).toContain(SENTINEL.storedName);
  });

  it("a search by a forbidden field (allergies, pronouns) finds nothing", async () => {
    for (const term of [SENTINEL.allergies, SENTINEL.pronouns]) {
      const r = await asUser(receptionistUserId, (q) =>
        q(`select client_id from public.receptionist_client_contacts($1, $2, 25)`, [a.studioId, term]),
      );
      expect(r.rows).toHaveLength(0);
    }
  });

  it("cross-studio: a studio-A receptionist is refused studio B, on every read", async () => {
    for (const sql of [
      `select * from public.receptionist_client_contacts($1, null, 25)`,
      `select * from public.receptionist_calendar($1, now() - interval '1 day', now() + interval '1 day')`,
      `select * from public.receptionist_calendar_closures($1, now() - interval '1 day', now() + interval '1 day')`,
      `select * from public.receptionist_booking_options($1)`,
    ]) {
      await expect(asUser(receptionistUserId, (q) => q(sql, [b.studioId]))).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("a practitioner (studio member, not a receptionist) is refused the receptionist reads", async () => {
    await expect(
      asUser(practitioner.userId, (q) => q(`select * from public.receptionist_client_contacts($1, null, 25)`, [a.studioId])),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("an anonymous session cannot execute a receptionist read", async () => {
    await expect(
      asRole("anon", (q) => q(`select * from public.receptionist_client_contacts($1, null, 25)`, [a.studioId])),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("revocation: after set_studio_receptionist_active(false) the same user is refused at once", async () => {
    const { userId: revoked, membershipId } = await seedReceptionist(a);
    // Before: allowed (control).
    const before = await asUser(revoked, (q) => q(`select * from public.receptionist_booking_options($1)`, [a.studioId]));
    expect(Array.isArray(before.rows)).toBe(true);
    // The third argument is the MEMBERSHIP ROW id, not the user id.
    const done = await adminQuery(`select public.set_studio_receptionist_active($1, $2, $3, false) as r`, [
      a.studioId,
      a.practitionerId,
      membershipId,
    ]);
    expect(done.rows[0].r).toBe("updated");
    await expect(
      asUser(revoked, (q) => q(`select * from public.receptionist_booking_options($1)`, [a.studioId])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(revoked, (q) => q(`select * from public.receptionist_client_contacts($1, null, 25)`, [a.studioId])),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
