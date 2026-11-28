import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, asRole, asUser, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// Platform rollout control: DB behaviour. While the proposal is unnumbered it is applied ONTO AN OWNED local stack once (skipped when numbered).
// Synthetic data only. The service-role commands run in a COMMITTING transaction (asRole rolls back).
const KEY = "charting_new_view_xcell";
const SQL_PATH = "supabase/migrations/0362_platform_rollout_control.sql";
const ACTOR = randomUUID();
const EMAIL = "operator@example.invalid";
let A: SeededStudio;
let B: SeededStudio;
const created: string[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = <T>(fn: (q: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, any>[] }>) => Promise<T>) =>
  adminTx(async (q) => {
    await q(`set local role service_role`);
    return fn(q);
  });
const setMode = (mode: string, actor = ACTOR, email = EMAIL, key = KEY) => svc(async (q) => (await q(`select public.set_platform_rollout_mode($1,$2,$3,$4) as r`, [key, mode, actor, email])).rows[0].r as string);
const add = (studio: string | null) => svc(async (q) => (await q(`select public.add_platform_rollout_studio($1,$2,$3,$4) as r`, [KEY, studio, ACTOR, EMAIL])).rows[0].r as string);
const remove = (studio: string) => svc(async (q) => (await q(`select public.remove_platform_rollout_studio($1,$2,$3,$4) as r`, [KEY, studio, ACTOR, EMAIL])).rows[0].r as string);
const enabled = (studio: string | null, key = KEY) => svc(async (q) => (await q(`select public.platform_rollout_enabled_for($1,$2) as r`, [key, studio])).rows[0].r as boolean);
const audit = () => adminQuery(`select actor_user_id, actor_email, actor_role, studio_id, target_type, target_id, action, outcome, metadata from public.admin_action_events where target_type='platform_rollout' order by created_at, id`).then((r) => r.rows);

beforeAll(async () => {
  const have = await adminQuery(`select to_regclass('public.platform_rollouts') as t`);
  if (!have.rows[0].t) await adminQuery(readFileSync(SQL_PATH, "utf8"));
  A = await seedStudio("rollout-a");
  B = await seedStudio("rollout-b");
  created.push(A.studioId, B.studioId);
  await adminQuery(`delete from public.platform_rollout_studios`);
  await adminQuery(`update public.platform_rollouts set mode='off', updated_by=null`);
});

afterAll(async () => {
  await adminQuery(`delete from public.platform_rollout_studios`).catch(() => undefined);
  await adminQuery(`update public.platform_rollouts set mode='off'`).catch(() => undefined);
  await adminQuery(`delete from public.admin_action_events where target_type='platform_rollout'`).catch(() => undefined);
  for (const id of created) await adminQuery(`delete from public.studios where id=$1`, [id]).catch(() => undefined);
  await closePool();
});

describe("the resolver (fails closed)", () => {
  it("is OFF for everyone by default, for an unknown key, and for a missing studio id", async () => {
    expect(await enabled(A.studioId)).toBe(false);
    expect(await enabled(B.studioId)).toBe(false);
    expect(await enabled(A.studioId, "no_such_key")).toBe(false);
    expect(await enabled(null)).toBe(false);
  });
  it("PILOT: true only for member studios; ALL: true for every studio, with or without membership; OFF again: false for all", async () => {
    expect(await setMode("pilot")).toBe("changed");
    expect(await enabled(A.studioId)).toBe(false);
    expect(await add(A.studioId)).toBe("added");
    expect(await enabled(A.studioId)).toBe(true);
    expect(await enabled(B.studioId)).toBe(false);
    expect(await setMode("all")).toBe("changed");
    expect(await enabled(B.studioId)).toBe(true);
    expect(await enabled(null)).toBe(false);
    expect(await setMode("off")).toBe("changed");
    expect(await enabled(A.studioId)).toBe(false);
    expect(await enabled(B.studioId)).toBe(false);
  });
  it("ALL then back to PILOT (and OFF then PILOT) KEEPS the member list", async () => {
    await setMode("all");
    await setMode("pilot");
    expect(await enabled(A.studioId)).toBe(true);
    expect(await enabled(B.studioId)).toBe(false);
    await setMode("off");
    await setMode("pilot");
    expect(await enabled(A.studioId)).toBe(true);
    expect(await remove(A.studioId)).toBe("removed");
    expect(await enabled(A.studioId)).toBe(false);
    await setMode("off");
  });
  it("deleting a pilot studio removes its membership (cascade)", async () => {
    const S = await seedStudio("rollout-del");
    await setMode("pilot");
    await add(S.studioId);
    expect((await adminQuery(`select count(*)::int n from public.platform_rollout_studios where studio_id=$1`, [S.studioId])).rows[0].n).toBe(1);
    await adminQuery(`delete from public.studios where id=$1`, [S.studioId]);
    expect((await adminQuery(`select count(*)::int n from public.platform_rollout_studios where studio_id=$1`, [S.studioId])).rows[0].n).toBe(0);
    await setMode("off");
  });
});

describe("only the service role can use any of it", () => {
  it("authenticated and anon cannot call a command or read either table; service_role cannot read the tables directly either", async () => {
    for (const fn of [`set_platform_rollout_mode('${KEY}','all','${ACTOR}','${EMAIL}')`, `add_platform_rollout_studio('${KEY}','${A.studioId}','${ACTOR}','${EMAIL}')`, `remove_platform_rollout_studio('${KEY}','${A.studioId}','${ACTOR}','${EMAIL}')`, `platform_rollout_enabled_for('${KEY}','${A.studioId}')`, `list_platform_rollout('${KEY}')`, `log_refused_platform_rollout_attempt('${ACTOR}','platform_rollout_mode_set')`]) {
      await expect(asUser(A.userId, (q) => q(`select public.${fn}`)), fn).rejects.toThrow(/permission denied/);
      await expect(asRole("anon", (q) => q(`select public.${fn}`)), fn).rejects.toThrow(/permission denied/);
    }
    for (const t of ["platform_rollouts", "platform_rollout_studios"]) {
      await expect(asUser(A.userId, (q) => q(`select * from public.${t}`))).rejects.toThrow(/permission denied/);
      await expect(asRole("anon", (q) => q(`select * from public.${t}`))).rejects.toThrow(/permission denied/);
      await expect(asRole("service_role", (q) => q(`select * from public.${t}`))).rejects.toThrow(/permission denied/);
    }
    await expect(asRole("service_role", (q) => q(`select public.platform_rollout_check_actor('${ACTOR}','${EMAIL}')`))).rejects.toThrow(/permission denied/);
  });
});

describe("commands refuse bad input and write nothing", () => {
  it.each([
    ["unknown mode", () => setMode("sometimes")],
    ["unknown key", () => setMode("all", ACTOR, EMAIL, "other_key")],
    ["no actor", () => setMode("all", null as never)],
    ["email with a space", () => setMode("all", ACTOR, "a b@example.invalid")],
    ["email with no @", () => setMode("all", ACTOR, "operator.example.invalid")],
    ["email too long", () => setMode("all", ACTOR, "a".repeat(250) + "@x.io")],
    ["email with a control char", () => setMode("all", ACTOR, "a\u0001b@example.invalid")],
  ])("%s", async (_n, call) => {
    const before = (await audit()).length;
    await expect(call()).rejects.toThrow();
    expect((await adminQuery(`select mode from public.platform_rollouts where key=$1`, [KEY])).rows[0].mode).toBe("off");
    expect((await audit()).length).toBe(before);
  });
  it("adding an unknown studio is not_found, a repeat add is exists, removing a non-member is absent: none writes an audit row", async () => {
    await setMode("pilot");
    const before = (await audit()).length;
    expect(await add(randomUUID())).toBe("not_found");
    expect(await add(null)).toBe("not_found");
    expect(await add(A.studioId)).toBe("added");
    const mid = (await audit()).length;
    expect(await add(A.studioId)).toBe("exists");
    expect(await remove(B.studioId)).toBe("absent");
    expect((await audit()).length).toBe(mid);
    expect(mid).toBe(before + 1);
    expect(await setMode("pilot")).toBe("unchanged");
    expect((await audit()).length).toBe(mid);
    await remove(A.studioId);
    await setMode("off");
  });
});

describe("the audit row", () => {
  it("one row per change with constant action/target_type, the actor id, and metadata of EXACTLY the allowed keys", async () => {
    await adminQuery(`delete from public.admin_action_events where target_type='platform_rollout'`);
    await setMode("pilot");
    await add(A.studioId);
    await remove(A.studioId);
    await setMode("all");
    const rows = await audit();
    expect(rows.map((r) => r.action)).toEqual(["platform_rollout_mode_set", "platform_rollout_studio_added", "platform_rollout_studio_removed", "platform_rollout_mode_set"]);
    for (const r of rows) {
      expect(r).toMatchObject({ actor_user_id: ACTOR, actor_email: EMAIL, actor_role: "admin", target_type: "platform_rollout", target_id: KEY, outcome: "succeeded" });
    }
    expect(Object.keys(rows[0].metadata).sort()).toEqual(["mode_after", "mode_before"]);
    expect(rows[0].metadata).toEqual({ mode_before: "off", mode_after: "pilot" });
    expect(Object.keys(rows[1].metadata)).toEqual(["studio_id"]);
    expect(rows[1].metadata.studio_id).toBe(A.studioId);
    expect(rows[1].studio_id).toBe(A.studioId);
    expect(rows[3].metadata).toEqual({ mode_before: "pilot", mode_after: "all" });
    expect((await adminQuery(`select updated_by from public.platform_rollouts where key=$1`, [KEY])).rows[0].updated_by).toBe(ACTOR); // a user id, never an email
    await setMode("off");
  });
  it("a blocked non-admin attempt: user id only, ONE row per user per action per 10 minutes, none for an unknown action or no user", async () => {
    await adminQuery(`delete from public.admin_action_events where target_type='platform_rollout'`);
    const user = randomUUID();
    const log = (u: string | null, a: string) => svc(async (q) => (await q(`select public.log_refused_platform_rollout_attempt($1,$2) as r`, [u, a])).rows[0].r as boolean);
    expect(await log(user, "platform_rollout_mode_set")).toBe(true);
    for (let i = 0; i < 5; i++) expect(await log(user, "platform_rollout_mode_set")).toBe(false);
    expect(await log(user, "platform_rollout_studio_added")).toBe(true); // a different action is its own bucket
    expect(await log(randomUUID(), "platform_rollout_mode_set")).toBe(true); // a different user too
    expect(await log(null, "platform_rollout_mode_set")).toBe(false);
    expect(await log(user, "something_else")).toBe(false);
    const rows = await audit();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ outcome: "blocked", actor_email: null, metadata: {} });
    // after the window a new row is allowed again
    await adminQuery(`update public.admin_action_events set created_at = now() - interval '11 minutes' where target_type='platform_rollout' and actor_user_id=$1`, [user]);
    expect(await log(user, "platform_rollout_mode_set")).toBe(true);
  });
  it("concurrent blocked attempts by one user still write only one row", async () => {
    await adminQuery(`delete from public.admin_action_events where target_type='platform_rollout'`);
    const user = randomUUID();
    const log = () => svc(async (q) => (await q(`select public.log_refused_platform_rollout_attempt($1,'platform_rollout_mode_set') as r`, [user])).rows[0].r as boolean);
    const results = await Promise.all([log(), log(), log(), log()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await audit()).length).toBe(1);
  });
});

describe("INVARIANT: switching the rollout never creates, edits or retires a machine, reading, capture or block", () => {
  it("row counts and content hashes of the studio-facing tables are identical across off, pilot, all, member changes and back", async () => {
    const m = randomUUID();
    await adminQuery(`insert into public.studio_machines (id, studio_id, machine_profile_id, machine_profile_version, display_name) values ($1,$2,'dectro-apilus:senior-3g',3,'Synthetic unit')`, [m, A.studioId]);
    const tables = ["studio_machines", "treatment_setup_readings", "treatment_setup_captures", "treatment_setup_submissions", "session_blocks", "block_write_receipts", "sessions", "clients", "practitioners", "studios"];
    const snap = async () => {
      const out: Record<string, string> = {};
      for (const t of tables) out[t] = (await adminQuery(`select count(*)::text || ':' || coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)), '') as h from public.${t} x`)).rows[0].h;
      return out;
    };
    const before = await snap();
    for (const step of [() => setMode("pilot"), () => add(A.studioId), () => add(B.studioId), () => setMode("all"), () => remove(B.studioId), () => setMode("off"), () => setMode("pilot"), () => remove(A.studioId), () => setMode("off")]) await step();
    expect(await snap()).toEqual(before);
    await adminQuery(`delete from public.studio_machines where id=$1`, [m]);
  });
});

describe("admin read", () => {
  it("returns the mode, who set it (user id), and the pilot studios by NAME in one call, and an empty-membership row when there are none", async () => {
    await setMode("pilot");
    await add(A.studioId);
    const rows = await svc(async (q) => (await q(`select * from public.list_platform_rollout($1)`, [KEY])).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: "pilot", updated_by: ACTOR, studio_id: A.studioId, added_by: ACTOR });
    expect(typeof rows[0].studio_name).toBe("string");
    await remove(A.studioId);
    const none = await svc(async (q) => (await q(`select * from public.list_platform_rollout($1)`, [KEY])).rows);
    expect(none).toHaveLength(1);
    expect(none[0].studio_id).toBeNull();
    await setMode("off");
  });
});

describe("rollback", () => {
  it("is REFUSED while a mode is live or a pilot row exists, and drops cleanly once Off with no pilots", async () => {
    const RB = readFileSync("supabase/rollbacks/0362_platform_rollout_control.down.sql", "utf8");
    await setMode("pilot");
    await expect(adminQuery(RB)).rejects.toThrow(/REFUSED/);
    await add(A.studioId);
    await setMode("off");
    await expect(adminQuery(RB)).rejects.toThrow(/REFUSED/); // off but a pilot row remains
    await remove(A.studioId);
    await adminQuery(RB);
    expect((await adminQuery(`select to_regclass('public.platform_rollouts') as t`)).rows[0].t).toBeNull();
    await adminQuery(readFileSync(SQL_PATH, "utf8")); // re-apply so later suites on this stack still find it
    // The replay recreated the table as 0362 made it. When 0394 is on this stack (the split_payments key and its refusal of mode 'all'), put back
    // exactly what 0394 adds to this table, or every later file that switches a studio on finds no 'split_payments' row.
    if ((await adminQuery(`select to_regprocedure('public.ensure_visit_bill(uuid,uuid,integer,text,boolean)') as f`)).rows[0].f) {
      await adminQuery(`alter table public.platform_rollouts drop constraint platform_rollouts_key_check;
        alter table public.platform_rollouts add constraint platform_rollouts_key_check check (key in ('charting_new_view_xcell', 'front_desk', 'split_payments'));
        alter table public.platform_rollouts add constraint platform_rollouts_split_payments_mode_check check (key <> 'split_payments' or mode in ('off', 'pilot'));
        insert into public.platform_rollouts (key) values ('split_payments') on conflict do nothing;`);
    }
  });
});
