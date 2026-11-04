import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { releaseAllKeys } from "./helpers/permission-release";
import { adminQuery, asRole, asUser, closePool, seedMember, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";

// 0288 section 1 (held): has_studio_permission_for_target, the actor-explicit permission function (Q-1), proved on the real migrated database.
// Synthetic values only. NOT RUN until an owned isolated stack exists with 0287 and 0288 applied.

type Target = { kind: "appointment" | "session" | "attempt" | "client"; id: string; client: string | null; appt: string | null; pract: string | null };
type Who = { label: string; userId: string };

const SQL_JWT = "select public.has_studio_permission($1,$2,$3,$4,$5) as r";
const SQL_EXPLICIT = "select public.has_studio_permission_for_target($1,$2,$3,$4) as r";

let slot = 0; // a distinct hour per appointment: the studio forbids overlapping appointments
async function seedAppt(studio: SeededStudio, practitionerId: string, clientId: string): Promise<string> {
  const id = randomUUID();
  const h = String((slot += 1) * 2);
  await adminQuery(
    `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
     values ($1,$2,$3,$4, now() + interval '3 days' + ($5 || ' hours')::interval, now() + interval '3 days' + ($5 || ' hours')::interval + interval '30 minutes', 30, 'confirmed')`,
    [id, studio.studioId, practitionerId, clientId, h],
  );
  return id;
}
async function seedSessionFor(studio: SeededStudio, practitionerId: string, apptId: string | null): Promise<string> {
  const { sessionId } = await seedSession(studio);
  await adminQuery("update public.sessions set practitioner_id=$2, appointment_id=$3 where id=$1", [sessionId, practitionerId, apptId]);
  return sessionId;
}
async function seedAttempt(studio: SeededStudio, sessionId: string, apptId: string | null): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.payment_charge_attempts (id, studio_id, client_id, session_id, appointment_id, charge_reason, created_by_practitioner_id, amount_cents, status)
     values ($1,$2,$3,$4,$5,'session_payment',$6,2500,'ready')`,
    [id, studio.studioId, studio.clientId, sessionId, apptId, studio.practitionerId],
  );
  return id;
}

let A: SeededStudio;
let B: SeededStudio;
let prac: { userId: string; practitionerId: string };
let prac2: { userId: string; practitionerId: string };
let gone: { userId: string; practitionerId: string };
let desk: { userId: string; id: string };
let targets: Target[] = [];
let who: Who[] = [];
let keys: { key: string; own_kind: string | null }[] = [];

beforeAll(async () => {
  A = await seedStudio("actor-a");
  B = await seedStudio("actor-b");
  prac = await seedMember(A, "pa");
  prac2 = await seedMember(A, "pb");
  gone = await seedMember(A, "gone");
  const deskUser = randomUUID();
  await adminQuery("insert into auth.users(id,email) values ($1,$2)", [deskUser, `desk-${deskUser.slice(0, 8)}@harness.local`]);
  const r = await adminQuery(
    "insert into public.studio_receptionists(studio_id,user_id,display_name,email,active) values ($1,$2,'Desk',$3,true) returning id",
    [A.studioId, deskUser, `desk-${deskUser.slice(0, 8)}@harness.local`],
  );
  desk = { userId: deskUser, id: r.rows[0].id };
  await releaseAllKeys();
  await adminQuery("update public.practitioners set active=false where id=$1", [gone.practitionerId]);

  const apptOwn = await seedAppt(A, prac.practitionerId, A.clientId);
  const apptOther = await seedAppt(A, prac2.practitionerId, A.clientId);
  const sOwn = await seedSessionFor(A, prac.practitionerId, apptOwn);
  const sOther = await seedSessionFor(A, prac2.practitionerId, apptOther);
  const sNoAppt = await seedSessionFor(A, prac.practitionerId, null);
  const apptVia = await seedAppt(A, prac.practitionerId, A.clientId);
  const sVia = await seedSessionFor(A, prac.practitionerId, apptVia); // one active session_payment attempt per session: a second session for the via-session case
  const atOwn = await seedAttempt(A, sOwn, apptOwn);
  const atViaSession = await seedAttempt(A, sVia, null); // appointment derived through the session
  const atOther = await seedAttempt(A, sOther, apptOther);
  const atNoAppt = await seedAttempt(A, sNoAppt, null);
  targets = [
    { kind: "appointment", id: apptOwn, client: A.clientId, appt: apptOwn, pract: prac.practitionerId },
    { kind: "appointment", id: apptOther, client: A.clientId, appt: apptOther, pract: prac2.practitionerId },
    { kind: "session", id: sOwn, client: A.clientId, appt: apptOwn, pract: prac.practitionerId },
    { kind: "session", id: sOther, client: A.clientId, appt: apptOther, pract: prac2.practitionerId },
    { kind: "session", id: sNoAppt, client: A.clientId, appt: null, pract: prac.practitionerId },
    { kind: "attempt", id: atOwn, client: A.clientId, appt: apptOwn, pract: prac.practitionerId },
    { kind: "attempt", id: atViaSession, client: A.clientId, appt: apptVia, pract: prac.practitionerId },
    { kind: "attempt", id: atOther, client: A.clientId, appt: apptOther, pract: prac2.practitionerId },
    { kind: "attempt", id: atNoAppt, client: A.clientId, appt: null, pract: prac.practitionerId },
    { kind: "client", id: A.clientId, client: A.clientId, appt: null, pract: null },
  ];
  who = [
    { label: "owner", userId: A.userId },
    { label: "practitioner", userId: prac.userId },
    { label: "other practitioner", userId: prac2.userId },
    { label: "receptionist", userId: desk.userId },
    { label: "removed staff", userId: gone.userId },
    { label: "other studio owner", userId: B.userId },
    { label: "stranger", userId: randomUUID() },
  ];
  keys = (await adminQuery("select key, own_kind from public.permission_catalog order by key")).rows;
});
afterAll(async () => closePool());

// One batch of explicit answers per base. The JWT side runs per user (it needs auth.uid()); the explicit side runs once as service_role.
async function matrix(): Promise<{ compared: number; trues: number; falses: number; diffs: string[] }> {
  const explicit = new Map<string, boolean>();
  await asRole("service_role", async (q) => {
    for (const w of who) for (const t of targets) for (const k of keys) {
      explicit.set(`${w.label}|${t.kind}:${t.id}|${k.key}`, (await q(SQL_EXPLICIT, [w.userId, k.key, t.kind, t.id])).rows[0].r as boolean);
    }
  });
  let compared = 0, trues = 0, falses = 0;
  const diffs: string[] = [];
  for (const w of who) {
    await asUser(w.userId, async (q) => {
      for (const t of targets) for (const k of keys) {
        const jwt = (await q(SQL_JWT, [A.studioId, k.key, t.client, t.appt, t.pract])).rows[0].r as boolean;
        const exp = explicit.get(`${w.label}|${t.kind}:${t.id}|${k.key}`);
        compared += 1;
        if (jwt) trues += 1; else falses += 1;
        if (jwt !== exp) diffs.push(`${w.label} ${t.kind} ${k.key}: jwt=${jwt} explicit=${exp}`);
      }
    });
  }
  return { compared, trues, falses, diffs };
}

describe("parity: the JWT-called function and the explicit function give the same answer", () => {
  it("base 1 (no stored values: snapshots and gates): every user class x every catalog key x every target kind agrees", async () => {
    const m = await matrix();
    expect(m.diffs.slice(0, 10)).toEqual([]);
    expect(m.compared).toBe(who.length * targets.length * keys.length);
    expect(m.trues, "matrix is not vacuous: some answers are true").toBeGreaterThan(0);
    expect(m.falses, "matrix is not vacuous: some answers are false").toBeGreaterThan(0);
  }, 300_000);

  it("base 2 (stored values: practitioner own, receptionist studio, wherever the key allows): still agrees, and own-scope differs by target", async () => {
    for (const k of keys) {
      const def = (await adminQuery("select scopes, owner_configurable from public.permission_catalog where key=$1", [k.key])).rows[0];
      if (!def.owner_configurable) continue;
      const scopes: string[] = def.scopes;
      const prScope = scopes.includes("own") ? "own" : scopes.includes("studio") ? "studio" : null;
      if (prScope) await adminQuery("insert into public.studio_role_permissions(studio_id,role,key,scope) values ($1,'practitioner',$2,$3) on conflict (studio_id,role,key) do update set scope=excluded.scope", [A.studioId, k.key, prScope]);
      if (scopes.includes("studio")) await adminQuery("insert into public.studio_role_permissions(studio_id,role,key,scope) values ($1,'receptionist',$2,'studio') on conflict (studio_id,role,key) do update set scope=excluded.scope", [A.studioId, k.key]);
    }
    const m = await matrix();
    expect(m.diffs.slice(0, 10)).toEqual([]);
    expect(m.trues).toBeGreaterThan(0);
    expect(m.falses).toBeGreaterThan(0);
    const apptKey = keys.find((k) => k.own_kind === "appointment" && k.key.startsWith("appt."))?.key;
    expect(apptKey, "an appointment own-scope key exists").toBeDefined();
    const ask = (user: string, kind: string, id: string) => asRole("service_role", async (q) => (await q(SQL_EXPLICIT, [user, apptKey, kind, id])).rows[0].r as boolean);
    // On a key where the practitioner holds `own`, their own appointment passes and a colleague's does not (when the engine grants own at all).
    const ownAppt = targets[0], otherAppt = targets[1];
    const mine = await ask(prac.userId, "appointment", ownAppt.id);
    const theirs = await ask(prac.userId, "appointment", otherAppt.id);
    if (mine) expect(theirs).toBe(false);
  }, 300_000);
});

describe("the studio comes from the target; nothing else can name one", () => {
  it("another studio's owner is refused on every target and key; the owner of the target's studio holds every catalogued key", async () => {
    await asRole("service_role", async (q) => {
      for (const t of targets) for (const k of keys) {
        expect((await q(SQL_EXPLICIT, [B.userId, k.key, t.kind, t.id])).rows[0].r, `${t.kind} ${k.key}`).toBe(false);
        expect((await q(SQL_EXPLICIT, [A.userId, k.key, t.kind, t.id])).rows[0].r, `${t.kind} ${k.key}`).toBe(true);
      }
    });
  }, 120_000);

  it("a removed (inactive) member and a stranger are refused; a deactivated owner is refused", async () => {
    const s = await seedStudio("actor-owner-off");
    const second = await seedMember(s, "o2");
    await adminQuery("update public.practitioners set role='owner' where id=$1", [second.practitionerId]);
    const key = keys[0].key;
    const ask = (u: string) => asRole("service_role", async (q) => (await q(SQL_EXPLICIT, [u, key, "client", s.clientId])).rows[0].r as boolean);
    expect(await ask(second.userId)).toBe(true);
    await adminQuery("update public.practitioners set active=false where id=$1", [second.practitionerId]);
    expect(await ask(second.userId)).toBe(false);
    expect(await ask(randomUUID())).toBe(false);
  });

  it("an unknown kind, an unknown key, a missing target, and null arguments all answer false", async () => {
    const t = targets[0];
    await asRole("service_role", async (q) => {
      const ask = async (...p: unknown[]) => (await q(SQL_EXPLICIT, p)).rows[0].r;
      expect(await ask(A.userId, keys[0].key, "studio", A.studioId)).toBe(false); // not a target kind: a studio id cannot be passed as one
      expect(await ask(A.userId, keys[0].key, "appointment", randomUUID())).toBe(false);
      expect(await ask(A.userId, "no.such_key", t.kind, t.id)).toBe(false);
      expect(await ask(null, keys[0].key, t.kind, t.id)).toBe(false);
      expect(await ask(A.userId, null, t.kind, t.id)).toBe(false);
      expect(await ask(A.userId, keys[0].key, null, t.id)).toBe(false);
      expect(await ask(A.userId, keys[0].key, t.kind, null)).toBe(false);
    });
  });

  it("a target with no appointment cannot satisfy an own-appointment key; an attempt derives its appointment through its session", async () => {
    const own = targets.find((t) => t.kind === "session" && t.appt === null)!;
    const viaSession = targets.find((t) => t.kind === "attempt" && t.appt !== null && t.id !== targets[5].id)!;
    const key = keys.find((k) => k.own_kind === "appointment")!.key;
    await adminQuery("insert into public.studio_role_permissions(studio_id,role,key,scope) values ($1,'practitioner',$2,'own') on conflict (studio_id,role,key) do update set scope='own'", [A.studioId, key]);
    const r = await asRole("service_role", async (q) => ({
      noAppt: (await q(SQL_EXPLICIT, [prac.userId, key, own.kind, own.id])).rows[0].r as boolean,
      viaSession: (await q(SQL_EXPLICIT, [prac.userId, key, viaSession.kind, viaSession.id])).rows[0].r as boolean,
      viaSessionOther: (await q(SQL_EXPLICIT, [prac2.userId, key, viaSession.kind, viaSession.id])).rows[0].r as boolean,
    }));
    expect(r.noAppt, "own scope with no appointment fails closed").toBe(false);
    expect(r.viaSessionOther, "a colleague is not the assigned practitioner").toBe(false);
    // viaSession is true only when the engine grants this key at own scope to a practitioner; it must equal the JWT answer for the same inputs.
    const jwt = await asUser(prac.userId, async (q) => (await q(SQL_JWT, [A.studioId, key, viaSession.client, viaSession.appt, viaSession.pract])).rows[0].r as boolean);
    expect(r.viaSession).toBe(jwt);
  });
});

describe("privileges: the explicit function is service_role only; the helpers are callable by nobody through the API", () => {
  const fns = [
    "public.has_studio_permission_for_target(uuid,text,text,uuid)",
    "public.perm_actor_of(uuid,uuid)",
    "public.perm_decide(uuid,text,uuid,text,uuid,uuid,uuid)",
  ];
  it("has_function_privilege, by role", async () => {
    for (const f of fns) {
      for (const role of ["anon", "authenticated"]) {
        expect((await adminQuery("select has_function_privilege($1, $2::regprocedure, 'execute') as r", [role, f])).rows[0].r, `${role} ${f}`).toBe(false);
      }
      expect((await adminQuery("select has_function_privilege('service_role', $1::regprocedure, 'execute') as r", [f])).rows[0].r, `service_role ${f}`).toBe(f.includes("for_target"));
      const publicAcl = (await adminQuery("select count(*)::int n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::regprocedure and a.grantee = 0", [f])).rows[0].n;
      expect(publicAcl, `PUBLIC ${f}`).toBe(0);
    }
  });
  it("an authenticated caller, even the studio owner, is refused: it is not an oracle", async () => {
    await expect(asUser(A.userId, async (q) => q(SQL_EXPLICIT, [prac.userId, keys[0].key, "client", A.clientId]))).rejects.toThrow(/permission denied/i);
    await expect(asRole("anon", async (q) => q(SQL_EXPLICIT, [prac.userId, keys[0].key, "client", A.clientId]))).rejects.toThrow(/permission denied/i);
  });
  it("0287 grants are unchanged by the re-creation: has_studio_permission stays authenticated-only, perm_actor stays internal", async () => {
    const can = async (role: string, f: string) => (await adminQuery("select has_function_privilege($1, $2::regprocedure, 'execute') as r", [role, f])).rows[0].r as boolean;
    expect(await can("authenticated", "public.has_studio_permission(uuid,text,uuid,uuid,uuid)")).toBe(true);
    expect(await can("anon", "public.has_studio_permission(uuid,text,uuid,uuid,uuid)")).toBe(false);
    expect(await can("service_role", "public.has_studio_permission(uuid,text,uuid,uuid,uuid)")).toBe(false);
    for (const role of ["anon", "authenticated", "service_role"]) expect(await can(role, "public.perm_actor(uuid)"), `${role} perm_actor`).toBe(false);
  });
  it("all three new functions are SECURITY DEFINER with a pinned empty search_path", async () => {
    const rows = (await adminQuery(
      "select proname, prosecdef, proconfig from pg_proc where pronamespace='public'::regnamespace and proname in ('has_studio_permission_for_target','perm_actor_of','perm_decide','has_studio_permission','perm_actor')",
    )).rows;
    expect(rows.length).toBe(5);
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(r.proconfig, r.proname).toContain('search_path=""');
    }
  });
});
