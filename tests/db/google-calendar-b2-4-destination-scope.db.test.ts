import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, purgeAppointmentAudit, seedStudio, closePool, type SeededStudio } from "./helpers/harness";

// B2.4 (migration 0131) DB contract: the destination-aware required-scope function
// and the destination-aware, empty-array-fail-closed readiness predicate. Runs
// against the migrated local Postgres (CI db-integration lane).

const APP_CREATED = "https://www.googleapis.com/auth/calendar.app.created";
const EVENTS_OWNED = "https://www.googleapis.com/auth/calendar.events.owned";
const EVENTS_BROAD = "https://www.googleapis.com/auth/calendar.events";

let studio: SeededStudio;
let connId: string;

beforeAll(async () => {
  studio = await seedStudio("b24-dest-scope");
  await adminQuery(
    `update public.studios set google_calendar_outbound_sync_enabled = true where id = $1`,
    [studio.studioId],
  );
  connId = randomUUID();
  await adminQuery(
    `insert into public.calendar_connections
       (id, studio_id, practitioner_id, connection_status, granted_scopes, write_calendar_id, is_studio_calendar_owner, google_account_id)
     values ($1,$2,$3,'connected', array[]::text[], 'primary', true, 'sub-b24')`,
    [connId, studio.studioId, studio.practitionerId],
  );
  await adminQuery(
    `insert into public.calendar_connection_secrets
       (connection_id, studio_id, encrypted_refresh_token, refresh_token_last4, encryption_key_version)
     values ($1,$2,'v1:1:iv:tag:ct','1234',1)`,
    [connId, studio.studioId],
  );
});

afterAll(async () => {
  await adminQuery(`delete from public.calendar_connections where id = $1`, [connId]).catch(() => {});
  await purgeAppointmentAudit(studio.studioId).catch(() => {});
  await adminQuery(`delete from public.studios where id = $1`, [studio.studioId]).catch(() => {});
  await closePool();
});

async function scopes(mode: string | null): Promise<string[] | null> {
  const r = await adminQuery(
    `select public.calendar_required_event_scopes($1) as s`,
    [mode],
  );
  return r.rows[0].s as string[] | null;
}

async function setConn(destinationMode: string | null, granted: string[], withSecret = true): Promise<boolean> {
  await adminQuery(
    `update public.calendar_connections set destination_mode = $2, granted_scopes = $3 where id = $1`,
    [connId, destinationMode, granted],
  );
  if (!withSecret) {
    await adminQuery(`delete from public.calendar_connection_secrets where connection_id = $1`, [connId]);
  }
  const r = await adminQuery(
    `select public.calendar_connection_outbound_ready($1,$2) as ready`,
    [connId, studio.studioId],
  );
  return r.rows[0].ready as boolean;
}

describe("0131 calendar_required_event_scopes(destination) — exact map + fail-closed", () => {
  it("dedicated_app_created -> {calendar.app.created}", async () => {
    expect(await scopes("dedicated_app_created")).toEqual([APP_CREATED]);
  });
  it("existing_owned -> {calendar.events.owned}", async () => {
    expect(await scopes("existing_owned")).toEqual([EVENTS_OWNED]);
  });
  it("null/unknown -> NULL (never empty array)", async () => {
    expect(await scopes(null)).toBeNull();
    expect(await scopes("unknown")).toBeNull();
    expect(await scopes("")).toBeNull();
  });
  it("legacy 0-arg -> NULL", async () => {
    const r = await adminQuery(`select public.calendar_required_event_scopes() as s`);
    expect(r.rows[0].s).toBeNull();
  });
});

describe("0131 calendar_connection_outbound_ready — destination-aware, fail-closed", () => {
  it("dedicated + app.created granted -> ready", async () => {
    expect(await setConn("dedicated_app_created", ["openid", APP_CREATED])).toBe(true);
  });
  it("existing_owned + events.owned granted -> ready", async () => {
    expect(await setConn("existing_owned", ["openid", EVENTS_OWNED])).toBe(true);
  });
  it("existing_owned + BROAD calendar.events -> NOT ready (prefix trap)", async () => {
    expect(await setConn("existing_owned", [EVENTS_BROAD])).toBe(false);
  });
  it("dedicated + owned scope (wrong mode) -> NOT ready", async () => {
    expect(await setConn("dedicated_app_created", [EVENTS_OWNED])).toBe(false);
  });
  it("NULL destination + owned scope -> NOT ready (fail-closed)", async () => {
    expect(await setConn(null, [EVENTS_OWNED])).toBe(false);
  });
  it("valid mode + EMPTY granted -> NOT ready (empty-array containment guard)", async () => {
    expect(await setConn("existing_owned", [])).toBe(false);
  });
  it("ready shape but NO refresh-token secret -> NOT ready", async () => {
    expect(await setConn("existing_owned", [EVENTS_OWNED], false)).toBe(false);
  });
});
