import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, seedStudio, userQuery, type SeededStudio } from "./helpers/harness";

// Google Calendar — Phase B2.2 DB integration (LOCAL disposable Supabase only).
// granted_scopes is about to become the gate outbound enablement trusts, so this
// pins that a browser role can NEVER change it (or any connection field / secret)
// — the column moves only through the trusted service-role callback path.

const PHASE_A = ["https://www.googleapis.com/auth/calendar.calendarlist.readonly"];
const EVENTS = "https://www.googleapis.com/auth/calendar.events";

afterAll(async () => {
  await closePool();
});

async function seedConnection(studio: SeededStudio, scopes: string[] = PHASE_A): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    "insert into public.calendar_connections (id, studio_id, practitioner_id, connection_status, granted_scopes, write_calendar_id, is_studio_calendar_owner, google_account_id) values ($1,$2,$3,'connected',$4,'primary',true,'google-sub-1')",
    [id, studio.studioId, studio.practitionerId, scopes],
  );
  await adminQuery(
    "insert into public.calendar_connection_secrets (connection_id, studio_id, encrypted_refresh_token, refresh_token_last4, encryption_key_version) values ($1,$2,'v1:1:iv:tag:ct','1234',1)",
    [id, studio.studioId],
  );
  return id;
}

describe("granted_scopes is not browser-mutable", () => {
  it("an authenticated member's direct UPDATE to granted_scopes changes nothing (no RLS update policy)", async () => {
    const studio = await seedStudio("gcalScopeA");
    const conn = await seedConnection(studio);
    // Member CAN read (member SELECT policy) …
    const before = await userQuery(studio.userId, "select granted_scopes from public.calendar_connections where id=$1", [conn]);
    expect(before.rowCount).toBe(1);
    // … but CANNOT write: the UPDATE matches no row under RLS.
    const upd = await userQuery(
      studio.userId,
      "update public.calendar_connections set granted_scopes=$1 where id=$2",
      [[...PHASE_A, EVENTS], conn],
    );
    expect(upd.rowCount).toBe(0);
    const after = await adminQuery("select granted_scopes from public.calendar_connections where id=$1", [conn]);
    expect(after.rows[0].granted_scopes).toEqual(PHASE_A); // unchanged
  });

  it("the trusted service-role path CAN update granted_scopes", async () => {
    const studio = await seedStudio("gcalScopeSvc");
    const conn = await seedConnection(studio);
    await adminQuery("update public.calendar_connections set granted_scopes=$1 where id=$2", [[...PHASE_A, EVENTS], conn]);
    const after = await adminQuery("select granted_scopes from public.calendar_connections where id=$1", [conn]);
    expect(after.rows[0].granted_scopes).toContain(EVENTS);
  });
});

describe("isolation + single connection", () => {
  it("a different studio's member cannot see or mutate the connection", async () => {
    const a = await seedStudio("gcalScopeX1");
    const b = await seedStudio("gcalScopeX2");
    const conn = await seedConnection(a);
    const seen = await userQuery(b.userId, "select id from public.calendar_connections where id=$1", [conn]);
    expect(seen.rowCount).toBe(0);
    const upd = await userQuery(b.userId, "update public.calendar_connections set granted_scopes=$1 where id=$2", [[EVENTS], conn]);
    expect(upd.rowCount).toBe(0);
  });

  it("the secret table stays unreadable to a browser role", async () => {
    const studio = await seedStudio("gcalScopeSec");
    await seedConnection(studio);
    await expect(
      userQuery(studio.userId, "select encrypted_refresh_token from public.calendar_connection_secrets"),
    ).rejects.toThrow();
  });

  it("one connection per practitioner is enforced (upgrade reuses the row, never duplicates)", async () => {
    const studio = await seedStudio("gcalScopeUniq");
    await seedConnection(studio);
    await expect(
      adminQuery(
        "insert into public.calendar_connections (id, studio_id, practitioner_id, connection_status) values ($1,$2,$3,'connected')",
        [randomUUID(), studio.studioId, studio.practitionerId],
      ),
    ).rejects.toThrow();
  });
});
