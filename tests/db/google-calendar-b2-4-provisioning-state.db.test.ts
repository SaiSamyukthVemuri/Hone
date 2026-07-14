import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { adminQuery, seedStudio, closePool, type SeededStudio } from "./helpers/harness";

// B2.4 Stage 2 amendment to migration 0131: the DEDICATED provisioning-state
// columns + their mode guard on calendar_connections, and the destination-BINDING
// columns + matched-pair/mode checks on google_oauth_states. Additive + dormant;
// this proves the CHECK constraints behave. Runs against the migrated local
// Postgres (CI db-integration lane).

const APP_CREATED = "https://www.googleapis.com/auth/calendar.app.created";
const EVENTS_OWNED = "https://www.googleapis.com/auth/calendar.events.owned";

let studio: SeededStudio;
let connId: string;

function hex64(): string {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

async function insertState(fields: {
  destinationMode: string | null;
  requiredScope: string | null;
}): Promise<void> {
  await adminQuery(
    `insert into public.google_oauth_states
       (state_hash, session_nonce_hash, studio_id, practitioner_id, user_id,
        encrypted_pkce_verifier, encryption_key_version, destination_mode, required_event_scope)
     values ($1,$2,$3,$4,$5,'v1:1:ct',1,$6,$7)`,
    [
      hex64(),
      hex64(),
      studio.studioId,
      studio.practitionerId,
      studio.userId,
      fields.destinationMode,
      fields.requiredScope,
    ],
  );
}

async function expectReject(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toThrow();
}

beforeAll(async () => {
  studio = await seedStudio("b24-prov-state");
  connId = randomUUID();
  await adminQuery(
    `insert into public.calendar_connections
       (id, studio_id, practitioner_id, connection_status, granted_scopes, is_studio_calendar_owner, google_account_id)
     values ($1,$2,$3,'connected', array[]::text[], true, 'sub-prov')`,
    [connId, studio.studioId, studio.practitionerId],
  );
});

afterAll(async () => {
  await adminQuery(`delete from public.google_oauth_states where studio_id = $1`, [studio.studioId]).catch(() => {});
  await adminQuery(`delete from public.calendar_connections where id = $1`, [connId]).catch(() => {});
  await adminQuery(`delete from public.studios where id = $1`, [studio.studioId]).catch(() => {});
  await closePool();
});

describe("0131 amendment — calendar_connections provisioning-state columns", () => {
  it("provisioning columns default to NULL (additive + dormant)", async () => {
    const r = await adminQuery(
      `select destination_provisioning_attempt_token, destination_provisioning_started_at,
              destination_provisioning_ambiguous_at
         from public.calendar_connections where id = $1`,
      [connId],
    );
    expect(r.rows[0].destination_provisioning_attempt_token).toBeNull();
    expect(r.rows[0].destination_provisioning_started_at).toBeNull();
    expect(r.rows[0].destination_provisioning_ambiguous_at).toBeNull();
  });

  it("allows the attempt token when destination_mode = 'dedicated_app_created'", async () => {
    await adminQuery(
      `update public.calendar_connections
         set destination_mode = 'dedicated_app_created',
             destination_provisioning_attempt_token = 'tok-abcdef012345',
             destination_provisioning_started_at = now()
       where id = $1`,
      [connId],
    );
    const r = await adminQuery(
      `select destination_provisioning_attempt_token as t from public.calendar_connections where id = $1`,
      [connId],
    );
    expect(r.rows[0].t).toBe("tok-abcdef012345");
  });

  it("REJECTS provisioning-state under the existing_owned mode (mode guard)", async () => {
    // Reset to a clean existing_owned row first (clear the dedicated provisioning).
    await adminQuery(
      `update public.calendar_connections
         set destination_mode = 'existing_owned',
             destination_provisioning_attempt_token = null,
             destination_provisioning_started_at = null
       where id = $1`,
      [connId],
    );
    await expectReject(
      adminQuery(
        `update public.calendar_connections
           set destination_provisioning_attempt_token = 'x-should-fail-1234'
         where id = $1`,
        [connId],
      ),
    );
  });

  it("REJECTS provisioning-state under a NULL destination_mode (mode guard)", async () => {
    await adminQuery(
      `update public.calendar_connections set destination_mode = null where id = $1`,
      [connId],
    );
    await expectReject(
      adminQuery(
        `update public.calendar_connections
           set destination_provisioning_ambiguous_at = now()
         where id = $1`,
        [connId],
      ),
    );
  });
});

describe("0131 amendment — google_oauth_states destination binding", () => {
  it("accepts a plain connect (both destination columns NULL)", async () => {
    await insertState({ destinationMode: null, requiredScope: null });
  });

  it("accepts a matched pair (valid mode + its exact scope)", async () => {
    await insertState({ destinationMode: "dedicated_app_created", requiredScope: APP_CREATED });
    await insertState({ destinationMode: "existing_owned", requiredScope: EVENTS_OWNED });
  });

  it("REJECTS destination_mode set with a NULL required scope (pair check)", async () => {
    await expectReject(insertState({ destinationMode: "existing_owned", requiredScope: null }));
  });

  it("REJECTS a required scope set with a NULL destination_mode (pair check)", async () => {
    await expectReject(insertState({ destinationMode: null, requiredScope: EVENTS_OWNED }));
  });

  it("REJECTS an unknown destination_mode (mode check)", async () => {
    await expectReject(insertState({ destinationMode: "bogus_mode", requiredScope: EVENTS_OWNED }));
  });
});
