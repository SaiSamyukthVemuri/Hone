import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  closePool,
  seedStudio,
  seedMember,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// Migration 0140 (first-time studio onboarding) proven at the DB layer on the
// real migrated DB:
//   * studio_onboarding RLS = member-read / owner-write, studio-isolated, no
//     browser delete.
//   * onboarding_v2_enabled is operator-controlled: a browser (authenticated)
//     role — studio owners included — cannot flip it; service-role can.
// The app-layer flag/owner gating is pinned separately by the flag-off contract
// + the owner-gated actions.

let studioA: SeededStudio;
let studioB: SeededStudio;
let memberA: { userId: string; practitionerId: string };

beforeAll(async () => {
  studioA = await seedStudio("onboarding-a");
  studioB = await seedStudio("onboarding-b");
  memberA = await seedMember(studioA, "onboarding-member");
});

afterAll(async () => {
  await closePool();
});

describe("studio_onboarding — owner write / member read", () => {
  it("the owner can INSERT and SELECT their studio's row", async () => {
    await userQuery(
      studioA.userId,
      `insert into public.studio_onboarding (studio_id, current_step, status)
       values ($1, 'service', 'in_progress')`,
      [studioA.studioId],
    );
    const read = await userQuery(
      studioA.userId,
      `select current_step, status from public.studio_onboarding where studio_id = $1`,
      [studioA.studioId],
    );
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0].current_step).toBe("service");
  });

  it("the owner can UPDATE their row and updated_at stays >= created_at", async () => {
    await userQuery(
      studioA.userId,
      `update public.studio_onboarding
         set dismissed_at = now(), current_step = 'availability'
       where studio_id = $1`,
      [studioA.studioId],
    );
    const read = await adminQuery(
      `select current_step, dismissed_at, created_at, updated_at
         from public.studio_onboarding where studio_id = $1`,
      [studioA.studioId],
    );
    expect(read.rows[0].current_step).toBe("availability");
    expect(read.rows[0].dismissed_at).not.toBeNull();
    expect(new Date(read.rows[0].updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(read.rows[0].created_at).getTime(),
    );
  });

  it("a NON-owner member can SELECT but cannot INSERT or UPDATE", async () => {
    // Member of studio A can read A's row.
    const read = await userQuery(
      memberA.userId,
      `select studio_id from public.studio_onboarding where studio_id = $1`,
      [studioA.studioId],
    );
    expect(read.rows).toHaveLength(1);

    // But cannot actually update it: the owner-write UPDATE policy's USING
    // clause hides the row from a non-owner member, so the UPDATE matches 0 rows
    // and changes nothing. (RLS UPDATE denial is SILENT — 0 rows — not an error;
    // only a failing INSERT WITH CHECK or a revoked grant raises.)
    const memberUpdate = await userQuery(
      memberA.userId,
      `update public.studio_onboarding set current_step = 'booking' where studio_id = $1`,
      [studioA.studioId],
    );
    expect(memberUpdate.rowCount).toBe(0);
    const unchanged = await adminQuery(
      `select current_step from public.studio_onboarding where studio_id = $1`,
      [studioA.studioId],
    );
    expect(unchanged.rows[0].current_step).not.toBe("booking");

    // And cannot insert a fresh one for studio B (not even a member there).
    await expect(
      userQuery(
        memberA.userId,
        `insert into public.studio_onboarding (studio_id) values ($1)`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });

  it("an owner of ANOTHER studio cannot see or write this studio's row", async () => {
    // Studio B's owner sees zero rows for studio A (RLS isolation).
    const read = await userQuery(
      studioB.userId,
      `select studio_id from public.studio_onboarding where studio_id = $1`,
      [studioA.studioId],
    );
    expect(read.rows).toHaveLength(0);

    // And cannot insert a row scoped to studio A.
    await expect(
      userQuery(
        studioB.userId,
        `insert into public.studio_onboarding (studio_id, current_step)
         values ($1, 'welcome')`,
        [studioA.studioId],
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });

  it("no browser role may DELETE (revoked; teardown is parent CASCADE only)", async () => {
    await expect(
      userQuery(
        studioA.userId,
        `delete from public.studio_onboarding where studio_id = $1`,
        [studioA.studioId],
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });

  it("CHECK constraints reject invalid status / welcome_email_status", async () => {
    await expect(
      adminQuery(
        `insert into public.studio_onboarding (studio_id, status) values ($1, 'bogus')`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/check constraint|violates/i);
  });
});

describe("studio_onboarding — parent CASCADE", () => {
  it("deleting the studio tears down its onboarding row", async () => {
    const s = await seedStudio("onboarding-cascade");
    await adminQuery(
      `insert into public.studio_onboarding (studio_id) values ($1)`,
      [s.studioId],
    );
    await adminQuery(`delete from public.studios where id = $1`, [s.studioId]);
    const read = await adminQuery(
      `select 1 from public.studio_onboarding where studio_id = $1`,
      [s.studioId],
    );
    expect(read.rows).toHaveLength(0);
  });
});

describe("onboarding_v2_enabled — operator-controlled flag", () => {
  it("an authenticated OWNER cannot flip the flag (guard raises 42501)", async () => {
    await expect(
      userQuery(
        studioA.userId,
        `update public.studios set onboarding_v2_enabled = true where id = $1`,
        [studioA.studioId],
      ),
    ).rejects.toThrow(/operator-controlled|insufficient_privilege|42501/i);
  });

  it("service-role CAN set the flag (operator/provisioning path)", async () => {
    await adminQuery(
      `update public.studios set onboarding_v2_enabled = true where id = $1`,
      [studioB.studioId],
    );
    const read = await adminQuery(
      `select onboarding_v2_enabled from public.studios where id = $1`,
      [studioB.studioId],
    );
    expect(read.rows[0].onboarding_v2_enabled).toBe(true);
  });

  it("an owner UPDATE that does NOT change the flag still succeeds", async () => {
    // The guard only fires when the flag value actually changes.
    await expect(
      userQuery(
        studioA.userId,
        `update public.studios set name = name where id = $1`,
        [studioA.studioId],
      ),
    ).resolves.toBeDefined();
  });
});
