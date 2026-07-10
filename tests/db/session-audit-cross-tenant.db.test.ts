import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asUser,
  closePool,
  seedSession,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// Migration 0117: the session_audit INSERT policy must reject a cross-tenant
// write. Proven on the REAL migrated local DB: a Studio A member cannot insert
// an audit row for a Studio B session, while same-studio audit recording still
// works, actor/session are bound to the caller, and read/immutability posture
// is unchanged. Uses only non-clinical placeholder values.

let A: SeededStudio;
let B: SeededStudio;
let sessionA: string;
let sessionB: string;

// Insert a session_audit row as `userId`, attributing to `editedBy`, for
// `sessionId`. Placeholder field/values only (no clinical data).
function insertAudit(userId: string, sessionId: string, editedBy: string) {
  return userQuery(
    userId,
    `insert into public.session_audit
       (session_id, edited_by_practitioner_id, field, old_value, new_value)
     values ($1, $2, 'started_at', 'x', 'y')`,
    [sessionId, editedBy],
  );
}

beforeAll(async () => {
  A = await seedStudio("saxt-a");
  B = await seedStudio("saxt-b");
  sessionA = (await seedSession(A)).sessionId;
  sessionB = (await seedSession(B)).sessionId;
});

afterAll(async () => {
  await closePool();
});

describe("0117: session_audit INSERT is studio-bound (no cross-tenant write)", () => {
  it("1. Studio A member CANNOT insert an audit row for a Studio B session", async () => {
    await expect(
      insertAudit(A.userId, sessionB, A.practitionerId),
    ).rejects.toThrow(); // WITH CHECK: session not in caller's studio
    // No row landed on Studio B's session.
    const check = await adminQuery(
      `select count(*)::int as n from public.session_audit where session_id = $1`,
      [sessionB],
    );
    expect(check.rows[0].n).toBe(0);
  });

  it("2. Studio A member CAN insert an audit row for a Studio A session (approved path)", async () => {
    const before = await adminQuery(
      `select count(*)::int as n from public.session_audit where session_id = $1`,
      [sessionA],
    );
    await insertAudit(A.userId, sessionA, A.practitionerId); // must succeed
    const after = await adminQuery(
      `select count(*)::int as n from public.session_audit where session_id = $1`,
      [sessionA],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it("3. a non-member (no practitioner row) CANNOT insert", async () => {
    await expect(
      insertAudit(randomUUID(), sessionA, A.practitionerId),
    ).rejects.toThrow();
  });

  it("4. an INACTIVE practitioner CANNOT insert", async () => {
    const inactiveUser = randomUUID();
    const inactivePractitioner = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
      inactiveUser,
      `inactive-${inactiveUser.slice(0, 8)}@harness.local`,
    ]);
    await adminQuery(
      `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
       values ($1, $2, $3, 'Inactive', $4, 'practitioner', false)`,
      [
        inactivePractitioner,
        A.studioId,
        inactiveUser,
        `inactive-${inactiveUser.slice(0, 8)}@harness.local`,
      ],
    );
    await expect(
      insertAudit(inactiveUser, sessionA, inactivePractitioner),
    ).rejects.toThrow();
  });

  it("5. actor identity cannot be forged (edited_by = a foreign practitioner)", async () => {
    // Studio A member tries to attribute the event to Studio B's practitioner.
    await expect(
      insertAudit(A.userId, sessionA, B.practitionerId),
    ).rejects.toThrow();
  });

  it("6. there is no studio_id column on session_audit to forge (Option A binds via session)", async () => {
    const res = await adminQuery(
      `select count(*)::int as n from information_schema.columns
        where table_schema='public' and table_name='session_audit' and column_name='studio_id'`,
    );
    expect(res.rows[0].n).toBe(0);
  });
});

describe("0117: read + immutability posture unchanged", () => {
  it("7/9. a Studio B member can read a valid (historical) audit row for their session", async () => {
    const id = randomUUID();
    await adminQuery(
      `insert into public.session_audit (id, session_id, edited_by_practitioner_id, field, old_value, new_value)
       values ($1, $2, $3, 'started_at', 'x', 'y')`,
      [id, sessionB, B.practitionerId],
    );
    const read = await userQuery(
      B.userId,
      `select id from public.session_audit where id = $1`,
      [id],
    );
    expect(read.rowCount).toBe(1);
  });

  it("8. Studio A cannot read Studio B audit rows", async () => {
    const id = randomUUID();
    await adminQuery(
      `insert into public.session_audit (id, session_id, edited_by_practitioner_id, field, old_value, new_value)
       values ($1, $2, $3, 'started_at', 'x', 'y')`,
      [id, sessionB, B.practitionerId],
    );
    const read = await userQuery(
      A.userId,
      `select id from public.session_audit where id = $1`,
      [id],
    );
    expect(read.rowCount).toBe(0);
  });

  it("10. UPDATE and DELETE remain blocked (no policy → default-deny); row survives", async () => {
    const id = randomUUID();
    await adminQuery(
      `insert into public.session_audit (id, session_id, edited_by_practitioner_id, field, old_value, new_value)
       values ($1, $2, $3, 'started_at', 'orig', 'y')`,
      [id, sessionB, B.practitionerId],
    );
    const upd = await userQuery(
      B.userId,
      `update public.session_audit set new_value = 'tampered' where id = $1`,
      [id],
    );
    expect(upd.rowCount).toBe(0);
    const del = await userQuery(
      B.userId,
      `delete from public.session_audit where id = $1`,
      [id],
    );
    expect(del.rowCount).toBe(0);
    // Row survives, unchanged.
    const survive = await adminQuery(
      `select old_value from public.session_audit where id = $1`,
      [id],
    );
    expect(survive.rowCount).toBe(1);
    expect(survive.rows[0].old_value).toBe("orig");
  });
});
