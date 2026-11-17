import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// Team page: an owner restores a removed practitioner through the SAME locked command removal uses (set_practitioner_active_locked, p_active = true;
// no migration). This proves the database side the page depends on, on the real chain with synthetic data: restore returns the SAME row with the same
// role and name; access is gone while removed and back after restore (the V0-V7 removal boundary of the Roles proof, re-run here around the restore);
// the removed person's records are kept; the owner can read the removed roster through RLS (the page's query); and every refusal leaves the row removed.
afterAll(async () => {
  await closePool();
});

const asService = <T,>(fn: (q: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>) =>
  adminTx(async (q) => {
    await q("set local role service_role");
    const out = await fn(q as never);
    await q("reset role");
    return out;
  });
const setActive = (studioId: string, actor: string, target: string, active: boolean) =>
  asService((q) => q(`select public.set_practitioner_active_locked($1, $2, $3, $4) as r`, [studioId, actor, target, active])).then((r) => String((r as { rows: { r: unknown }[] }).rows[0].r));
const attempt = async <T,>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> => {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, message: String((e as Error).message) };
  }
};
const clientsSeenBy = async (userId: string, studioId: string) =>
  Number((await asUser(userId, (q) => q(`select count(*) n from public.clients where studio_id = $1`, [studioId]))).rows[0].n);
const rowOf = async (id: string) => (await adminQuery(`select id, role, display_name, email, user_id, active from public.practitioners where id = $1`, [id])).rows[0];

let A: SeededStudio;
let B: SeededStudio;
let pract: { userId: string; practitionerId: string };
let sessionId: string;

describe("Team: restore a removed practitioner", () => {
  it("setup: studio A (owner, practitioner, client), studio B (owner, client); the practitioner charts a session", async () => {
    A = await seedStudio("restore-a");
    B = await seedStudio("restore-b");
    pract = await seedMember(A, "restore-pract");
    expect(await clientsSeenBy(pract.userId, A.studioId)).toBe(1); // V0: access before removal
    const started = await asUser(pract.userId, (q) => q(`select * from public.start_session($1, 'laser', null, null, $2)`, [A.clientId, A.studioId]));
    sessionId = String(started.rows[0].session_id);
    expect(sessionId).toBeTruthy();
  });

  it("removal revokes access at once and keeps the records (V1-V5 around the same command)", async () => {
    expect(await setActive(A.studioId, A.practitionerId, pract.practitionerId, false)).toBe("ok");
    expect((await rowOf(pract.practitionerId)).active).toBe(false);
    expect(await clientsSeenBy(pract.userId, A.studioId)).toBe(0);
    const chart = await attempt(() => asUser(pract.userId, (q) => q(`select * from public.start_session($1, 'laser', null, null, $2)`, [A.clientId, A.studioId])));
    expect(chart.ok, "a removed practitioner cannot chart").toBe(false);
    expect(Number((await adminQuery(`select count(*) n from public.sessions where id = $1`, [sessionId])).rows[0].n)).toBe(1);
    expect(Number((await asUser(A.userId, (q) => q(`select count(*) n from public.sessions where id = $1`, [sessionId]))).rows[0].n)).toBe(1);
  });

  it("the page's query: the owner reads the removed roster through RLS (not an admin read), including the removed person", async () => {
    const seen = await asUser(A.userId, (q) => q(`select id, role, display_name, email from public.practitioners where studio_id = $1 and active = false order by display_name`, [A.studioId]));
    expect(seen.rows.map((r) => String(r.id))).toEqual([pract.practitionerId]);
  });

  it("another studio's owner cannot restore (or even see) studio A's removed practitioner, and nothing changes", async () => {
    const seenByB = await asUser(B.userId, (q) => q(`select id from public.practitioners where id = $1`, [pract.practitionerId]));
    expect(seenByB.rows.length).toBe(0);
    expect(await setActive(A.studioId, B.practitionerId, pract.practitionerId, true)).not.toBe("ok"); // B's owner is not A's owner
    expect(await setActive(B.studioId, B.practitionerId, pract.practitionerId, true)).toBe("invalid_practitioner"); // wrong studio for the target
    expect((await rowOf(pract.practitionerId)).active).toBe(false);
  });

  it("a non-owner cannot restore anyone (the command re-proves the owner), and the owner cannot be targeted", async () => {
    const peer = await seedMember(A, "restore-peer");
    expect(await setActive(A.studioId, peer.practitionerId, pract.practitionerId, true)).not.toBe("ok");
    expect((await rowOf(pract.practitionerId)).active).toBe(false);
    expect(await setActive(A.studioId, A.practitionerId, A.practitionerId, true)).toBe("cannot_modify_owner");
  });

  it("a receptionist conflict is refused by the database with a code the action maps to a sentence, and the row stays removed", async () => {
    const conflicted = await seedMember(A, "restore-conflict");
    expect(await setActive(A.studioId, A.practitionerId, conflicted.practitionerId, false)).toBe("ok");
    await adminQuery(`insert into public.studio_receptionists (studio_id, user_id, display_name, email, active) values ($1, $2, 'Synthetic', 'synthetic-restore@harness.local', true)`, [A.studioId, conflicted.userId]);
    const r = await attempt(() => setActive(A.studioId, A.practitionerId, conflicted.practitionerId, true));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("practitioner_is_active_receptionist");
    expect((await rowOf(conflicted.practitionerId)).active).toBe(false);
  });

  it("restore: the SAME row, role, name and email come back active; access returns; records and studio B are untouched (V6, V7)", async () => {
    const before = await rowOf(pract.practitionerId);
    expect(await setActive(A.studioId, A.practitionerId, pract.practitionerId, true)).toBe("ok");
    const after = await rowOf(pract.practitionerId);
    expect({ ...after, active: undefined }).toEqual({ ...before, active: undefined });
    expect(after.active).toBe(true);
    expect(after.role).toBe("practitioner");
    expect(await clientsSeenBy(pract.userId, A.studioId)).toBe(1);
    const again = await asUser(pract.userId, (q) => q(`select * from public.start_session($1, 'laser', null, null, $2)`, [A.clientId, A.studioId]));
    expect(again.rows.length).toBe(1); // can chart again
    expect(Number((await adminQuery(`select count(*) n from public.sessions where id = $1`, [sessionId])).rows[0].n)).toBe(1);
    expect(await clientsSeenBy(B.userId, B.studioId)).toBe(1);
  });

  it("restoring someone already active is harmless (idempotent) and a random id is invalid_practitioner", async () => {
    expect(await setActive(A.studioId, A.practitionerId, pract.practitionerId, true)).toBe("ok");
    expect((await rowOf(pract.practitionerId)).active).toBe(true);
    expect(await setActive(A.studioId, A.practitionerId, randomUUID(), true)).toBe("invalid_practitioner");
  });
});
