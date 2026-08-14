import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// Migration 0113 admin_action_events: append-only, service-role-only OPERATOR
// audit log. Proves: service-role inserts work; normal authenticated users can
// neither READ nor WRITE it (RLS has NO policies); it is append-only; and it has
// no column for any secret/PII.

let a: SeededStudio;

beforeAll(async () => {
  a = await seedStudio("aae");
  // The app's only write path is the service-role helper; simulate it here.
  await adminQuery(
    `insert into public.admin_action_events
       (actor_user_id, actor_email, actor_role, studio_id, target_type, target_id, action, outcome, metadata)
     values ($1, $2, 'admin', $3, 'studio', $4, 'studio_created', 'succeeded', '{"slug":"aae"}'::jsonb)`,
    [a.userId, "operator@example.com", a.studioId, a.studioId],
  );
});
afterAll(async () => {
  await closePool();
});

describe("admin_action_events: service-role-only, append-only", () => {
  it("service-role insert persisted the event", async () => {
    const { rows } = await adminQuery(
      `select action, outcome from public.admin_action_events where studio_id = $1`,
      [a.studioId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("studio_created");
    expect(rows[0].outcome).toBe("succeeded");
  });

  it("a normal authenticated user CANNOT read it (RLS has no SELECT policy)", async () => {
    const res = await asUser(a.userId, (q) =>
      q(`select * from public.admin_action_events`),
    );
    expect(res.rowCount).toBe(0);
  });

  it("a normal authenticated user CANNOT insert (no INSERT policy/grant)", async () => {
    await expect(
      asUser(a.userId, (q) =>
        q(
          `insert into public.admin_action_events (target_type, action, outcome)
           values ('studio', 'studio_created', 'succeeded')`,
        ),
      ),
    ).rejects.toThrow();
  });

  it("a normal authenticated user CANNOT update or delete (append-only)", async () => {
    await expect(
      asUser(a.userId, (q) =>
        q(`update public.admin_action_events set outcome = 'failed'`),
      ),
    ).rejects.toThrow();
    await expect(
      asUser(a.userId, (q) => q(`delete from public.admin_action_events`)),
    ).rejects.toThrow();
  });

  it("has NO column for any secret/PII (token, url, ip, card, password, clinical)", async () => {
    const { rows } = await adminQuery(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='admin_action_events'`,
    );
    const cols = rows.map((r) => r.column_name as string);
    for (const forbidden of [
      "token",
      "secret",
      "password",
      "card",
      "cvc",
      "url",
      "cookie",
      "authorization",
      "ip",
      "intake",
      "clinical",
    ]) {
      expect(cols.some((c) => c.includes(forbidden))).toBe(false);
    }
  });
});
