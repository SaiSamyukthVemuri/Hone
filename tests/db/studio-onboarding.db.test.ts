import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  purgeAppointmentAudit,
  asRole,
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
    await purgeAppointmentAudit(s.studioId).catch(() => {});
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

// Findings 1+2 — completion is TRUSTED-SERVER-ONLY. admin_complete_onboarding /
// admin_mark_onboarding_celebrated are service-role commands (browser roles are
// denied) that verify active ownership + the flag and do an atomic CAS; a
// guard trigger blocks any direct browser write of the completion fields.
async function enableFlag(studioId: string): Promise<void> {
  // Service-role/superuser write — the flag guard only blocks browser roles.
  await adminQuery(
    `update public.studios set onboarding_v2_enabled = true where id = $1`,
    [studioId],
  );
}
// Trusted call: exercised via the admin (service-role) connection.
async function adminComplete(userId: string, studioId: string): Promise<boolean> {
  const r = await adminQuery(
    `select public.admin_complete_onboarding($1, $2) as t`,
    [userId, studioId],
  );
  return r.rows[0].t === true;
}
async function adminCelebrate(userId: string, studioId: string): Promise<boolean> {
  const r = await adminQuery(
    `select public.admin_mark_onboarding_celebrated($1, $2) as t`,
    [userId, studioId],
  );
  return r.rows[0].t === true;
}

describe("0140 — completion command is trusted-server-only + atomic", () => {
  it("anon / authenticated-member / authenticated-owner direct RPC are all DENIED", async () => {
    const s = await seedStudio("complete-deny");
    await enableFlag(s.studioId);
    const member = await seedMember(s, "deny-member");
    // anon.
    await expect(
      asRole("anon", (q) =>
        q(`select public.admin_complete_onboarding($1, $2)`, [
          s.userId,
          s.studioId,
        ]),
      ),
    ).rejects.toThrow(/permission denied|not allowed|42501/i);
    // authenticated member.
    await expect(
      userQuery(member.userId, `select public.admin_complete_onboarding($1, $2)`, [
        member.userId,
        s.studioId,
      ]),
    ).rejects.toThrow(/permission denied|not allowed|42501/i);
    // authenticated OWNER (the P1: an owner must not self-complete directly).
    await expect(
      userQuery(s.userId, `select public.admin_complete_onboarding($1, $2)`, [
        s.userId,
        s.studioId,
      ]),
    ).rejects.toThrow(/permission denied|not allowed|42501/i);
  });

  it("the trusted adapter owner call SUCCEEDS", async () => {
    const s = await seedStudio("complete-ok");
    await enableFlag(s.studioId);
    expect(await adminComplete(s.userId, s.studioId)).toBe(true);
    const row = await adminQuery(
      `select status, completed_at from public.studio_onboarding where studio_id=$1`,
      [s.studioId],
    );
    expect(row.rows[0].status).toBe("completed");
    expect(row.rows[0].completed_at).not.toBeNull();
  });

  it("a FORGED user/studio pairing fails (user is not an active owner)", async () => {
    const s = await seedStudio("complete-forge");
    await enableFlag(s.studioId);
    const stranger = await seedStudio("complete-forge-other"); // a different studio's owner
    await expect(
      adminQuery(`select public.admin_complete_onboarding($1, $2)`, [
        stranger.userId,
        s.studioId,
      ]),
    ).rejects.toThrow(/not an active owner|42501/i);
  });

  it("flag OFF fails even for the real owner via the trusted adapter", async () => {
    const s = await seedStudio("complete-flagoff"); // flag defaults OFF
    await expect(
      adminQuery(`select public.admin_complete_onboarding($1, $2)`, [
        s.userId,
        s.studioId,
      ]),
    ).rejects.toThrow(/not enabled|42501/i);
  });

  it("two CONCURRENT trusted calls -> exactly one transition, one stamp, one 'done'", async () => {
    const s = await seedStudio("complete-race");
    await enableFlag(s.studioId);
    const [a, b] = await Promise.all([
      adminComplete(s.userId, s.studioId),
      adminComplete(s.userId, s.studioId),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const row = await adminQuery(
      `select completed_at, completed_steps
         from public.studio_onboarding where studio_id=$1`,
      [s.studioId],
    );
    expect(row.rows[0].completed_at).not.toBeNull();
    expect(
      (row.rows[0].completed_steps as string[]).filter((x) => x === "done"),
    ).toHaveLength(1);
  });

  it("a repeat completion returns false and does NOT move completed_at", async () => {
    const s = await seedStudio("complete-repeat");
    await enableFlag(s.studioId);
    expect(await adminComplete(s.userId, s.studioId)).toBe(true);
    const first = await adminQuery(
      `select completed_at from public.studio_onboarding where studio_id=$1`,
      [s.studioId],
    );
    expect(await adminComplete(s.userId, s.studioId)).toBe(false);
    const second = await adminQuery(
      `select completed_at from public.studio_onboarding where studio_id=$1`,
      [s.studioId],
    );
    expect(second.rows[0].completed_at).toStrictEqual(first.rows[0].completed_at);
  });
});

describe("0140 — lifecycle fields are protected from direct browser writes", () => {
  // Seed a normal in-progress wizard row as the owner (allowed) so UPDATE cases
  // have a row to target.
  async function seedInProgress(): Promise<SeededStudio> {
    const s = await seedStudio("guard");
    await userQuery(
      s.userId,
      `insert into public.studio_onboarding (studio_id, current_step, status)
       values ($1, 'service', 'in_progress')`,
      [s.studioId],
    );
    return s;
  }

  it("owner direct INSERT seeding completed_at is REJECTED", async () => {
    const s = await seedStudio("guard-insert-completed");
    await expect(
      userQuery(
        s.userId,
        `insert into public.studio_onboarding (studio_id, completed_at)
         values ($1, now())`,
        [s.studioId],
      ),
    ).rejects.toThrow(/trusted-server-only|42501/i);
  });

  it("owner direct UPDATE setting completed_at is REJECTED", async () => {
    const s = await seedInProgress();
    await expect(
      userQuery(
        s.userId,
        `update public.studio_onboarding set completed_at = now() where studio_id=$1`,
        [s.studioId],
      ),
    ).rejects.toThrow(/trusted-server-only|42501/i);
  });

  it("owner direct UPDATE to status='completed' is REJECTED", async () => {
    const s = await seedInProgress();
    await expect(
      userQuery(
        s.userId,
        `update public.studio_onboarding set status = 'completed' where studio_id=$1`,
        [s.studioId],
      ),
    ).rejects.toThrow(/trusted-server-only|42501/i);
  });

  it("owner direct UPDATE setting celebrated_at is REJECTED", async () => {
    const s = await seedInProgress();
    await expect(
      userQuery(
        s.userId,
        `update public.studio_onboarding set celebrated_at = now() where studio_id=$1`,
        [s.studioId],
      ),
    ).rejects.toThrow(/trusted-server-only|42501/i);
  });

  it("owner direct write adding the 'done' completion marker is REJECTED", async () => {
    const s = await seedInProgress();
    await expect(
      userQuery(
        s.userId,
        `update public.studio_onboarding
            set completed_steps = completed_steps || array['done']::text[]
          where studio_id=$1`,
        [s.studioId],
      ),
    ).rejects.toThrow(/trusted-server-only|42501/i);
  });

  // --- Welcome-email lifecycle fields (Finding: extend the guard) -----------
  it("owner direct INSERT forging welcome_email_status='sent' is REJECTED", async () => {
    const s = await seedStudio("guard-we-insert-sent");
    await expect(
      userQuery(
        s.userId,
        `insert into public.studio_onboarding (studio_id, welcome_email_status)
         values ($1, 'sent')`,
        [s.studioId],
      ),
    ).rejects.toThrow(/trusted-server-only|42501/i);
  });

  it("owner direct INSERT forging welcome_email_status='sending' is REJECTED", async () => {
    const s = await seedStudio("guard-we-insert-sending");
    await expect(
      userQuery(
        s.userId,
        `insert into public.studio_onboarding (studio_id, welcome_email_status)
         values ($1, 'sending')`,
        [s.studioId],
      ),
    ).rejects.toThrow(/trusted-server-only|42501/i);
  });

  it("owner direct INSERT providing an attempt id / attempted / sent timestamp is REJECTED", async () => {
    const s = await seedStudio("guard-we-insert-attempt");
    await expect(
      userQuery(
        s.userId,
        `insert into public.studio_onboarding
           (studio_id, welcome_email_attempt_id, welcome_email_last_attempted_at, welcome_email_last_sent_at)
         values ($1, gen_random_uuid(), now(), now())`,
        [s.studioId],
      ),
    ).rejects.toThrow(/trusted-server-only|42501/i);
  });

  it("owner direct UPDATE changing welcome_email_status is REJECTED", async () => {
    const s = await seedInProgress();
    await expect(
      userQuery(
        s.userId,
        `update public.studio_onboarding set welcome_email_status = 'sent' where studio_id=$1`,
        [s.studioId],
      ),
    ).rejects.toThrow(/trusted-server-only|42501/i);
  });

  it("owner direct UPDATE setting / replacing / clearing welcome_email_attempt_id is REJECTED", async () => {
    // set from null
    const a = await seedInProgress();
    await expect(
      userQuery(
        a.userId,
        `update public.studio_onboarding set welcome_email_attempt_id = gen_random_uuid() where studio_id=$1`,
        [a.studioId],
      ),
    ).rejects.toThrow(/trusted-server-only|42501/i);
    // clearing an existing attempt id (seed one via the trusted claim first)
    const b = await seedStudio("guard-we-clear-attempt");
    await adminQuery(`select public.claim_welcome_email_attempt($1)`, [b.studioId]);
    await expect(
      userQuery(
        b.userId,
        `update public.studio_onboarding set welcome_email_attempt_id = null where studio_id=$1`,
        [b.studioId],
      ),
    ).rejects.toThrow(/trusted-server-only|42501/i);
  });

  it("owner direct UPDATE changing welcome_email_last_attempted_at is REJECTED", async () => {
    const s = await seedInProgress();
    await expect(
      userQuery(
        s.userId,
        `update public.studio_onboarding set welcome_email_last_attempted_at = now() where studio_id=$1`,
        [s.studioId],
      ),
    ).rejects.toThrow(/trusted-server-only|42501/i);
  });

  it("owner direct UPDATE changing welcome_email_last_sent_at is REJECTED", async () => {
    const s = await seedInProgress();
    await expect(
      userQuery(
        s.userId,
        `update public.studio_onboarding set welcome_email_last_sent_at = now() where studio_id=$1`,
        [s.studioId],
      ),
    ).rejects.toThrow(/trusted-server-only|42501/i);
  });

  it("the guard exception carries NO lifecycle value / email / id (role only)", async () => {
    const s = await seedInProgress();
    let msg = "";
    try {
      await userQuery(
        s.userId,
        `update public.studio_onboarding set welcome_email_status = 'sent' where studio_id=$1`,
        [s.studioId],
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/trusted-server-only/i);
    // No lifecycle value / studio id / email leaked into the error text.
    expect(msg).not.toMatch(/sent|sending|not_sent/);
    expect(msg).not.toContain(s.studioId);
    expect(msg).not.toMatch(/@/);
  });

  it("normal wizard navigation writes STILL succeed (current_step / skip / dismiss / reopen)", async () => {
    const s = await seedInProgress();
    await expect(
      userQuery(
        s.userId,
        `update public.studio_onboarding
            set current_step = 'booking',
                skipped_steps = array['payments']::text[],
                dismissed_at = now(),
                status = 'in_progress'
          where studio_id=$1`,
        [s.studioId],
      ),
    ).resolves.toBeDefined();
    // reopen (dismissed_at -> null) also works.
    await expect(
      userQuery(
        s.userId,
        `update public.studio_onboarding set dismissed_at = null where studio_id=$1`,
        [s.studioId],
      ),
    ).resolves.toBeDefined();
  });

  it("the trusted completion + celebration commands write the protected fields fine", async () => {
    const s = await seedStudio("guard-trusted");
    await enableFlag(s.studioId);
    expect(await adminComplete(s.userId, s.studioId)).toBe(true);
    // Trusted celebration stamps once; a second call is a no-op (false).
    expect(await adminCelebrate(s.userId, s.studioId)).toBe(true);
    expect(await adminCelebrate(s.userId, s.studioId)).toBe(false);
    const row = await adminQuery(
      `select completed_at, celebrated_at from public.studio_onboarding where studio_id=$1`,
      [s.studioId],
    );
    expect(row.rows[0].completed_at).not.toBeNull();
    expect(row.rows[0].celebrated_at).not.toBeNull();
  });

  it("celebration is service-role only + owner/flag gated (browser + forged/flag-off denied)", async () => {
    const s = await seedStudio("celebrate-deny");
    await enableFlag(s.studioId);
    // authenticated owner cannot call it directly.
    await expect(
      userQuery(s.userId, `select public.admin_mark_onboarding_celebrated($1, $2)`, [
        s.userId,
        s.studioId,
      ]),
    ).rejects.toThrow(/permission denied|not allowed|42501/i);
    // flag OFF studio, trusted adapter: refused.
    const off = await seedStudio("celebrate-flagoff");
    await expect(
      adminQuery(`select public.admin_mark_onboarding_celebrated($1, $2)`, [
        off.userId,
        off.studioId,
      ]),
    ).rejects.toThrow(/not enabled|42501/i);
  });
});
