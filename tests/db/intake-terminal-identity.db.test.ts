import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, closePool, seedMember, seedStudio, userQuery, type SeededStudio } from "./helpers/harness";

// 0340 (HON-78): an intake cannot be moved to another client or studio (any state, any caller), and a submitted
// or reviewed one cannot be hidden or restored by a signed-in member using their own session against the table (the Data API path). Real migrated chain,
// synthetic placeholder answers only.

let A: SeededStudio; // owner of studio A, with clientId
let member: { userId: string; practitionerId: string }; // active non-owner practitioner of A
let B: SeededStudio; // another studio
let otherClient: string; // a second client of studio A

async function seedIntake(state: "in_progress" | "submitted" | "reviewed"): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.client_intake_forms (id, studio_id, client_id, status, responses, submitted_at, reviewed_at, reviewed_by)
     values ($1, $2, $3, $4, '{"q":"orig"}'::jsonb,
             case when $4 <> 'in_progress' then now() end,
             case when $4 = 'reviewed' then now() end,
             case when $4 = 'reviewed' then $5::uuid end)`,
    [id, A.studioId, A.clientId, state, A.practitionerId],
  );
  return id;
}
const stored = async (id: string) =>
  (await adminQuery(`select studio_id, client_id, deleted_at, status, responses from public.client_intake_forms where id = $1`, [id])).rows[0];

beforeAll(async () => {
  A = await seedStudio("intake-ident-a");
  member = await seedMember(A, "intake-ident-m");
  B = await seedStudio("intake-ident-b");
  otherClient = randomUUID();
  await adminQuery(`insert into public.clients (id, studio_id, name) values ($1, $2, 'Client intake-ident other')`, [otherClient, A.studioId]);
});
afterAll(async () => {
  await closePool();
});

const CHECK = "23514";
const RLS = "42501";
const code = (p: Promise<unknown>) => p.then(() => "no-error", (e: { code?: string }) => e.code ?? "no-code");

describe.each(["submitted", "reviewed"] as const)("0340: a %s intake keeps its client, studio and visibility", (state) => {
  it.each([
    ["the owner", () => A.userId],
    ["a non-owner practitioner", () => member.userId],
  ])("%s cannot re-point it to another client of the same studio; the row is unchanged", async (_who, uid) => {
    const id = await seedIntake(state);
    const before = await stored(id);
    expect(await code(userQuery(uid(), `update public.client_intake_forms set client_id = $2 where id = $1`, [id, otherClient]))).toBe(CHECK);
    expect(await stored(id)).toEqual(before);
  });

  it("a member cannot hide it (deleted_at), alone or bundled with a permitted notes edit", async () => {
    const id = await seedIntake(state);
    const before = await stored(id);
    expect(await code(userQuery(member.userId, `update public.client_intake_forms set deleted_at = now() where id = $1`, [id]))).toBe(CHECK);
    expect(await code(userQuery(member.userId, `update public.client_intake_forms set practitioner_notes = 'n', deleted_at = now() where id = $1`, [id]))).toBe(CHECK);
    expect(await stored(id)).toEqual(before);
  });

  it("a member cannot restore one that a trusted path hid", async () => {
    const id = await seedIntake(state);
    await adminQuery(`update public.client_intake_forms set deleted_at = now() where id = $1`, [id]);
    const before = await stored(id);
    expect(await code(userQuery(member.userId, `update public.client_intake_forms set deleted_at = null where id = $1`, [id]))).toBe(CHECK);
    expect(await stored(id)).toEqual(before);
  });

  it("a member cannot move it to another studio (guard or tenant policy; either way nothing is stored)", async () => {
    const id = await seedIntake(state);
    const before = await stored(id);
    expect([CHECK, RLS]).toContain(
      await code(userQuery(member.userId, `update public.client_intake_forms set studio_id = $2, client_id = $3 where id = $1`, [id, B.studioId, B.clientId])),
    );
    expect(await stored(id)).toEqual(before);
  });

  it("another studio's user and an anonymous caller change nothing", async () => {
    const id = await seedIntake(state);
    const before = await stored(id);
    const sql = `update public.client_intake_forms set client_id = $2, deleted_at = now() where id = $1`;
    expect((await userQuery(B.userId, sql, [id, otherClient])).rowCount).toBe(0);
    const anon = await asRole("anon", (q) => q(sql, [id, otherClient])).then((r) => r.rowCount, (e: { code?: string }) => e.code);
    expect([0, RLS]).toContain(anon);
    expect(await stored(id)).toEqual(before);
  });

  it("positive control: the permitted member edit still works and a no-op write of the same client passes", async () => {
    const id = await seedIntake(state);
    const r = await userQuery(member.userId, `update public.client_intake_forms set practitioner_notes = 'later note', client_id = $2 where id = $1`, [id, A.clientId]);
    expect(r.rowCount).toBe(1);
    expect((await adminQuery(`select practitioner_notes from public.client_intake_forms where id = $1`, [id])).rows[0].practitioner_notes).toBe("later note");
  });

  it("the service role keeps its trusted soft-delete (the 0118/0162 exemption) but cannot re-point the row either", async () => {
    const id = await seedIntake(state);
    const r = await asRole("service_role", (q) => q(`update public.client_intake_forms set deleted_at = now() where id = $1`, [id]));
    expect(r.rowCount).toBe(1);
    expect(await code(asRole("service_role", (q) => q(`update public.client_intake_forms set client_id = $2 where id = $1`, [id, otherClient])))).toBe(CHECK);
  });
});

describe("0340: what the guard does not change", () => {
  it("an in-progress intake cannot be re-pointed either (the 0160 lineage rule), but a member can still withdraw it", async () => {
    const id = await seedIntake("in_progress");
    expect(await code(userQuery(member.userId, `update public.client_intake_forms set client_id = $2 where id = $1`, [id, otherClient]))).toBe(CHECK);
    expect((await stored(id)).client_id).toBe(A.clientId);
    // deleted_at on a row the client has not submitted is outside this change
    expect((await userQuery(member.userId, `update public.client_intake_forms set deleted_at = now() where id = $1`, [id])).rowCount).toBe(1);
  });

  it("positive control: a member still reviews a submitted intake", async () => {
    const id = await seedIntake("submitted");
    const r = await userQuery(
      member.userId,
      `update public.client_intake_forms set status = 'reviewed', reviewed_at = now(), reviewed_by = $2 where id = $1`,
      [id, member.practitionerId],
    );
    expect(r.rowCount).toBe(1);
    expect((await stored(id)).status).toBe("reviewed");
  });

  it("both triggers sit beside the 0118/0162 guard and the new function is not executable by any API role", async () => {
    const t = await adminQuery(
      `select tgname from pg_trigger where tgrelid = 'public.client_intake_forms'::regclass and not tgisinternal
        and tgname in ('client_intake_forms_immutable_lineage', 'client_intake_forms_terminal_visibility', 'client_intake_forms_terminal_immutability') order by 1`,
    );
    expect(t.rows.map((r) => r.tgname)).toEqual([
      "client_intake_forms_immutable_lineage",
      "client_intake_forms_terminal_immutability",
      "client_intake_forms_terminal_visibility",
    ]);
    const p = await adminQuery(
      `select r from unnest(array['anon','authenticated','service_role']) r
        where has_function_privilege(r, 'public.enforce_intake_terminal_visibility()', 'execute')`,
    );
    expect(p.rows).toEqual([]);
  });
});
