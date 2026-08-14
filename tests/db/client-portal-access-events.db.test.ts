import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// Migration 0111 client_portal_access_events: studio-scoped, append-only portal
// access/send event log. Proves RLS cross-studio isolation, append-only (no
// authenticated write), same-studio tenant isolation via the composite FK, and
// that the table has no column for any secret/PII.

let a: SeededStudio;
let b: SeededStudio;

async function insertEvent(
  studio: SeededStudio,
  eventType: string,
  channel: string | null,
): Promise<void> {
  await adminQuery(
    `insert into public.client_portal_access_events
       (studio_id, client_id, event_type, channel)
     values ($1, $2, $3, $4)`,
    [studio.studioId, studio.clientId, eventType, channel],
  );
}

beforeAll(async () => {
  a = await seedStudio("cpae-a");
  b = await seedStudio("cpae-b");
  // Service-role inserts (the app's only write path) succeed.
  await insertEvent(a, "portal_link_sent", "email");
  await insertEvent(a, "portal_magic_link_consumed", null);
});

afterAll(async () => {
  await closePool();
});

describe("client_portal_access_events: RLS + tenant isolation + append-only", () => {
  it("service-role insert persisted studio A's events", async () => {
    const { rows } = await adminQuery(
      `select event_type from public.client_portal_access_events
       where studio_id = $1 order by event_type`,
      [a.studioId],
    );
    expect(rows.map((r) => r.event_type)).toEqual([
      "portal_link_sent",
      "portal_magic_link_consumed",
    ]);
  });

  it("is studio-scoped: another studio's member sees NONE of studio A's events (RLS)", async () => {
    const res = await asUser(b.userId, (q) =>
      q(`select * from public.client_portal_access_events where studio_id = $1`, [a.studioId]),
    );
    expect(res.rowCount).toBe(0);
  });

  it("a studio's own member CAN read its events (RLS select policy)", async () => {
    const res = await asUser(a.userId, (q) =>
      q(`select id from public.client_portal_access_events where studio_id = $1`, [a.studioId]),
    );
    expect(res.rowCount).toBe(2);
  });

  it("is append-only: an authenticated user cannot INSERT (no write policy/grant)", async () => {
    await expect(
      asUser(a.userId, (q) =>
        q(
          `insert into public.client_portal_access_events (studio_id, client_id, event_type)
           values ($1, $2, 'portal_link_sent')`,
          [a.studioId, a.clientId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("same-studio composite FK blocks a cross-tenant row even via service-role", async () => {
    // studio A + a client that belongs to studio B → (studio_id, client_id) is
    // not a valid clients(studio_id, id) pair → FK violation.
    await expect(
      adminQuery(
        `insert into public.client_portal_access_events (studio_id, client_id, event_type)
         values ($1, $2, 'portal_link_sent')`,
        [a.studioId, b.clientId],
      ),
    ).rejects.toThrow();
  });

  it("has NO column for any secret/PII (token, url, ip, email, clinical, payment)", async () => {
    const { rows } = await adminQuery(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='client_portal_access_events'`,
    );
    const cols = rows.map((r) => r.column_name as string);
    for (const forbidden of [
      "token",
      "url",
      "ip",
      "email",
      "user_agent",
      "intake",
      "clinical",
      "note",
      "card",
      "stripe",
      "payment",
    ]) {
      expect(cols.some((c) => c.includes(forbidden))).toBe(false);
    }
  });
});
