import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, asRole, asUser, closePool, seedLegacyRecordStatus, seedMember, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";
import { blockHoldsLegacyReadings } from "../../lib/sessions/holds-legacy-readings";

// Machine switches: the DB behaviour of the settings tables, the owner and lazy-unit commands, the seed, and the amended identity command.
// Synthetic data only. While the SQL is unnumbered this applies it onto an OWNED local stack once; when numbered it is part of the chain.
const SQL_PATH = "supabase/migrations/0366_machine_switches.sql";
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
  asUser(user, async (q) => (await q(`select * from public.get_studio_machine_choices()`)).rows as { studio_id: string; profile_id: string; is_default: boolean; ask_each_visit: boolean; live_unit_id: string | null; enabled: boolean }[]);
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
// A unit registered directly (as a studio that already had one) has its Senior/Junior model ON, the same rule the seed applies ("on where a live unit
// exists"); xCell Pur is left as the seed set it, because seedOff flips it on purpose. A test that needs the model off turns it off explicitly.
const unitOf = async (studio: string, profile: string, version = 1) => {
  const id = (await adminQuery(`insert into public.studio_machines (studio_id, machine_profile_id, machine_profile_version, display_name) values ($1,$2,$3,$4) returning id`, [studio, profile, version, `Unit ${randomUUID().slice(0, 8)}`])).rows[0].id as string;
  if (profile !== PUR) await adminQuery(`update public.studio_machine_models set enabled = true where studio_id = $1 and profile_id = $2`, [studio, profile]);
  return id;
};

// The seed starts xCell Pur ON and the default (24 Nov 2026), so a new studio is already in the state these tests exercise. The helper only seeds.
const seedOn = async (label: string): Promise<SeededStudio> => seedStudio(label);
// A studio whose owner has NOT opted into xCell: the seed's xCell-on state is flipped back, to exercise the off path.
const seedOff = async (label: string): Promise<SeededStudio> => {
  const s = await seedStudio(label);
  await adminQuery(`update public.studio_machine_models set enabled = false where studio_id = $1 and profile_id = $2`, [s.studioId, PUR]);
  await adminQuery(`update public.studio_machine_default set default_profile_id = null, ask_each_visit = true where studio_id = $1`, [s.studioId]);
  return s;
};

beforeAll(async () => {
  // The migration is part of the chain: this suite NEVER replays its SQL (a replay would change a catalog that may be measured or sealed).
  const have = await adminQuery(`select to_regprocedure('public.set_studio_machine_model(uuid,text,boolean)') as p`);
  if (!have.rows[0].p) throw new Error("The machine-switches migration is not on this stack. Build a fresh stack from the chain; this suite does not apply it.");
  await adminQuery(`insert into public.machine_profile_mode_contract (machine_profile_id, machine_profile_version, mode_key) values ($1,1,'multiplex') on conflict do nothing`, [PUR]);
  await adminQuery(`insert into public.machine_profile_mode_contract (machine_profile_id, machine_profile_version, mode_key) values ($1,3,'flash') on conflict do nothing`, [SEN]);
  A = await seedOn("sw-a");
  B = await seedOn("sw-b");
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
  it("a studio created by ANY path is seeded with xCell Pur ON and as the default, and Senior and Junior off (no unit yet)", async () => {
    const R = await seedStudio("sw-rawseed");
    expect(await models(R.studioId)).toEqual({ [PUR]: true, [SEN]: false, [JUN]: false });
    expect(await dflt(R.studioId)).toEqual({ default_profile_id: PUR, ask_each_visit: false });
  });

  it("an EXISTING studio is seeded by the same function: its Senior unit keeps Senior on, xCell is on and the default, and a re-run never overwrites an owner's choice", async () => {
    const S = await seedStudio("sw-existing");
    await unitOf(S.studioId, SEN, 3);
    await adminQuery(`delete from public.studio_machine_models where studio_id=$1`, [S.studioId]);
    await adminQuery(`delete from public.studio_machine_default where studio_id=$1`, [S.studioId]);
    await adminQuery(`select public.seed_studio_machine_settings($1)`, [S.studioId]);
    expect(await models(S.studioId)).toEqual({ [PUR]: true, [SEN]: true, [JUN]: false });
    expect(await dflt(S.studioId)).toEqual({ default_profile_id: PUR, ask_each_visit: false });
    expect(await setDefault(S.userId, S.studioId, SEN, false)).toBe("changed");
    expect(await setModel(S.userId, S.studioId, PUR, false)).toBe("changed");
    await adminQuery(`select public.seed_studio_machine_settings($1)`, [S.studioId]);
    expect(await models(S.studioId)).toEqual({ [PUR]: false, [SEN]: true, [JUN]: false });
    expect(await dflt(S.studioId)).toEqual({ default_profile_id: SEN, ask_each_visit: false });
  });

  it("re-running the seed changes nothing, and a model the owner turned off STAYS off", async () => {
    expect(await setModel(A.userId, A.studioId, PUR, false)).toBe("changed");
    await adminQuery(`select public.seed_studio_machine_settings($1)`, [A.studioId]);
    expect((await models(A.studioId))[PUR]).toBe(false);
    expect(await setModel(A.userId, A.studioId, PUR, true)).toBe("changed");
    expect(await setDefault(A.userId, A.studioId, PUR, false)).toBe("changed"); // turning the default model off had repaired the default to Ask
  });

  it("a studio that ALREADY holds an explicit default keeps it: the seed sets xCell as default only where no default row exists", async () => {
    const S = await seedStudio("sw-keepdefault");
    await unitOf(S.studioId, JUN, 3);
    await adminQuery(`delete from public.studio_machine_models where studio_id=$1`, [S.studioId]);
    await adminQuery(`delete from public.studio_machine_default where studio_id=$1`, [S.studioId]);
    await adminQuery(`insert into public.studio_machine_models (studio_id, profile_id, enabled) values ($1,$2,true),($1,$3,true),($1,$4,false)`, [S.studioId, JUN, SEN, PUR]);
    await adminQuery(`insert into public.studio_machine_default (studio_id, default_profile_id, ask_each_visit) values ($1,$2,false)`, [S.studioId, JUN]);
    await adminQuery(`select public.seed_studio_machine_settings($1)`, [S.studioId]);
    expect(await dflt(S.studioId)).toEqual({ default_profile_id: JUN, ask_each_visit: false });
    expect(await models(S.studioId)).toEqual({ [PUR]: false, [SEN]: true, [JUN]: true });
    const ask = await seedStudio("sw-keepask");
    await adminQuery(`update public.studio_machine_default set default_profile_id = null, ask_each_visit = true where studio_id=$1`, [ask.studioId]);
    await adminQuery(`select public.seed_studio_machine_settings($1)`, [ask.studioId]);
    expect(await dflt(ask.studioId)).toEqual({ default_profile_id: null, ask_each_visit: true });
  });

  it("Senior and Junior are seeded ON exactly where the studio already has a live unit of that model", async () => {
    const S = await seedOn("sw-seedunits");
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
    const S = await seedOn("sw-repair");
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
    const S = await seedOn("sw-default");
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
    // EVERY model is returned with its switch, so an off model is a row that says off (never a missing row)
    expect(own.find((r) => r.profile_id === JUN)).toMatchObject({ enabled: false });
    expect(own.find((r) => r.profile_id === PUR)).toMatchObject({ enabled: true });
    expect(await choices(recept)).toEqual([]);
    expect((await choices(B.userId)).every((r) => r.studio_id === B.studioId)).toBe(true);
    const cols = Object.keys(own[0]);
    expect(cols.sort()).toEqual(["ask_each_visit", "enabled", "is_default", "live_unit_id", "profile_id", "studio_id"]);
    const fnArgs = (await adminQuery(`select pronargs from pg_proc where proname='get_studio_machine_choices'`)).rows[0].pronargs;
    expect(Number(fnArgs)).toBe(0);
  });
});

describe("switching every model off: 'nothing enabled' is not 'unavailable'", () => {
  it("the read still returns a row per model, all off and none the default, so the app can show 'No machines enabled' instead of the unfiltered picker; turning one back on returns to normal", async () => {
    const S = await seedOn("sw-alloff");
    for (const p of [PUR, SEN, JUN]) await setModel(S.userId, S.studioId, p, false);
    const rows = (await choices(S.userId)).filter((r) => r.studio_id === S.studioId);
    expect(rows.map((r) => r.profile_id).sort()).toEqual([JUN, PUR, SEN].sort());
    expect(rows.every((r) => r.enabled === false)).toBe(true);
    expect(rows.every((r) => r.is_default === false)).toBe(true);
    expect(rows.every((r) => r.ask_each_visit === true)).toBe(true);
    expect(await setModel(S.userId, S.studioId, PUR, true)).toBe("changed");
    const back = (await choices(S.userId)).filter((r) => r.studio_id === S.studioId);
    expect(back.find((r) => r.profile_id === PUR)).toMatchObject({ enabled: true });
    expect(back.filter((r) => r.enabled).length).toBe(1);
  });
});

describe("ensure_studio_machine_for_save: lazy, idempotent, bound to a real block", () => {
  it("creates one unit the first time, reuses it after, writes one event with the actor, and the switch alone created nothing", async () => {
    const S = await seedOn("sw-ensure");
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

  it("a null or empty profile is refused and creates nothing", async () => {
    const S = await seedOn("sw-nullprofile");
    const sess = await seedSession(S);
    const nullish = (profile: string | null) =>
      asUser(S.userId, async (q) => (await q(`select public.ensure_studio_machine_for_save($1,$2) as r`, [sess.blockId, profile])).rows[0].r as string);
    expect((await failure(nullish(null)))?.message).toBe("Not available.");
    expect((await failure(nullish("")))?.message).toBe("Not available.");
    expect(Number((await adminQuery(`select count(*)::int n from public.studio_machines where studio_id=$1`, [S.studioId])).rows[0].n)).toBe(0);
  });

  it("two concurrent saves produce ONE live unit", async () => {
    const S = await seedOn("sw-race");
    const sess = await seedSession(S);
    const ids = await Promise.all(Array.from({ length: 12 }, () => ensure(S.userId, sess.blockId, PUR)));
    expect(new Set(ids).size, `every concurrent save must get the same unit, got ${[...new Set(ids)].join(",")}`).toBe(1);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    // deterministic overlap: A creates the unit and stays uncommitted; B starts meanwhile and must end up with A's unit, never a spurious refusal
    const S2 = await seedOn("sw-race-hold");
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
    const S = await seedOn("sw-refuse");
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
    const S = await seedOn("sw-archived");
    const sess = await seedSession(S);
    const m = await seedMember(S, "sw-arch");
    await adminQuery(`update public.practitioners set active = false where id = $1`, [m.practitionerId]);
    expect((await failure(ensure(m.userId, sess.blockId, PUR)))?.message).toBe("Not available.");
  });

  it("NEVER recreates a unit the owner retired, decided from THAT studio's history only", async () => {
    const S = await seedOn("sw-retired");
    const T = await seedOn("sw-other");
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
    const S = await seedOn("sw-unpub");
    const sess = await seedSession(S);
    await adminQuery(`update public.studio_machine_models set enabled = true where studio_id=$1 and profile_id=$2`, [S.studioId, JUN]);
    expect(await ensure(S.userId, sess.blockId, JUN)).toBe("unpublished");
  });
});

describe("events: closed shapes, append-only, by user id", () => {
  it("a free-text or extra-key value is refused for every kind", async () => {
    const S = await seedOn("sw-shape");
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
    const S = await seedOn("sw-cascade");
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
    const S = await seedOn("sw-id-ok");
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
    const S = await seedOn("sw-id-no");
    const T = await seedOn("sw-id-other");
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
    const S = await seedOn("sw-id-off");
    const s = await seedSession(S);
    await setModel(S.userId, S.studioId, PUR, false);
    expect((await failure(identity(s.blockId, S.studioId, PUR, null, "thermolysis")))?.message).toMatch(/not available for new settings/);
    await setModel(S.userId, S.studioId, PUR, true);
    await setRollout("off");
    try { expect((await failure(identity(s.blockId, S.studioId, PUR, null, "thermolysis")))?.message).toMatch(/not available for new settings/); } finally { await setRollout("all"); }
    expect(await blockIdentity(s.blockId)).toEqual({ machine_profile_id: null, studio_machine_id: null, machine_mode_key: null });
  });

  it("a NEW binding to a model that is switched off is refused, native or the legacy xCell choice, whatever unit is named; an unchanged existing identity still saves; the rollout off makes the switch dormant", async () => {
    const S = await seedOn("sw-id-native-off");
    const senior = await unitOf(S.studioId, SEN, 3);
    const kept = await seedSession(S);
    await identity(kept.blockId, S.studioId, SEN, senior, "flash");
    await setModel(S.userId, S.studioId, SEN, false);
    const fresh = await seedSession(S);
    expect((await failure(identity(fresh.blockId, S.studioId, SEN, senior, "flash")))?.message).toMatch(/switched off for this studio/);
    expect(await blockIdentity(fresh.blockId)).toEqual({ machine_profile_id: null, studio_machine_id: null, machine_mode_key: null });
    await identity(kept.blockId, S.studioId, SEN, senior, "flash"); // unchanged: not a new binding
    await setRollout("off");
    try { await identity(fresh.blockId, S.studioId, SEN, senior, "flash"); } finally { await setRollout("all"); }
    expect((await blockIdentity(fresh.blockId)).machine_profile_id).toBe(SEN);
    // the legacy xCell choice is the xCell model: off refuses a new area on it too
    const legacy = await seedSession(S);
    await setModel(S.userId, S.studioId, PUR, false);
    expect((await failure(identity(legacy.blockId, S.studioId, "dectro-apilus:xcell", null, null)))?.message).toMatch(/switched off for this studio/);
    await setModel(S.userId, S.studioId, PUR, true);
    await identity(legacy.blockId, S.studioId, "dectro-apilus:xcell", null, null);
  });

  it("an EXISTING block with an UNCHANGED identity still saves with the model off and the rollout Off; a CHANGED one does not", async () => {
    const S = await seedOn("sw-id-keep");
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

  it("a block holding legacy readings takes the Pur legacy identity, but another native identity is still refused (the existing identity rules stand)", async () => {
    const S = await seedOn("sw-id-readings");
    const s = await seedSession(S);
    await adminTx(async (q) => { await q(`set local session_replication_role = replica`); await q(`update public.session_blocks set energy_level = 3 where id = $1`, [s.blockId]); });
    await identity(s.blockId, S.studioId, PUR, null, "thermolysis");
    const senior = await unitOf(S.studioId, SEN, 3);
    expect((await failure(identity(s.blockId, S.studioId, SEN, senior, null)))?.message).toMatch(/already holds xCell Pur readings/);
  });

  it("a block with a stale legacy mode and frequency takes a native identity and keeps those columns untouched; an entry with a legacy reading still blocks the native identity", async () => {
    const S = await seedOn("sw-d34");
    const s = await seedSession(S);
    await adminTx(async (q) => { await q(`set local session_replication_role = replica`); await q(`update public.session_blocks set mode = 'galv', machine_frequency = '13.56 MHz' where id = $1`, [s.blockId]); });
    const senior = await unitOf(S.studioId, SEN, 3);
    await identity(s.blockId, S.studioId, SEN, senior, "flash");
    const row = (await adminQuery(`select mode, machine_frequency, machine_profile_id from public.session_blocks where id=$1`, [s.blockId])).rows[0];
    expect(row.mode).toBe("galv");
    expect(row.machine_frequency).toBe("13.56 MHz");
    expect(row.machine_profile_id).toBe(SEN);
    expect((await adminQuery(`select public.block_holds_legacy_readings($1) h`, [s.blockId])).rows[0].h).toBe(false);
    const S2 = await seedOn("sw-d4");
    const s2 = await seedSession(S2);
    await adminQuery(`insert into public.electrolysis_entries (session_id, block_id, area, mode, galvanic_ma) values ($1,$2,'Upper lip','galv',2)`, [s2.sessionId, s2.blockId]);
    const senior2 = await unitOf(S2.studioId, SEN, 3);
    expect((await failure(identity(s2.blockId, S2.studioId, SEN, senior2, "flash")))?.message).toMatch(/already holds/);
  });

  it("an UNTOUCHED saved block is not frozen: a block saved with only an area, the sticky frequency and a mode selection can still change machine, and so can one whose only entry has no reading", async () => {
    const S = await seedOn("sw-untouched");
    const s = await seedSession(S);
    await adminTx(async (q) => { await q(`set local session_replication_role = replica`); await q(`update public.session_blocks set mode = 'thermo', machine_frequency = '27.12 MHz' where id = $1`, [s.blockId]); });
    await adminQuery(`insert into public.electrolysis_entries (session_id, block_id, area, mode) values ($1,$2,'Upper lip','thermo')`, [s.sessionId, s.blockId]);
    expect((await adminQuery(`select public.block_holds_legacy_readings($1) h`, [s.blockId])).rows[0].h).toBe(false);
    const senior = await unitOf(S.studioId, SEN, 3);
    await identity(s.blockId, S.studioId, SEN, senior, "flash");
    expect(await failure(adminQuery(`update public.session_blocks set machine_profile_id=$2, studio_machine_id=null, machine_mode_key='thermolysis' where id=$1`, [s.blockId, PUR]))).toBeNull();
    expect(await failure(adminQuery(`update public.session_blocks set machine_mode_key='blend' where id=$1`, [s.blockId]))).toBeNull();
    // the moment a reading is recorded the identity freezes
    await adminTx(async (q) => { await q(`set local session_replication_role = replica`); await q(`update public.electrolysis_entries set thermolysis_intensity_percent = 30 where block_id = $1`, [s.blockId]); });
    expect((await failure(adminQuery(`update public.session_blocks set machine_mode_key='galvanic' where id=$1`, [s.blockId])))?.message).toMatch(/already holds readings/);
  });

  it("the legacy xCell identity (no unit, no mode) is untouched, and a historical legacy-xCell block reopens unchanged", async () => {
    const S = await seedOn("sw-id-legacy");
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

  it("the existing contract rules still hold for a native unit (a mode outside the contract is refused)", async () => {
    const S = await seedOn("sw-id-contract");
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
    const S = await seedOn("sw-frz");
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
    const S = await seedOn("sw-cost");
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
    const S = await seedOn("sw-race-a");
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
    const S = await seedOn("sw-race-b");
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

describe("role gate, invoker lock, freeze as the lowest writing role", () => {
  it("a practitioner-role member may use choices and ensure; a user whose practitioners row has any other role is refused (receptionist, when the chain allows that role)", async () => {
    const S = await seedOn("sw-role");
    const sess = await seedSession(S);
    const mem = await seedMember(S, "sw-role-m");
    expect((await choices(mem.userId)).length).toBeGreaterThan(0);
    expect(await ensure(mem.userId, sess.blockId, PUR)).toMatch(/^[0-9a-f-]{36}$/);
    const rec = await seedMember(S, "sw-role-r");
    const set = await failure(adminQuery(`update public.practitioners set role = 'receptionist' where id = $1`, [rec.practitionerId]));
    if (set) { console.log("receptionist role not allowed on practitioners in this chain; the stacked run (roles migrations) must exercise this case"); return; }
    expect(await choices(rec.userId)).toEqual([]);
    expect((await failure(ensure(rec.userId, sess.blockId, PUR)))?.message).toBe("Not available.");
  });

  it("a receptionist: a user who is an active studio receptionist and has NO practitioners row is refused by choices and ensure; practitioners.role never holds 'receptionist' in any chain", async () => {
    const have = (await adminQuery(`select to_regclass('public.studio_receptionists') t`)).rows[0].t;
    if (!have) { console.log("studio_receptionists is not in this chain; the stacked run exercises this case"); return; }
    const S = await seedOn("sw-recep");
    const sess = await seedSession(S);
    const u = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [u, `sw-recep-${u.slice(0, 8)}@harness.local`]);
    await adminQuery(`insert into public.studio_receptionists (studio_id, user_id, display_name, active) values ($1,$2,'Front desk',true)`, [S.studioId, u]);
    expect(await choices(u)).toEqual([]);
    expect((await failure(ensure(u, sess.blockId, PUR)))?.message).toBe("Not available.");
    const chk = (await adminQuery(`select pg_get_constraintdef(oid) d from pg_constraint where conrelid='public.practitioners'::regclass and conname='practitioners_role_check'`)).rows[0].d as string;
    expect(chk).not.toMatch(/receptionist/);
  });

  it("the share-lock trigger is SECURITY INVOKER, and another studio's caller cannot lock this studio's block (even through a failing insert held open)", async () => {
    expect((await adminQuery(`select prosecdef from pg_proc where proname='reading_write_share_lock_block'`)).rows[0].prosecdef).toBe(false);
    const S = await seedOn("sw-lock-a");
    const O = await seedOn("sw-lock-b");
    const s = await seedSession(S);
    let blockedByLock: unknown = "not run";
    await adminTx(async (q) => {
      await q(`set local role authenticated`);
      await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: O.userId, role: "authenticated" })]);
      await failure(q(`insert into public.electrolysis_entries (session_id, block_id, area, mode, thermolysis_intensity_percent) values ($1,$2,'Upper lip','thermo',40)`, [s.sessionId, s.blockId]) as Promise<unknown>);
      // this transaction is now open (aborted) and would still hold any row lock the trigger took
      blockedByLock = await failure(adminTx(async (q2) => {
        await q2(`set local lock_timeout = '1500ms'`);
        await q2(`update public.session_blocks set machine_mode_key = machine_mode_key where id = $1`, [s.blockId]);
      }));
    }).catch(() => undefined);
    expect(blockedByLock, "a foreign caller must not hold a lock on this studio's block").toBeNull();
  });

  it("the freeze sees every entry as the lowest writing role (a practitioner member): the member can read the block's entries, and a direct identity change is refused by the freeze or by privileges, never silently allowed", async () => {
    const S = await seedOn("sw-frz-role");
    const mem = await seedMember(S, "sw-frz-m");
    const s = await seedSession(S);
    await adminQuery(`update public.session_blocks set machine_profile_id=$2, machine_mode_key='thermolysis' where id=$1`, [s.blockId, PUR]);
    await adminQuery(`insert into public.electrolysis_entries (session_id, block_id, area, mode, thermolysis_intensity_percent) values ($1,$2,'Upper lip','thermo',40)`, [s.sessionId, s.blockId]);
    const seen = await asUser(mem.userId, async (q) => Number((await q(`select count(*)::int n from public.electrolysis_entries where block_id=$1`, [s.blockId])).rows[0].n));
    expect(seen, "the member must see the entry the freeze has to find").toBe(1);
    const e = await failure(asUser(mem.userId, async (q) => { await q(`update public.session_blocks set machine_mode_key='galvanic' where id=$1`, [s.blockId]); }));
    expect(e?.message ?? "no error").toMatch(/already holds readings|permission denied/);
    expect((await blockIdentity(s.blockId)).machine_mode_key).toBe("thermolysis");
  });

  it("down: carries a rollout-Off refusal (the behavioural run is the manual down rehearsal: data checks fire first, so a populated test database cannot reach it)", () => {
    const d = readFileSync("supabase/rollbacks/0366_machine_switches.down.sql", "utf8");
    expect(d).toMatch(/platform_rollouts r where r\.key = 'charting_new_view_xcell' and r\.mode <> 'off'/);
    expect(d).toMatch(/rollout is not Off/);
  });
});

describe("one live Pur unit, forced RLS, one readings definition, no deadlock, writable session, text codes", () => {
  const register = (user: string, studio: string, name: string) =>
    asUser(user, async (q) => (await q(`select public.register_studio_machine($1,$2,1,$3,'{}') as r`, [studio, PUR, name])).rows[0].r as string);
  const liveXcell = async (studio: string) =>
    Number((await adminQuery(`select count(*)::int n from public.studio_machines where studio_id=$1 and machine_profile_id=$2 and retired_at is null`, [studio, PUR])).rows[0].n);

  it("the database holds at most one live xCell Pur unit per studio; two concurrent owner registrations leave exactly one; a retired unit frees the slot", async () => {
    const S = await seedOn("sw-uniq");
    const results = await Promise.allSettled([register(S.userId, S.studioId, "Room 1 xCell"), register(S.userId, S.studioId, "Room 2 xCell")]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(await liveXcell(S.studioId)).toBe(1);
    expect(await failure(register(S.userId, S.studioId, "Room 3 xCell"))).not.toBeNull();
    const idx = (await adminQuery(`select indexdef from pg_indexes where indexname='studio_machines_one_live_xcell_pur'`)).rows[0]?.indexdef as string;
    expect(idx).toMatch(/UNIQUE/);
    expect(idx).toMatch(/retired_at IS NULL/);
    await adminQuery(`update public.studio_machines set retired_at = now() where studio_id=$1 and machine_profile_id=$2`, [S.studioId, PUR]);
    expect(await register(S.userId, S.studioId, "Room 4 xCell")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await liveXcell(S.studioId)).toBe(1);
  });

  it("row level security is FORCED on the three tables", async () => {
    for (const t of ["studio_machine_models", "studio_machine_default", "studio_machine_setting_events"]) {
      const c = (await adminQuery(`select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass`, [`public.${t}`])).rows[0];
      expect(c, t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  it("the freeze trigger is SECURITY DEFINER and not callable by any role", async () => {
    expect((await adminQuery(`select prosecdef from pg_proc where proname='session_blocks_machine_identity_freeze'`)).rows[0].prosecdef).toBe(true);
    for (const r of ["anon", "authenticated", "service_role"]) {
      expect((await adminQuery(`select has_function_privilege($1,'public.session_blocks_machine_identity_freeze()','execute') p`, [r])).rows[0].p, r).toBe(false);
    }
  });

  it("the database function and the application helper agree on what 'holds legacy readings' means, case by case", async () => {
    const S = await seedOn("sw-agree");
    type Case = { name: string; block?: Record<string, unknown>; entry?: Record<string, unknown>; deleted?: boolean; reading: boolean };
    const cases: Case[] = [
      { name: "empty", reading: false },
      { name: "block mode alone (a selection, not a reading)", block: { mode: "thermo" }, reading: false },
      { name: "block modality", block: { apilus_modality: "Synchro" }, reading: true },
      { name: "block energy level", block: { energy_level: 3 }, reading: true },
      { name: "block frequency alone (a sticky default, not a reading)", block: { machine_frequency: "27.12 MHz" }, reading: false },
      { name: "entry thermolysis intensity", entry: { thermolysis_intensity_percent: 30 }, reading: true },
      { name: "entry thermolysis duration", entry: { thermolysis_duration_seconds: 2 }, reading: true },
      { name: "entry galvanic ma", entry: { galvanic_ma: 1.5 }, reading: true },
      { name: "entry galvanic duration", entry: { galvanic_duration_seconds: 5 }, reading: true },
      { name: "entry units of lye", entry: { units_of_lye: 2 }, reading: true },
      { name: "entry energy level", entry: { energy_level: 4 }, reading: true },
      { name: "entry modality", entry: { apilus_modality: "Synchro" }, reading: true },
      { name: "entry pulse count only (not a reading)", entry: { pulse_count: 3 }, reading: false },
      { name: "entry with nothing", entry: {}, reading: false },
      { name: "soft-deleted entry with a reading", entry: { thermolysis_intensity_percent: 30 }, deleted: true, reading: false },
    ];
    for (const c of cases) {
      const s = await seedSession(S);
      if (c.block) {
        const cols = Object.keys(c.block);
        await adminTx(async (q) => {
          await q(`set local session_replication_role = replica`);
          await q(`update public.session_blocks set ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`, [s.blockId, ...cols.map((k) => (c.block as Record<string, unknown>)[k])]);
        });
      }
      let entryRow: Record<string, unknown> | undefined;
      if (c.entry) {
        const cols = ["session_id", "block_id", "area", "mode", ...Object.keys(c.entry)];
        const vals = [s.sessionId, s.blockId, "Upper lip", "thermo", ...Object.values(c.entry)];
        await adminQuery(`insert into public.electrolysis_entries (${cols.join(",")}) values (${vals.map((_, i) => `$${i + 1}`).join(",")})`, vals);
        if (c.deleted) await adminQuery(`update public.electrolysis_entries set deleted_at = now() where block_id = $1`, [s.blockId]);
        entryRow = { ...c.entry, deleted_at: c.deleted ? new Date() : null };
      }
      const db = (await adminQuery(`select public.block_holds_legacy_readings($1) h`, [s.blockId])).rows[0].h as boolean;
      const blockRow = (await adminQuery(`select mode, apilus_modality, energy_level, machine_frequency from public.session_blocks where id=$1`, [s.blockId])).rows[0];
      expect(blockHoldsLegacyReadings(blockRow, entryRow ? [entryRow] : []), `${c.name}: application vs database`).toBe(db);
      expect(db, c.name).toBe(c.reading);
    }
  });

  it("concurrent saves on one block never deadlock (no 40P01), across reading writes and identity changes in both orders", async () => {
    const S = await seedOn("sw-deadlock");
    for (let round = 0; round < 6; round++) {
      const s = await seedSession(S);
      await adminQuery(`update public.session_blocks set machine_profile_id=$2, machine_mode_key='thermolysis' where id=$1`, [s.blockId, PUR]);
      const ins = () => adminQuery(`insert into public.electrolysis_entries (session_id, block_id, area, mode, thermolysis_intensity_percent) values ($1,$2,'Upper lip','thermo',40)`, [s.sessionId, s.blockId]);
      const chg = (mode: string) => adminQuery(`update public.session_blocks set machine_mode_key=$2 where id=$1`, [s.blockId, mode]);
      const out = await Promise.allSettled([ins(), chg("galvanic"), ins(), chg("blend"), ins(), chg("thermolysis")]);
      for (const r of out) if (r.status === "rejected") expect((r.reason as { code?: string }).code, String((r.reason as Error).message)).not.toBe("40P01");
    }
  });

  it("ensure goes through the shared writability guard and refuses a finalized or void session", async () => {
    const src = (await adminQuery(`select prosrc from pg_proc where proname='ensure_studio_machine_for_save'`)).rows[0].prosrc as string;
    expect(src).toMatch(/assert_session_writable/);
    const S = await seedOn("sw-final");
    const s = await seedSession(S);
    expect(await ensure(S.userId, s.blockId, PUR)).toMatch(/^[0-9a-f-]{36}$/);
    const S2 = await seedOn("sw-final2");
    const s2 = await seedSession(S2);
    await seedLegacyRecordStatus(s2.sessionId, "finalized");
    expect((await failure(ensure(S2.userId, s2.blockId, PUR)))?.message).toBe("Not available.");
    expect(Number((await adminQuery(`select count(*)::int n from public.studio_machines where studio_id=$1`, [S2.studioId])).rows[0].n)).toBe(0);
  });

  it("native MultiPlex readings do NOT freeze the identity (each reading carries its own unit, model and mode; the existing unit correction stays possible)", async () => {
    const S = await seedOn("sw-native");
    const s = await seedSession(S);
    const unit = await unitOf(S.studioId, PUR, 1);
    await adminQuery(`update public.session_blocks set machine_profile_id=$2, studio_machine_id=$3, machine_mode_key='multiplex' where id=$1`, [s.blockId, PUR, unit]);
    await adminTx(async (q) => {
      await q(`set local session_replication_role = replica`); // a bare reading row; the capture parent is not the subject here
      await q(`insert into public.treatment_setup_readings (studio_id, session_block_id, studio_machine_id, machine_profile_id, machine_profile_version, mode_key, group_key, field_key, value_numeric, native_unit, decimals, observation_source, capture_id)
               values ($1,$2,$3,$4,1,'multiplex','g','slow_duration',2,'s',0,'practitioner-entered',$5)`, [S.studioId, s.blockId, unit, PUR, randomUUID()]);
    });
    expect((await adminQuery(`select public.block_holds_legacy_readings($1) h`, [s.blockId])).rows[0].h).toBe(false);
    expect(await failure(adminQuery(`update public.session_blocks set machine_mode_key='flash' where id=$1`, [s.blockId]))).toBeNull();
  });

  it("ensure answers a unit id or one of three refusal codes (name_taken shown here; retired and unpublished above); the application treats any non-id text as a refusal", async () => {
    const S = await seedOn("sw-codes");
    const s = await seedSession(S);
    const other = await unitOf(S.studioId, SEN, 3);
    await adminQuery(`update public.studio_machines set display_name = 'Dectro xCell' where id = $1`, [other]);
    expect(await ensure(S.userId, s.blockId, PUR)).toBe("name_taken");
  });
});

describe("the down", () => {
  const DOWN_PATH = "supabase/rollbacks/0366_machine_switches.down.sql";

  it("REFUSES while a block holds a Pur identity; nothing is dropped", async () => {
    const S = await seedOn("sw-down");
    const s = await seedSession(S);
    await identity(s.blockId, S.studioId, PUR, null, "thermolysis");
    const e = await failure(adminQuery(readFileSync(DOWN_PATH, "utf8")));
    expect(e?.message).toMatch(/blocks hold an xCell Pur identity/);
    expect((await adminQuery(`select to_regclass('public.studio_machine_models') as t`)).rows[0].t).not.toBeNull();
    expect((await adminQuery(`select md5(prosrc) m from pg_proc where proname='apply_block_machine_identity'`)).rows[0].m).not.toBe("218c39a20344d2effd4d934f702b0338");
  });

  it("restores the previous function body byte for byte (the down text carries it unchanged)", () => {
    const orig = readFileSync("supabase/migrations/0310_block_machine_identity_mode_contract.sql", "utf8");
    const a = orig.indexOf("create or replace function public.apply_block_machine_identity(");
    const body = orig.slice(a, orig.indexOf("$$;", a) + 3);
    expect(readFileSync(DOWN_PATH, "utf8")).toContain(body);
  });
});

describe("the owner's switch decides, old history is not needed, and the unit comes only from a successful first save", () => {
  const unitCount = async (studio: string) =>
    Number((await adminQuery(`select count(*)::int n from public.studio_machines where studio_id=$1 and machine_profile_id=$2`, [studio, PUR])).rows[0].n);

  it("NO HISTORY: a studio with no machine, no legacy xCell entry and no unit is refused until its owner turns the model on; turning it on creates nothing; the first save creates exactly one", async () => {
    const S = await seedOff("sw-nohist");
    const sess = await seedSession(S);
    expect(await unitCount(S.studioId)).toBe(0);
    expect((await failure(ensure(S.userId, sess.blockId, PUR)))?.message).toMatch(/not switched on/);
    expect(await unitCount(S.studioId)).toBe(0);
    expect(await setModel(S.userId, S.studioId, PUR, true)).toBe("changed");
    expect(await unitCount(S.studioId), "the switch alone creates no machine record").toBe(0);
    const id = await ensure(S.userId, sess.blockId, PUR);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await unitCount(S.studioId)).toBe(1);
    expect(await ensure(S.userId, sess.blockId, PUR), "a double save returns the same unit").toBe(id);
    expect(await unitCount(S.studioId)).toBe(1);
  });

  it("THE WRONG MODEL IS ON: only Senior is switched on, so the xCell first save is refused and creates nothing", async () => {
    const S = await seedOff("sw-wrongmodel");
    const sess = await seedSession(S);
    expect(await setModel(S.userId, S.studioId, SEN, true)).toBe("changed");
    expect((await failure(ensure(S.userId, sess.blockId, PUR)))?.message).toMatch(/not switched on/);
    expect(await unitCount(S.studioId)).toBe(0);
  });

  it("FIRST SAVE ONLY AFTER SUCCESS: a block whose save was rolled back, a block that does not exist and a deleted block give no unit", async () => {
    const S = await seedStudio("sw-failedsave");
    await setModel(S.userId, S.studioId, PUR, true);
    const sess = await seedSession(S);
    const lostBlock = randomUUID();
    await failure(adminTx(async (q) => {
      await q(`insert into public.session_blocks (id, studio_id, session_id) values ($1,$2,$3)`, [lostBlock, S.studioId, sess.sessionId]);
      throw new Error("the save failed after the block insert");
    }));
    expect((await failure(ensure(S.userId, lostBlock, PUR)))?.message).toBe("Not available.");
    expect((await failure(ensure(S.userId, randomUUID(), PUR)))?.message).toBe("Not available.");
    await adminQuery(`update public.session_blocks set deleted_at = now() where id = $1`, [sess.blockId]);
    expect((await failure(ensure(S.userId, sess.blockId, PUR)))?.message).toBe("Not available.");
    expect(await unitCount(S.studioId)).toBe(0);
    // a live block inside a SOFT-DELETED session is not a save either
    const sess2 = await seedSession(S);
    await adminQuery(`update public.sessions set deleted_at = now() where id = $1`, [sess2.sessionId]);
    expect((await failure(ensure(S.userId, sess2.blockId, PUR)))?.message).toBe("Not available.");
    expect(await unitCount(S.studioId)).toBe(0);
  });

  it("another studio's owner cannot switch this studio's model on, and a receptionist (no practitioner row) cannot save into it", async () => {
    const S = await seedOff("sw-others");
    const other = await seedStudio("sw-others-b");
    const sess = await seedSession(S);
    expect((await failure(setModel(other.userId, S.studioId, PUR, true)))?.message).toBe("Not available.");
    expect((await models(S.studioId))[PUR]).toBe(false);
    await setModel(S.userId, S.studioId, PUR, true);
    expect((await failure(ensure(recept, sess.blockId, PUR)))?.message).toBe("Not available.");
    expect(await unitCount(S.studioId)).toBe(0);
  });
});
