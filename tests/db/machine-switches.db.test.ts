import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, asRole, asUser, closePool, seedMember, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";

// Machine switches: the DB behaviour of the settings tables, the owner and lazy-unit commands, the seed, and the amended identity command.
// Synthetic data only. While the SQL is unnumbered this applies it onto an OWNED local stack once; when numbered it is part of the chain.
const SQL_PATH = "docs/proposals/machine-switches.sql";
const KEY = "charting_new_view_xcell";
const PUR = "dectro-apilus:xcell-pur";
const SEN = "dectro-apilus:senior-3g";
const JUN = "dectro-apilus:junior-3g";
const LEGACY = "dectro-apilus:xcell";

let A: SeededStudio; // owner A
let B: SeededStudio; // another studio
let memA: { userId: string; practitionerId: string }; // a practitioner member of A
let recept: string; // a user with no practitioner row (a receptionist has none)

const setRollout = (mode: "off" | "pilot" | "all") =>
  adminQuery(`update public.platform_rollouts set mode = $1, updated_at = now() where key = $2`, [mode, KEY]);
const failure = async (p: Promise<unknown>) => {
  try { await p; return null; } catch (e) { return e as { message: string; code?: string }; }
};
const setModel = (user: string, studio: string, profile: string, on: boolean) =>
  asUser(user, async (q) => (await q(`select public.set_studio_machine_model($1,$2,$3) as r`, [studio, profile, on])).rows[0].r as string);
const setDefault = (user: string, studio: string, profile: string | null, ask: boolean) =>
  asUser(user, async (q) => (await q(`select public.set_studio_machine_default($1,$2,$3) as r`, [studio, profile, ask])).rows[0].r as string);
const choices = (user: string) =>
  asUser(user, async (q) => (await q(`select * from public.get_studio_machine_choices()`)).rows as { studio_id: string; profile_id: string; is_default: boolean; ask_each_visit: boolean; live_unit_id: string | null }[]);
const ensure = (user: string, block: string, profile: string) =>
  asUser(user, async (q) => (await q(`select public.ensure_studio_machine_for_save($1,$2) as r`, [block, profile])).rows[0].r as string);
const models = async (studio: string) =>
  Object.fromEntries((await adminQuery(`select profile_id, enabled from public.studio_machine_models where studio_id=$1`, [studio])).rows.map((r: { profile_id: string; enabled: boolean }) => [r.profile_id, r.enabled]));
const dflt = async (studio: string) => (await adminQuery(`select default_profile_id, ask_each_visit from public.studio_machine_default where studio_id=$1`, [studio])).rows[0] as { default_profile_id: string | null; ask_each_visit: boolean };
const eventCount = async (studio: string, kind?: string) =>
  Number((await adminQuery(`select count(*)::int n from public.studio_machine_setting_events where studio_id=$1 and ($2::text is null or kind=$2)`, [studio, kind ?? null])).rows[0].n);
const identity = (block: string, studio: string, profile: string | null, unit: string | null, mode: string | null) =>
  adminQuery(`select public.apply_block_machine_identity($1,$2,$3,$4,$5) as r`, [block, studio, profile, unit, mode]);
const blockIdentity = async (block: string) =>
  (await adminQuery(`select machine_profile_id, studio_machine_id, machine_mode_key from public.session_blocks where id=$1`, [block])).rows[0] as { machine_profile_id: string | null; studio_machine_id: string | null; machine_mode_key: string | null };
const setLegacyMode = (block: string) => adminTx(async (q) => { await q(`set local session_replication_role = replica`); await q(`update public.session_blocks set mode = 'thermolysis' where id = $1`, [block]); });
const unitOf = async (studio: string, profile: string, version = 1) =>
  (await adminQuery(`insert into public.studio_machines (studio_id, machine_profile_id, machine_profile_version, display_name) values ($1,$2,$3,$4) returning id`, [studio, profile, version, `Unit ${randomUUID().slice(0, 8)}`])).rows[0].id as string;

beforeAll(async () => {
  const have = await adminQuery(`select to_regprocedure('public.set_studio_machine_model(uuid,text,boolean)') as p`);
  if (!have.rows[0].p) await adminQuery(readFileSync(SQL_PATH, "utf8"));
  await adminQuery(`insert into public.machine_profile_mode_contract (machine_profile_id, machine_profile_version, mode_key) values ($1,1,'multiplex') on conflict do nothing`, [PUR]);
  await adminQuery(`insert into public.machine_profile_mode_contract (machine_profile_id, machine_profile_version, mode_key) values ($1,3,'flash') on conflict do nothing`, [SEN]);
  A = await seedStudio("sw-a");
  B = await seedStudio("sw-b");
  memA = await seedMember(A, "sw-ma");
  recept = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [recept, `sw-r-${recept.slice(0, 8)}@harness.local`]);
  await setRollout("all");
});

afterAll(async () => {
  await setRollout("off");
  await closePool();
});

describe("the seed: once, by a trigger on studios, never re-run", () => {
  it("a studio created by ANY path is seeded: xCell Pur on and the default, Senior and Junior off", async () => {
    expect(await models(A.studioId)).toEqual({ [PUR]: true, [SEN]: false, [JUN]: false });
    expect(await dflt(A.studioId)).toEqual({ default_profile_id: PUR, ask_each_visit: false });
  });

  it("re-running the seed changes nothing, and a model the owner turned off STAYS off", async () => {
    expect(await setModel(A.userId, A.studioId, PUR, false)).toBe("changed");
    await adminQuery(`select public.seed_studio_machine_settings($1)`, [A.studioId]);
    expect((await models(A.studioId))[PUR]).toBe(false);
    expect(await setModel(A.userId, A.studioId, PUR, true)).toBe("changed");
    expect(await setDefault(A.userId, A.studioId, PUR, false)).toBe("changed"); // turning the default model off had repaired the default to Ask
  });

  it("Senior and Junior are seeded ON exactly where the studio already has a live unit of that model", async () => {
    const S = await seedStudio("sw-seedunits");
    await unitOf(S.studioId, SEN, 3);
    const retired = await unitOf(S.studioId, JUN, 3);
    await adminQuery(`update public.studio_machines set retired_at = now() where id = $1`, [retired]);
    await adminQuery(`delete from public.studio_machine_models where studio_id=$1`, [S.studioId]);
    await adminQuery(`delete from public.studio_machine_default where studio_id=$1`, [S.studioId]);
    await adminQuery(`select public.seed_studio_machine_settings($1)`, [S.studioId]);
    expect(await models(S.studioId)).toEqual({ [PUR]: true, [SEN]: true, [JUN]: false });
  });

  it("registering a Senior unit LATER does not switch the model on", async () => {
    await unitOf(A.studioId, SEN, 3);
    expect((await models(A.studioId))[SEN]).toBe(false);
  });
});

describe("owner commands", () => {
  it("only an active owner of THAT studio may write; another studio's id and a nonexistent id give the SAME refusal (no existence oracle)", async () => {
    const other = await failure(setModel(B.userId, A.studioId, PUR, false));
    const nowhere = await failure(setModel(B.userId, randomUUID(), PUR, false));
    const member = await failure(setModel(memA.userId, A.studioId, PUR, false));
    const rec = await failure(setModel(recept, A.studioId, PUR, false));
    for (const e of [other, nowhere, member, rec]) expect(e?.message).toBe("Not available.");
    expect(other?.code).toBe(nowhere?.code);
    const d1 = await failure(setDefault(B.userId, A.studioId, PUR, false));
    const d2 = await failure(setDefault(B.userId, randomUUID(), PUR, false));
    expect(d1?.message).toBe("Not available.");
    expect(d2?.message).toBe(d1?.message);
    expect((await models(A.studioId))[PUR]).toBe(true);
  });

  it("anon and a bare authenticated role without the command's owner check cannot reach the tables directly", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      for (const t of ["studio_machine_models", "studio_machine_default", "studio_machine_setting_events"]) {
        const e = await failure(asRole(role, (q) => q(`select * from public.${t} limit 1`)));
        expect(e?.message, `${role} ${t}`).toMatch(/permission denied/);
      }
    }
    const e = await failure(asRole("anon", (q) => q(`select public.set_studio_machine_model($1,$2,true)`, [A.studioId, PUR])));
    expect(e?.message).toMatch(/permission denied/);
  });

  it("turning the DEFAULT model off repairs the default to the next enabled model, else Ask, and records both changes by user id", async () => {
    const S = await seedStudio("sw-repair");
    expect(await setModel(S.userId, S.studioId, SEN, true)).toBe("changed");
    expect(await setModel(S.userId, S.studioId, PUR, false)).toBe("changed");
    expect(await dflt(S.studioId)).toEqual({ default_profile_id: SEN, ask_each_visit: false });
    expect(await setModel(S.userId, S.studioId, SEN, false)).toBe("changed");
    expect(await dflt(S.studioId)).toEqual({ default_profile_id: null, ask_each_visit: true });
    const ev = (await adminQuery(`select kind, actor_user_id, value from public.studio_machine_setting_events where studio_id=$1 order by id`, [S.studioId])).rows as { kind: string; actor_user_id: string; value: unknown }[];
    expect(ev.map((e) => e.kind)).toEqual(["model_set", "model_set", "default_set", "model_set", "default_set"]);
    for (const e of ev) expect(e.actor_user_id).toBe(S.userId);
    expect(JSON.stringify(ev)).not.toMatch(/@/);
    expect(await setModel(S.userId, S.studioId, SEN, false)).toBe("unchanged");
    expect(await eventCount(S.studioId)).toBe(5);
  });

  it("the default must be a model that is switched on; Ask and a model are exclusive; bad arguments are refused", async () => {
    const S = await seedStudio("sw-default");
    expect((await failure(setDefault(S.userId, S.studioId, SEN, false)))?.message).toMatch(/switched on/);
    expect(await setDefault(S.userId, S.studioId, null, true)).toBe("changed");
    expect(await dflt(S.studioId)).toEqual({ default_profile_id: null, ask_each_visit: true });
    expect(await setDefault(S.userId, S.studioId, PUR, false)).toBe("changed");
    expect((await failure(setDefault(S.userId, S.studioId, PUR, true)))?.message).toBe("Not available.");
    expect((await failure(setDefault(S.userId, S.studioId, null, false)))?.message).toBe("Not available.");
    expect((await failure(setModel(S.userId, S.studioId, "dectro-apilus:bogus", true)))?.message).toBe("Not available.");
  });

  it("with the rollout OFF the commands refuse and the choices read returns nothing", async () => {
    await setRollout("off");
    try {
      expect((await failure(setModel(A.userId, A.studioId, PUR, true)))?.message).toMatch(/not available yet/);
      expect((await failure(setDefault(A.userId, A.studioId, null, true)))?.message).toMatch(/not available yet/);
      expect(await choices(A.userId)).toEqual([]);
    } finally { await setRollout("all"); }
  });
});

describe("get_studio_machine_choices: no argument, the caller's own studios, the minimum", () => {
  it("an owner and a practitioner member see their own studio's enabled models and default; a receptionist and another studio see none of it", async () => {
    const own = await choices(memA.userId);
    expect(own.every((r) => r.studio_id === A.studioId)).toBe(true);
    expect(own.find((r) => r.profile_id === PUR)).toMatchObject({ is_default: true, ask_each_visit: false });
    expect(own.find((r) => r.profile_id === JUN)).toBeUndefined();
    expect(await choices(recept)).toEqual([]);
    expect((await choices(B.userId)).every((r) => r.studio_id === B.studioId)).toBe(true);
    const cols = Object.keys(own[0]);
    expect(cols.sort()).toEqual(["ask_each_visit", "is_default", "live_unit_id", "profile_id", "studio_id"]);
    const fnArgs = (await adminQuery(`select pronargs from pg_proc where proname='get_studio_machine_choices'`)).rows[0].pronargs;
    expect(Number(fnArgs)).toBe(0);
  });
});

describe("ensure_studio_machine_for_save: lazy, idempotent, bound to a real block", () => {
  it("creates one unit the first time, reuses it after, writes one event with the actor, and the switch alone created nothing", async () => {
    const S = await seedStudio("sw-ensure");
    const sess = await seedSession(S);
    const before = Number((await adminQuery(`select count(*)::int n from public.studio_machines where studio_id=$1`, [S.studioId])).rows[0].n);
    expect(before).toBe(0);
    const id = await ensure(S.userId, sess.blockId, PUR);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await ensure(S.userId, sess.blockId, PUR)).toBe(id);
    const u = (await adminQuery(`select display_name, machine_profile_version from public.studio_machines where id=$1`, [id])).rows[0];
    expect(u).toMatchObject({ display_name: "Dectro xCell", machine_profile_version: 1 });
    expect(await eventCount(S.studioId, "unit_created")).toBe(1);
    expect((await adminQuery(`select actor_user_id from public.studio_machine_setting_events where studio_id=$1 and kind='unit_created'`, [S.studioId])).rows[0].actor_user_id).toBe(S.userId);
  });

  it("two concurrent saves produce ONE live unit", async () => {
    const S = await seedStudio("sw-race");
    const sess = await seedSession(S);
    const ids = await Promise.all(Array.from({ length: 12 }, () => ensure(S.userId, sess.blockId, PUR)));
    expect(new Set(ids).size, `every concurrent save must get the same unit, got ${[...new Set(ids)].join(",")}`).toBe(1);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    // deterministic overlap: A creates the unit and stays uncommitted; B starts meanwhile and must end up with A's unit, never a spurious refusal
    const S2 = await seedStudio("sw-race-hold");
    const sess2 = await seedSession(S2);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let created!: (id: string) => void;
    const createdP = new Promise<string>((r) => (created = r));
    const holder = asUser(S2.userId, async (q) => {
      const id = (await q(`select public.ensure_studio_machine_for_save($1,$2) as r`, [sess2.blockId, PUR])).rows[0].r as string;
      created(id);
      await gate;
      return id;
    });
    const idA = await createdP;
    let settled = false;
    const second = ensure(S2.userId, sess2.blockId, PUR).then((v) => { settled = true; return v; });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled, "the second save must wait for the first, not run beside it").toBe(false);
    release();
    expect(await holder).toBe(idA);
    expect(await second).toBe(idA);
    expect(Number((await adminQuery(`select count(*)::int n from public.studio_machines where studio_id=$1 and retired_at is null`, [S.studioId])).rows[0].n)).toBe(1);
    expect(await eventCount(S.studioId, "unit_created")).toBe(1);
  });

  it("refuses a model that is switched off, the rollout off, a block of another studio, a receptionist and an unknown profile; never takes a studio argument", async () => {
    const S = await seedStudio("sw-refuse");
    const sess = await seedSession(S);
    expect((await failure(ensure(S.userId, sess.blockId, SEN)))?.message).toMatch(/not switched on/);
    expect((await failure(ensure(B.userId, sess.blockId, PUR)))?.message).toBe("Not available.");
    expect((await failure(ensure(recept, sess.blockId, PUR)))?.message).toBe("Not available.");
    expect((await failure(ensure(S.userId, randomUUID(), PUR)))?.message).toBe("Not available.");
    expect((await failure(ensure(S.userId, sess.blockId, "dectro-apilus:bogus")))?.message).toBe("Not available.");
    await setRollout("off");
    try { expect((await failure(ensure(S.userId, sess.blockId, PUR)))?.message).toMatch(/not available yet/); } finally { await setRollout("all"); }
    expect(Number((await adminQuery(`select count(*)::int n from public.studio_machines where studio_id=$1`, [S.studioId])).rows[0].n)).toBe(0);
    const argTypes = (await adminQuery(`select pg_get_function_identity_arguments(oid) a from pg_proc where proname='ensure_studio_machine_for_save'`)).rows[0].a;
    expect(argTypes).toBe("p_block_id uuid, p_profile text");
  });

  it("an archived practitioner is refused", async () => {
    const S = await seedStudio("sw-archived");
    const sess = await seedSession(S);
    const m = await seedMember(S, "sw-arch");
    await adminQuery(`update public.practitioners set active = false where id = $1`, [m.practitionerId]);
    expect((await failure(ensure(m.userId, sess.blockId, PUR)))?.message).toBe("Not available.");
  });

  it("NEVER recreates a unit the owner retired, decided from THAT studio's history only", async () => {
    const S = await seedStudio("sw-retired");
    const T = await seedStudio("sw-other");
    const sS = await seedSession(S);
    const sT = await seedSession(T);
    const first = await ensure(S.userId, sS.blockId, PUR);
    await adminQuery(`update public.studio_machines set retired_at = now() where id = $1`, [first]);
    expect(await ensure(S.userId, sS.blockId, PUR)).toBe("retired");
    expect(Number((await adminQuery(`select count(*)::int n from public.studio_machines where studio_id=$1 and retired_at is null`, [S.studioId])).rows[0].n)).toBe(0);
    // another studio's retirement of the same model does not affect this one
    const fresh = await ensure(T.userId, sT.blockId, PUR);
    expect(fresh).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("an unpublished model creates nothing", async () => {
    const S = await seedStudio("sw-unpub");
    const sess = await seedSession(S);
    await adminQuery(`update public.studio_machine_models set enabled = true where studio_id=$1 and profile_id=$2`, [S.studioId, JUN]);
    expect(await ensure(S.userId, sess.blockId, JUN)).toBe("unpublished");
  });
});

describe("events: closed shapes, append-only, by user id", () => {
  it("a free-text or extra-key value is refused for every kind", async () => {
    const S = await seedStudio("sw-shape");
    const ins = (kind: string, value: unknown, profile: string | null = PUR) =>
      failure(adminQuery(`insert into public.studio_machine_setting_events (studio_id, kind, profile_id, value) values ($1,$2,$3,$4::jsonb)`, [S.studioId, kind, profile, JSON.stringify(value)]));
    expect(await ins("model_set", { enabled: true })).toBeNull();
    expect(await ins("model_set", { enabled: "yes" })).not.toBeNull();
    expect(await ins("model_set", { enabled: true, note: "free text" })).not.toBeNull();
    expect(await ins("model_set", {})).not.toBeNull();
    expect(await ins("default_set", { default: "ask" })).toBeNull();
    expect(await ins("default_set", { default: "someone@example.com" })).not.toBeNull();
    expect(await ins("default_set", { default: "ask", extra: 1 })).not.toBeNull();
    expect(await ins("unit_created", { created: true })).toBeNull();
    expect(await ins("unit_created", { created: false })).not.toBeNull();
    expect(await ins("unit_created", { created: true, who: "x" })).not.toBeNull();
    expect(await ins("other_kind", { enabled: true })).not.toBeNull();
    expect(await ins("model_set", { enabled: true }, "dectro-apilus:bogus")).not.toBeNull();
  });

  it("update, delete and truncate are refused", async () => {
    expect((await failure(adminQuery(`update public.studio_machine_setting_events set kind = kind where studio_id = $1`, [A.studioId])))?.message).toMatch(/append-only/);
    expect((await failure(adminQuery(`delete from public.studio_machine_setting_events where studio_id = $1`, [A.studioId])))?.message).toMatch(/append-only/);
    expect((await failure(adminQuery(`truncate public.studio_machine_setting_events`)))?.message).toMatch(/append-only/);
  });

  it("removing a studio removes its settings and events (CASCADE) and is never blocked by them", async () => {
    const S = await seedStudio("sw-cascade");
    await setModel(S.userId, S.studioId, SEN, true);
    expect(await eventCount(S.studioId)).toBe(1);
    const gone = await failure(adminQuery(`delete from public.studios where id = $1`, [S.studioId]));
    expect(gone).toBeNull();
    for (const t of ["studio_machine_models", "studio_machine_default", "studio_machine_setting_events"]) {
      expect(Number((await adminQuery(`select count(*)::int n from public.${t} where studio_id=$1`, [S.studioId])).rows[0].n), t).toBe(0);
    }
  });
});

describe("grants and RLS, by name", () => {
  it("RLS is on with NO policy, and no role has any table privilege on the three tables", async () => {
    for (const t of ["studio_machine_models", "studio_machine_default", "studio_machine_setting_events"]) {
      const c = (await adminQuery(`select relrowsecurity from pg_class where oid = $1::regclass`, [`public.${t}`])).rows[0];
      expect(c.relrowsecurity, t).toBe(true);
      expect(Number((await adminQuery(`select count(*)::int n from pg_policies where schemaname='public' and tablename=$1`, [t])).rows[0].n), t).toBe(0);
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        const r = await adminQuery(`select has_table_privilege($1, $2::regclass, 'select,insert,update,delete,truncate') p`, [role === "public" ? "public" : role, `public.${t}`]).catch(() => null);
        if (r) expect(r.rows[0].p, `${role} ${t}`).toBe(false);
      }
    }
  });

  it("the four commands execute for authenticated only; every internal function for nobody; anon, public and service_role are revoked by name", async () => {
    const callable = ["set_studio_machine_model(uuid,text,boolean)", "set_studio_machine_default(uuid,text,boolean)", "get_studio_machine_choices()", "ensure_studio_machine_for_save(uuid,text)"];
    const internal = ["seed_studio_machine_settings(uuid)", "studios_seed_machine_settings_trigger()", "studio_machine_setting_events_guard()", "studio_machine_setting_events_truncate_guard()",
      "apply_block_machine_identity(uuid,uuid,text,uuid,text,timestamptz,text,text)"];
    const priv = async (role: string, sig: string) => (await adminQuery(`select has_function_privilege($1, $2::regprocedure, 'execute') p`, [role, `public.${sig}`])).rows[0].p as boolean;
    for (const f of callable) {
      expect(await priv("authenticated", f), f).toBe(true);
      for (const r of ["anon", "service_role"]) expect(await priv(r, f), `${r} ${f}`).toBe(false);
    }
    for (const f of internal) for (const r of ["anon", "authenticated", "service_role"]) expect(await priv(r, f), `${r} ${f}`).toBe(false);
  });
});

describe("apply_block_machine_identity: the xCell Pur model with a legacy-column mode", () => {
  const LEG_MODES = ["thermolysis", "blend", "galvanic"];

  it("records Pur + each legacy mode (no unit) and with the studio's own Pur unit, as the legacy modes, without a contract row", async () => {
    const S = await seedStudio("sw-id-ok");
    for (const mode of LEG_MODES) {
      const s = await seedSession(S);
      await identity(s.blockId, S.studioId, PUR, null, mode);
      expect(await blockIdentity(s.blockId)).toEqual({ machine_profile_id: PUR, studio_machine_id: null, machine_mode_key: mode });
    }
    const unit = await unitOf(S.studioId, PUR, 1);
    const s2 = await seedSession(S);
    await identity(s2.blockId, S.studioId, PUR, unit, "blend");
    expect(await blockIdentity(s2.blockId)).toEqual({ machine_profile_id: PUR, studio_machine_id: unit, machine_mode_key: "blend" });
  });

  it("is refused for an unknown mode, no mode, a different model, another studio's unit, and a unit of another profile", async () => {
    const S = await seedStudio("sw-id-no");
    const T = await seedStudio("sw-id-other");
    const s = await seedSession(S);
    expect((await failure(identity(s.blockId, S.studioId, PUR, null, "bogus")))?.message).toMatch(/mode needs a registered machine/);
    expect((await failure(identity(s.blockId, S.studioId, PUR, null, null)))?.message).toMatch(/must be the xCell Pur machine/);
    expect((await failure(identity(s.blockId, S.studioId, SEN, null, "thermolysis")))?.message).toMatch(/mode needs a registered machine/);
    const theirs = await unitOf(T.studioId, PUR, 1);
    expect((await failure(identity(s.blockId, S.studioId, PUR, theirs, "thermolysis")))?.message).toMatch(/not available in this studio/);
    const senior = await unitOf(S.studioId, SEN, 3);
    expect((await failure(identity(s.blockId, S.studioId, PUR, senior, "thermolysis")))?.message).toMatch(/does not match the selected model/);
    expect(await blockIdentity(s.blockId)).toEqual({ machine_profile_id: null, studio_machine_id: null, machine_mode_key: null });
  });

  it("a NEW assignment is refused when the model is switched off or the rollout is off; the refusal writes nothing", async () => {
    const S = await seedStudio("sw-id-off");
    const s = await seedSession(S);
    await setModel(S.userId, S.studioId, PUR, false);
    expect((await failure(identity(s.blockId, S.studioId, PUR, null, "thermolysis")))?.message).toMatch(/not available for new settings/);
    await setModel(S.userId, S.studioId, PUR, true);
    await setRollout("off");
    try { expect((await failure(identity(s.blockId, S.studioId, PUR, null, "thermolysis")))?.message).toMatch(/not available for new settings/); } finally { await setRollout("all"); }
    expect(await blockIdentity(s.blockId)).toEqual({ machine_profile_id: null, studio_machine_id: null, machine_mode_key: null });
  });

  it("an EXISTING block with an UNCHANGED identity still saves with the model off and the rollout Off; a CHANGED one does not", async () => {
    const S = await seedStudio("sw-id-keep");
    const s = await seedSession(S);
    await identity(s.blockId, S.studioId, PUR, null, "thermolysis");
    await setModel(S.userId, S.studioId, PUR, false);
    await setRollout("off");
    try {
      await identity(s.blockId, S.studioId, PUR, null, "thermolysis");
      expect(await blockIdentity(s.blockId)).toEqual({ machine_profile_id: PUR, studio_machine_id: null, machine_mode_key: "thermolysis" });
      expect((await failure(identity(s.blockId, S.studioId, PUR, null, "galvanic")))?.message).toMatch(/not available for new settings/);
    } finally { await setRollout("all"); }
  });

  it("a block holding legacy readings takes the Pur legacy identity, but another native identity is still refused (0310's rule stands)", async () => {
    const S = await seedStudio("sw-id-readings");
    const s = await seedSession(S);
    await setLegacyMode(s.blockId);
    await identity(s.blockId, S.studioId, PUR, null, "thermolysis");
    const senior = await unitOf(S.studioId, SEN, 3);
    expect((await failure(identity(s.blockId, S.studioId, SEN, senior, null)))?.message).toMatch(/already holds xCell Pur readings/);
  });

  it("the legacy xCell identity (no unit, no mode) is untouched, and a historical legacy-xCell block reopens unchanged", async () => {
    const S = await seedStudio("sw-id-legacy");
    const s = await seedSession(S);
    await setLegacyMode(s.blockId);
    await identity(s.blockId, S.studioId, LEGACY, null, null);
    const before = await blockIdentity(s.blockId);
    expect(before).toEqual({ machine_profile_id: LEGACY, studio_machine_id: null, machine_mode_key: null });
    await setModel(S.userId, S.studioId, PUR, false);
    await setRollout("off");
    try {
      await identity(s.blockId, S.studioId, LEGACY, null, null);
      expect(await blockIdentity(s.blockId)).toEqual(before);
      expect((await failure(identity(s.blockId, S.studioId, LEGACY, null, "thermolysis")))?.message).toMatch(/mode needs a registered machine/);
    } finally { await setRollout("all"); }
  });

  it("0310's contract rules still hold for a native unit (a mode outside the contract is refused)", async () => {
    const S = await seedStudio("sw-id-0310");
    const s = await seedSession(S);
    const senior = await unitOf(S.studioId, SEN, 3);
    expect((await failure(identity(s.blockId, S.studioId, SEN, senior, "not-a-mode")))?.message).toMatch(/does not offer that mode/);
    await identity(s.blockId, S.studioId, SEN, senior, "flash");
    expect((await blockIdentity(s.blockId)).machine_mode_key).toBe("flash");
  });
});

describe("DB-level freeze: a block holding readings cannot change its machine identity", () => {
  const ENTRY = (block: string, _studio: string) =>
    [`insert into public.electrolysis_entries (session_id, block_id, area, mode, thermolysis_intensity_percent) values ((select session_id from public.session_blocks where id=$1),$1,'Upper lip','thermo',40)`, [block]] as const;
  const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("refuses a change of model, unit or mode once an entry holds a reading; first assignment and an unchanged identity stay allowed; a soft-deleted entry is not a reading", async () => {
    const S = await seedStudio("sw-frz");
    const s = await seedSession(S);
    await adminQuery(`update public.session_blocks set machine_profile_id=$2, machine_mode_key='thermolysis' where id=$1`, [s.blockId, PUR]); // first assignment
    const [q, p] = ENTRY(s.blockId, S.studioId);
    const ins = await adminQuery(q + " returning id", [...p]);
    for (const set of [`machine_mode_key='galvanic'`, `machine_profile_id='${LEGACY}'`, `machine_mode_key=null`]) {
      expect((await failure(adminQuery(`update public.session_blocks set ${set} where id=$1`, [s.blockId])))?.message, set).toMatch(/already holds readings/);
    }
    await adminQuery(`update public.session_blocks set machine_mode_key='thermolysis' where id=$1`, [s.blockId]); // unchanged: allowed
    await adminQuery(`update public.electrolysis_entries set deleted_at = now() where id=$1`, [ins.rows[0].id]);
    await adminQuery(`update public.session_blocks set machine_mode_key='galvanic' where id=$1`, [s.blockId]);
    expect((await blockIdentity(s.blockId)).machine_mode_key).toBe("galvanic");
  });

  it("COST of the block share lock: a burst of 200 reading writes timed with and without the trigger (measured, reported, loosely bounded)", async () => {
    const S = await seedStudio("sw-cost");
    const s = await seedSession(S);
    const burst = async () => {
      const t0 = performance.now();
      for (let i = 0; i < 200; i++) await adminQuery(`insert into public.electrolysis_entries (session_id, block_id, area, mode, thermolysis_intensity_percent) values ($1,$2,'Upper lip','thermo',$3)`, [s.sessionId, s.blockId, (i % 90) + 1]);
      return performance.now() - t0;
    };
    await burst(); // warm-up
    const withLock = await burst();
    await adminQuery(`alter table public.electrolysis_entries disable trigger electrolysis_entries_share_lock_block`);
    let without: number;
    try { await burst(); without = await burst(); } finally { await adminQuery(`alter table public.electrolysis_entries enable trigger electrolysis_entries_share_lock_block`); }
    console.log(`share-lock cost: with=${withLock.toFixed(0)}ms without=${without.toFixed(0)}ms per-write delta=${((withLock - without) / 200).toFixed(2)}ms`);
    expect(withLock).toBeLessThan(without * 3 + 500);
  });

  it("RACE A: a reading write in flight holds the block; a concurrent identity change waits, then is refused", async () => {
    const S = await seedStudio("sw-race-a");
    const s = await seedSession(S);
    await adminQuery(`update public.session_blocks set machine_profile_id=$2, machine_mode_key='thermolysis' where id=$1`, [s.blockId, PUR]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let wrote!: () => void;
    const wroteP = new Promise<void>((r) => (wrote = r));
    const writer = adminTx(async (q) => { const [t, p] = ENTRY(s.blockId, S.studioId); await q(t, [...p]); wrote(); await gate; });
    await wroteP;
    let settled = false;
    const changer = failure(adminQuery(`update public.session_blocks set machine_mode_key='galvanic' where id=$1`, [s.blockId])).then((e) => { settled = true; return e; });
    await later(400);
    expect(settled, "the identity change must be waiting on the in-flight reading write").toBe(false);
    release();
    await writer;
    expect((await changer)?.message).toMatch(/already holds readings/);
    expect((await blockIdentity(s.blockId)).machine_mode_key).toBe("thermolysis");
  });

  it("RACE B: an identity change in flight holds the block; a concurrent reading write waits and then lands under the NEW identity", async () => {
    const S = await seedStudio("sw-race-b");
    const s = await seedSession(S);
    await adminQuery(`update public.session_blocks set machine_profile_id=$2, machine_mode_key='thermolysis' where id=$1`, [s.blockId, PUR]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let changed!: () => void;
    const changedP = new Promise<void>((r) => (changed = r));
    const changer = adminTx(async (q) => { await q(`update public.session_blocks set machine_mode_key='galvanic' where id=$1`, [s.blockId]); changed(); await gate; });
    await changedP;
    let settled = false;
    const [t, p] = ENTRY(s.blockId, S.studioId);
    const writer = adminQuery(t, [...p]).then(() => { settled = true; });
    await later(400);
    expect(settled, "the reading write must wait for the in-flight identity change").toBe(false);
    release();
    await changer;
    await writer;
    expect((await blockIdentity(s.blockId)).machine_mode_key).toBe("galvanic");
    // and now that readings exist the identity is frozen
    expect((await failure(adminQuery(`update public.session_blocks set machine_mode_key='blend' where id=$1`, [s.blockId])))?.message).toMatch(/already holds readings/);
  });
});

describe("the down", () => {
  const DOWN_PATH = "docs/proposals/machine-switches.down.sql";

  it("REFUSES while a block holds a Pur identity (N1); nothing is dropped", async () => {
    const S = await seedStudio("sw-down");
    const s = await seedSession(S);
    await identity(s.blockId, S.studioId, PUR, null, "thermolysis");
    const e = await failure(adminQuery(readFileSync(DOWN_PATH, "utf8")));
    expect(e?.message).toMatch(/blocks hold an xCell Pur identity/);
    expect((await adminQuery(`select to_regclass('public.studio_machine_models') as t`)).rows[0].t).not.toBeNull();
    expect((await adminQuery(`select md5(prosrc) m from pg_proc where proname='apply_block_machine_identity'`)).rows[0].m).not.toBe("218c39a20344d2effd4d934f702b0338");
  });

  it("restores 0310's function body byte for byte (the down text carries it unchanged)", () => {
    const orig = readFileSync("supabase/migrations/0310_block_machine_identity_mode_contract.sql", "utf8");
    const a = orig.indexOf("create or replace function public.apply_block_machine_identity(");
    const body = orig.slice(a, orig.indexOf("$$;", a) + 3);
    expect(readFileSync(DOWN_PATH, "utf8")).toContain(body);
  });
});
