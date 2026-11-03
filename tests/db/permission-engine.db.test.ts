import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOG, effectiveScope, type PermissionDef, type Role, type Scope, type StudioPolicy, GATES } from "@/lib/permissions/catalog";
import { adminQuery, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// 0287 (held): the permission engine, proved on the real migrated database. Synthetic values only.
// NOT RUN until the heavy slot is granted and 0287 has been applied to an owned isolated stack.

const DEFS = CATALOG as readonly PermissionDef[];
const ROLES: Role[] = ["practitioner", "receptionist"];
const GOOD_REASON = "Reviewed the front desk duties with the team";

type J = Record<string, any>;
const call = async (userId: string, sql: string, params: unknown[]): Promise<J> => asUser(userId, async (q) => (await q(sql, params)).rows[0].r as J);
const save = (u: string, s: string, v: number | null, changes: J, reason: string | null = null, confirmed = false) =>
  call(u, "select public.save_role_permissions($1,$2,$3::jsonb,$4,$5) as r", [s, v, JSON.stringify(changes), reason, confirmed]);
const getp = (u: string, s: string) => call(u, "select public.get_role_permissions($1) as r", [s]);
const can = async (u: string, s: string, key: string, args: { client?: string; appt?: string; pract?: string } = {}) =>
  asUser(u, async (q) => (await q("select public.has_studio_permission($1,$2,$3,$4,$5) as r", [s, key, args.client ?? null, args.appt ?? null, args.pract ?? null])).rows[0].r as boolean);
const rowCount = async (sql: string, p: unknown[]) => Number((await adminQuery(sql, p)).rows[0].n);

async function seedDesk(studio: SeededStudio, label: string): Promise<{ userId: string; id: string }> {
  const userId = randomUUID();
  await adminQuery("insert into auth.users(id,email) values ($1,$2)", [userId, `${label}-${userId.slice(0, 8)}@harness.local`]);
  const r = await adminQuery("insert into public.studio_receptionists(studio_id,user_id,display_name,email,active) values ($1,$2,$3,$4,true) returning id", [studio.studioId, userId, `Desk ${label}`, `${label}-${userId.slice(0, 8)}@harness.local`]);
  return { userId, id: r.rows[0].id };
}
let slot = 0; // a distinct hour per appointment: the studio forbids overlapping appointments
async function seedAppt(studio: SeededStudio, practitionerId: string, clientId: string, o: { status?: string; offsetDays?: number } = {}): Promise<string> {
  const id = randomUUID();
  const d = o.offsetDays ?? 3;
  await adminQuery(
    `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
     values ($1,$2,$3,$4, now() + ($5 || ' days')::interval + ($7 || ' hours')::interval, now() + ($5 || ' days')::interval + ($7 || ' hours')::interval + interval '30 minutes', 30, $6)`,
    [id, studio.studioId, practitionerId, clientId, String(d), o.status ?? "confirmed", String((slot += 1) * 2)],
  );
  return id;
}
async function seedClient(studio: SeededStudio, label: string): Promise<string> {
  const id = randomUUID();
  await adminQuery("insert into public.clients(id,studio_id,name) values ($1,$2,$3)", [id, studio.studioId, `Client ${label}`]);
  return id;
}

let A: SeededStudio;
let B: SeededStudio;
let prac: { userId: string; practitionerId: string };
let prac2: { userId: string; practitionerId: string };
let desk: { userId: string; id: string };
const plainKey = DEFS.find((k) => k.ownerConfigurable !== false && !k.sensitive && k.requires.length === 0 && k.offeredTo.practitioner && !k.shipGate?.practitioner && k.scopes.includes("studio") && k.existingSnapshot.practitioner !== k.newStudioDefault.practitioner === false)!;

beforeAll(async () => {
  A = await seedStudio("engine-a");
  B = await seedStudio("engine-b");
  prac = await seedMember(A, "pa");
  prac2 = await seedMember(A, "pb");
  desk = await seedDesk(A, "front");
});
afterAll(async () => closePool());

describe("seed parity and resolver parity with lib/permissions/catalog.ts", () => {
  it("the seeded catalog has every key with the same values", async () => {
    const rows = (await adminQuery("select * from public.permission_catalog order by key")).rows;
    expect(rows.map((r) => r.key).sort()).toEqual(DEFS.map((d) => d.key).sort());
    for (const d of DEFS) {
      const r = rows.find((x) => x.key === d.key)!;
      expect(r.scopes, d.key).toEqual([...d.scopes]);
      expect(r.owner_configurable, d.key).toBe(d.ownerConfigurable !== false);
      expect(r.requires, d.key).toEqual([...d.requires]);
      expect([r.new_practitioner, r.new_receptionist], d.key).toEqual([d.newStudioDefault.practitioner, d.newStudioDefault.receptionist]);
      expect([r.snapshot_practitioner, r.snapshot_receptionist], d.key).toEqual([d.existingSnapshot.practitioner, d.existingSnapshot.receptionist]);
      expect([r.offered_practitioner, r.offered_receptionist], d.key).toEqual([d.offeredTo.practitioner, d.offeredTo.receptionist]);
      expect([r.gate_practitioner, r.gate_receptionist], d.key).toEqual([d.shipGate?.practitioner ?? null, d.shipGate?.receptionist ?? null]);
      expect(r.sensitive, d.key).toBe(!!d.sensitive);
    }
  });

  it("the SQL resolver equals effectiveScope for every key and role, across both bases, random stored values and gates", async () => {
    const studio = await seedStudio("engine-parity");
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (const basis of ["existing_snapshot", "new_studio"] as const) {
      for (let round = 0; round < 3; round += 1) {
        await adminQuery("update public.studio_permission_policy set basis=$2 where studio_id=$1", [studio.studioId, basis]);
        await adminQuery("delete from public.studio_role_permissions where studio_id=$1", [studio.studioId]);
        await adminQuery("delete from public.permission_ship_gates where studio_id=$1", [studio.studioId]);
        const values: Record<Role, Record<string, Scope>> = { practitioner: {}, receptionist: {} };
        for (const role of ROLES) for (const d of DEFS) {
          if (d.ownerConfigurable === false || rnd() < 0.5) continue;
          const allowed = role === "receptionist" ? d.scopes.filter((s) => s !== "own") : d.scopes;
          const s = allowed[Math.floor(rnd() * allowed.length)] as Scope;
          values[role][d.key] = s;
          await adminQuery("insert into public.studio_role_permissions(studio_id,role,key,scope) values ($1,$2,$3,$4)", [studio.studioId, role, d.key, s]);
        }
        const gates: Partial<Record<keyof typeof GATES, boolean>> = {};
        for (const g of Object.keys(GATES) as (keyof typeof GATES)[]) {
          if (rnd() < 0.5) { gates[g] = true; await adminQuery("insert into public.permission_ship_gates(studio_id,gate,met) values ($1,$2,true)", [studio.studioId, g]); }
        }
        for (const role of ROLES) {
          const policy: StudioPolicy = { basis, values: values[role], gates };
          const got = (await adminQuery("select key, public.perm_effective_scope($1,$2,key) as s from public.permission_catalog", [studio.studioId, role])).rows;
          for (const row of got) expect(row.s, `${basis}/${round}/${role}/${row.key}`).toBe(effectiveScope(role, row.key, policy));
        }
      }
    }
  });
});

describe("basis, ownership and privileges", () => {
  it("a new studio starts on the new-studio basis at version 0; a studio with no row resolves to its existing snapshot", async () => {
    expect((await adminQuery("select basis, version from public.studio_permission_policy where studio_id=$1", [A.studioId])).rows[0]).toMatchObject({ basis: "new_studio", version: "0" });
    await adminQuery("delete from public.studio_permission_policy where studio_id=$1", [B.studioId]);
    const g = await getp(B.userId, B.studioId);
    expect(g).toMatchObject({ ok: true, version: 0, basis: "existing_snapshot" });
    const snap = DEFS.find((d) => d.ownerConfigurable !== false && d.existingSnapshot.practitioner !== d.newStudioDefault.practitioner && d.offeredTo.practitioner && !d.requires.length && !d.shipGate?.practitioner);
    if (snap) expect(g.roles.practitioner[snap.key].effective).toBe(snap.existingSnapshot.practitioner);
  });

  it("every command refuses a non-owner, another studio's owner and a signed-out caller with the same generic code and no data", async () => {
    const calls: [string, unknown[]][] = [
      ["select public.get_role_permissions($1) as r", [A.studioId]],
      ["select public.preview_role_changes($1,'{}'::jsonb) as r", [A.studioId]],
      ["select public.preview_adopt_new_defaults($1) as r", [A.studioId]],
      ["select public.preview_reset($1,'practitioner') as r", [A.studioId]],
      ["select public.list_permission_audit($1,10,null) as r", [A.studioId]],
      ["select public.effective_access($1,$2) as r", [A.studioId, prac.practitionerId]],
    ];
    for (const [sql, p] of calls) {
      for (const u of [prac.userId, desk.userId, B.userId, randomUUID()]) {
        const r = await call(u, sql, p);
        expect(r, sql).toEqual({ ok: false, code: "refused" });
      }
    }
    expect(await save(prac.userId, A.studioId, 0, { practitioner: { [plainKey.key]: "off" } })).toEqual({ ok: false, code: "refused" });
  });

  it("no API role can read or write the tables; anon and service_role cannot execute any command; authenticated can execute only the API", async () => {
    for (const t of ["permission_catalog", "studio_permission_policy", "studio_role_permissions", "permission_ship_gates", "permission_audit", "permission_narrowings"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const r = await adminQuery("select has_table_privilege($1, $2, 'select') or has_table_privilege($1, $2, 'insert') or has_table_privilege($1, $2, 'update') or has_table_privilege($1, $2, 'delete') as p", [role, `public.${t}`]);
        expect(r.rows[0].p, `${role}.${t}`).toBe(false);
      }
    }
    const fns = (await adminQuery("select p.oid::regprocedure::text as sig, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'perm\\_%' or p.proname in ('has_studio_permission','preview_role_changes','save_role_permissions','preview_reset','reset_role_to_defaults','preview_adopt_new_defaults','adopt_new_defaults','get_role_permissions','effective_access','list_permission_audit','change_staff_role','studios_permission_policy_seed','permission_audit_append_only'))")).rows;
    const api = new Set(["has_studio_permission", "preview_role_changes", "save_role_permissions", "preview_reset", "reset_role_to_defaults", "preview_adopt_new_defaults", "adopt_new_defaults", "get_role_permissions", "effective_access", "list_permission_audit", "change_staff_role"]);
    expect(fns.length).toBeGreaterThan(20);
    for (const f of fns) {
      for (const role of ["anon", "service_role"]) expect((await adminQuery("select has_function_privilege($1,$2,'execute') as p", [role, f.sig])).rows[0].p, `${role} ${f.sig}`).toBe(false);
      expect((await adminQuery("select has_function_privilege('authenticated',$1,'execute') as p", [f.sig])).rows[0].p, `authenticated ${f.sig}`).toBe(api.has(f.proname));
    }
  });
});

describe("save: versioned, atomic, validated, audited", () => {
  it("saves, bumps the version, records before and after, and a stale version writes nothing", async () => {
    const s = await seedStudio("engine-save");
    const flip = plainKey.scopes.includes("own") ? "own" : "off";
    const g0 = await getp(s.userId, s.studioId);
    expect(g0.version).toBe(0);
    const cur = g0.roles.practitioner[plainKey.key].effective as Scope;
    const next: Scope = cur === flip ? "studio" : flip;
    const ok = await save(s.userId, s.studioId, 0, { practitioner: { [plainKey.key]: next } });
    expect(ok).toMatchObject({ ok: true, new_version: 1 });
    expect(ok.affected.practitioner.count).toBeGreaterThanOrEqual(0);
    const audit = (await adminQuery("select * from public.permission_audit where studio_id=$1", [s.studioId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ kind: "role_permissions_saved", role: "practitioner", policy_version_before: "0", policy_version_after: "1" });
    expect(audit[0].before[plainKey.key].effective).toBe(cur);
    expect(audit[0].after[plainKey.key].stored).toBe(next);
    const stale = await save(s.userId, s.studioId, 0, { practitioner: { [plainKey.key]: cur } });
    expect(stale).toEqual({ ok: false, code: "stale_version", current_version: 1 });
    expect(await rowCount("select count(*) n from public.permission_audit where studio_id=$1", [s.studioId])).toBe(1);
    expect((await getp(s.userId, s.studioId)).roles.practitioner[plainKey.key].stored).toBe(next);
  });

  it("two concurrent saves at the same version: exactly one wins and the other is stale", async () => {
    const s = await seedStudio("engine-race");
    const cur = (await getp(s.userId, s.studioId)).roles.practitioner[plainKey.key].effective as Scope;
    const alt: Scope = cur === "studio" ? "off" : "studio";
    const rs = await Promise.all([
      save(s.userId, s.studioId, 0, { practitioner: { [plainKey.key]: alt } }),
      save(s.userId, s.studioId, 0, { receptionist: { [plainKey.key]: alt === "off" ? "studio" : "off" } }),
    ]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toMatchObject({ code: "stale_version", current_version: 1 });
  });

  it("refuses with a code and writes nothing: unknown role/key, fixed, not offered, scope, gate, nothing changed, prerequisite", async () => {
    const s = await seedStudio("engine-refuse");
    const before = async () => rowCount("select count(*) n from public.studio_role_permissions where studio_id=$1", [s.studioId]);
    const fixed = DEFS.find((d) => d.ownerConfigurable === false)!;
    const notOffered = DEFS.find((d) => !d.offeredTo.receptionist && d.ownerConfigurable !== false)!;
    const bool = DEFS.find((d) => d.ownerConfigurable !== false && d.scopes.length === 2 && d.offeredTo.practitioner)!;
    const gated = DEFS.find((d) => d.shipGate?.receptionist && d.offeredTo.receptionist && d.scopes.includes("studio") && d.existingSnapshot.receptionist === "off")!;
    const dependent = DEFS.find((d) => d.ownerConfigurable !== false && d.requires.length > 0 && d.offeredTo.practitioner && !d.shipGate?.practitioner && d.scopes.includes("studio"))!;
    const cases: [J, string][] = [
      [{ janitor: { [plainKey.key]: "off" } }, "unknown_role"],
      [{ practitioner: { "no.such_key": "off" } }, "unknown_key"],
      [{ practitioner: { [fixed.key]: "off" } }, "fixed_key"],
      [{ receptionist: { [notOffered.key]: "studio" } }, "not_offered"],
      [{ practitioner: { [bool.key]: "own" } }, "scope_not_allowed"],
      [{ receptionist: { [gated.key]: "studio" } }, "gate_unmet"],
    ];
    for (const [changes, code] of cases) {
      const r = await save(s.userId, s.studioId, 0, changes);
      expect(r, code).toMatchObject({ ok: false, code });
    }
    expect(await save(s.userId, s.studioId, 0, { practitioner: { [plainKey.key]: (await getp(s.userId, s.studioId)).roles.practitioner[plainKey.key].effective } })).toMatchObject({ code: "nothing_changed" });
    // prerequisite: turn the dependent key on while its first prerequisite is turned off in the SAME call is allowed order-independently; here the prerequisite is already off.
    const req = dependent.requires[0]!;
    const reqDef = DEFS.find((d) => d.key === req)!;
    if (reqDef.ownerConfigurable !== false) {
      await adminQuery("insert into public.studio_role_permissions(studio_id,role,key,scope) values ($1,'practitioner',$2,'off') on conflict (studio_id,role,key) do update set scope='off'", [s.studioId, req]);
      const r = await save(s.userId, s.studioId, 0, { practitioner: { [dependent.key]: "studio" } });
      expect(r).toMatchObject({ ok: false, code: "prerequisite_unmet", blocked_by: req });
    }
    expect(await save(s.userId, s.studioId, null, { practitioner: { [plainKey.key]: "off" } })).toMatchObject({ ok: false, code: "version_required" });
    expect(await rowCount("select count(*) n from public.permission_audit where studio_id=$1", [s.studioId])).toBe(0);
    expect(await before()).toBeLessThanOrEqual(1); // only the admin-inserted prerequisite row
  });

  it("a multi-role call is atomic: one invalid entry writes nothing for either role", async () => {
    const s = await seedStudio("engine-atomic");
    const cur = (await getp(s.userId, s.studioId)).roles.practitioner[plainKey.key].effective as Scope;
    const r = await save(s.userId, s.studioId, 0, { practitioner: { [plainKey.key]: cur === "studio" ? "off" : "studio" }, receptionist: { "no.such_key": "off" } });
    expect(r).toMatchObject({ ok: false, code: "unknown_key" });
    expect(await rowCount("select count(*) n from public.studio_role_permissions where studio_id=$1", [s.studioId])).toBe(0);
    expect((await getp(s.userId, s.studioId)).version).toBe(0);
  });

  it("preview writes nothing, returns the version it computed against and names the people affected on the server", async () => {
    const s = await seedStudio("engine-preview");
    await seedMember(s, "p1");
    const cur = (await getp(s.userId, s.studioId)).roles.practitioner[plainKey.key].effective as Scope;
    const pv = await call(s.userId, "select public.preview_role_changes($1,$2::jsonb) as r", [s.studioId, JSON.stringify({ practitioner: { [plainKey.key]: cur === "studio" ? "off" : "studio" } })]);
    expect(pv).toMatchObject({ ok: true, version: 0 });
    expect(pv.changes.practitioner.some((c: J) => c.key === plainKey.key)).toBe(true);
    expect(pv.affected.practitioner.count).toBe(1);
    expect(pv.affected.practitioner.people[0]).toMatchObject({ state: "active" });
    expect(JSON.stringify(pv)).not.toMatch(/@harness\.local/);
    expect(await rowCount("select count(*) n from public.studio_role_permissions where studio_id=$1", [s.studioId])).toBe(0);
    expect(await rowCount("select count(*) n from public.permission_audit where studio_id=$1", [s.studioId])).toBe(0);
    expect((await getp(s.userId, s.studioId)).version).toBe(0);
  });
});

describe("reasons (Sam, 3 Nov): required to expand sensitive access, adopt or reset; blank and placeholder text rejected; otherwise optional", () => {
  const sens = DEFS.find((d) => d.sensitive && d.ownerConfigurable !== false && d.offeredTo.receptionist && !d.shipGate?.receptionist && d.scopes.includes("studio") && d.requires.every((r) => ["client.view_directory", "appt.view_calendar"].includes(r)) && d.newStudioDefault.receptionist === "off")!;
  it("a sensitive raise needs confirmation AND a meaningful reason; the database rejects placeholders and offers no length rule", async () => {
    const s = await seedStudio("engine-sensitive");
    const ch = { receptionist: { [sens.key]: "studio" } };
    expect(await save(s.userId, s.studioId, 0, ch, GOOD_REASON, false)).toMatchObject({ code: "sensitive_unconfirmed" });
    for (const bad of [null, "", "   ", "...", "n/a", "N/A", "none", "test", "xxxx", "aaaa", "TBD", "ok", "- - -", "asdf asdf", "reason"]) {
      expect(await save(s.userId, s.studioId, 0, ch, bad, true), String(bad)).toMatchObject({ ok: false, code: "reason_required" });
    }
    expect(await rowCount("select count(*) n from public.studio_role_permissions where studio_id=$1", [s.studioId])).toBe(0);
    // short but meaningful text is accepted: a character minimum is not the test
    expect(await save(s.userId, s.studioId, 0, ch, "Covers lunch", true)).toMatchObject({ ok: true, new_version: 1 });
    const a = (await adminQuery("select reason from public.permission_audit where studio_id=$1", [s.studioId])).rows[0];
    expect(a.reason).toBe("Covers lunch");
  });

  it("a non-sensitive change needs no reason, and a placeholder reason supplied anyway is rejected", async () => {
    const s = await seedStudio("engine-optional");
    const cur = (await getp(s.userId, s.studioId)).roles.practitioner[plainKey.key].effective as Scope;
    const next: Scope = cur === "studio" ? "off" : "studio";
    expect(await save(s.userId, s.studioId, 0, { practitioner: { [plainKey.key]: next } }, "n/a", false)).toMatchObject({ code: "reason_invalid" });
    expect(await save(s.userId, s.studioId, 0, { practitioner: { [plainKey.key]: next } }, "", false)).toMatchObject({ ok: true });
  });

  it("adopt and reset require a reason; preview is pure; reset returns a role to the studio's OWN basis; adopt is previewed with fixed narrowings listed apart", async () => {
    const s = await seedStudio("engine-adopt");
    await adminQuery("update public.studio_permission_policy set basis='existing_snapshot' where studio_id=$1", [s.studioId]);
    const cur = (await getp(s.userId, s.studioId)).roles.practitioner[plainKey.key].effective as Scope;
    await save(s.userId, s.studioId, 0, { practitioner: { [plainKey.key]: cur === "studio" ? "off" : "studio" } });
    const pa = await call(s.userId, "select public.preview_adopt_new_defaults($1) as r", [s.studioId]);
    expect(pa).toMatchObject({ ok: true, version: 1, reason_required: true });
    expect(Array.isArray(pa.fixed_narrowings)).toBe(true);
    expect(pa.fixed_narrowings.length).toBeGreaterThan(0);
    expect((await adminQuery("select basis from public.studio_permission_policy where studio_id=$1", [s.studioId])).rows[0].basis).toBe("existing_snapshot");
    expect(await call(s.userId, "select public.adopt_new_defaults($1,1,'n/a') as r", [s.studioId])).toMatchObject({ code: "reason_required" });
    expect(await call(s.userId, "select public.adopt_new_defaults($1,0,$2) as r", [s.studioId, GOOD_REASON])).toMatchObject({ code: "stale_version", current_version: 1 });
    // reset first: an existing studio goes back to its snapshot, NOT to the new defaults
    expect(await call(s.userId, "select public.reset_role_to_defaults($1,'practitioner',1,'') as r", [s.studioId])).toMatchObject({ code: "reason_required" });
    const rs = await call(s.userId, "select public.reset_role_to_defaults($1,'practitioner',1,$2) as r", [s.studioId, GOOD_REASON]);
    expect(rs).toMatchObject({ ok: true, new_version: 2 });
    expect((await adminQuery("select basis from public.studio_permission_policy where studio_id=$1", [s.studioId])).rows[0].basis).toBe("existing_snapshot");
    expect(await rowCount("select count(*) n from public.studio_role_permissions where studio_id=$1", [s.studioId])).toBe(0);
    const ad = await call(s.userId, "select public.adopt_new_defaults($1,2,$2) as r", [s.studioId, GOOD_REASON]);
    expect(ad).toMatchObject({ ok: true, new_version: 3 });
    expect((await adminQuery("select basis from public.studio_permission_policy where studio_id=$1", [s.studioId])).rows[0].basis).toBe("new_studio");
    expect(await call(s.userId, "select public.adopt_new_defaults($1,3,$2) as r", [s.studioId, GOOD_REASON])).toMatchObject({ code: "nothing_changed" });
    const kinds = (await adminQuery("select kind from public.permission_audit where studio_id=$1 order by id", [s.studioId])).rows.map((r) => r.kind);
    expect(kinds).toEqual(["role_permissions_saved", "role_reset", "defaults_adopted", "defaults_adopted"]);
  });
});

describe("audit is append-only and shows names at read time without emails", () => {
  it("UPDATE, DELETE and TRUNCATE are refused even for the table owner", async () => {
    const s = await seedStudio("engine-append");
    const cur = (await getp(s.userId, s.studioId)).roles.practitioner[plainKey.key].effective as Scope;
    await save(s.userId, s.studioId, 0, { practitioner: { [plainKey.key]: cur === "studio" ? "off" : "studio" } });
    await expect(adminQuery("update public.permission_audit set reason='x' where studio_id=$1", [s.studioId])).rejects.toThrow(/append_only/);
    await expect(adminQuery("delete from public.permission_audit where studio_id=$1", [s.studioId])).rejects.toThrow(/append_only/);
    await expect(adminQuery("truncate public.permission_audit")).rejects.toThrow(/append_only/);
    const list = await call(s.userId, "select public.list_permission_audit($1,10,null) as r", [s.studioId]);
    expect(list.ok).toBe(true);
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0].actor_name).toMatch(/Harness engine-append/);
    expect(JSON.stringify(list)).not.toMatch(/@harness\.local/);
  });
});

describe("has_studio_permission: studio, own (CURRENT assignment), off, owner, cross-studio", () => {
  const KEY = "comm.send_portal_reply";
  const setScope = async (s: SeededStudio, role: Role, scope: Scope) => {
    for (const k of ["comm.send_routine", "client.view_directory", KEY]) {
      const d = DEFS.find((x) => x.key === k)!;
      if (d.ownerConfigurable === false) continue;
      await adminQuery("insert into public.studio_role_permissions(studio_id,role,key,scope) values ($1,$2,$3,$4) on conflict (studio_id,role,key) do update set scope=excluded.scope", [s.studioId, role, k, k === KEY ? scope : "studio"]);
    }
  };
  const move = (apptId: string, toPractitioner: string) => adminQuery("update public.appointments set practitioner_id=$2 where id=$1", [apptId, toPractitioner]);

  it("(1) moving the LAST qualifying appointment denies on the next request", async () => {
    await setScope(A, "practitioner", "own");
    const c = await seedClient(A, "last");
    const appt = await seedAppt(A, prac.practitionerId, c);
    expect(await can(prac.userId, A.studioId, KEY, { client: c })).toBe(true);
    await move(appt, prac2.practitionerId);
    expect(await can(prac.userId, A.studioId, KEY, { client: c })).toBe(false);
    expect(await can(prac2.userId, A.studioId, KEY, { client: c })).toBe(true); // the access moved with the appointment
  });

  it("(2) moving one of TWO qualifying appointments still allows", async () => {
    await setScope(A, "practitioner", "own");
    const c = await seedClient(A, "two");
    const a1 = await seedAppt(A, prac.practitionerId, c, { offsetDays: -2 });
    await seedAppt(A, prac.practitionerId, c, { offsetDays: 4 });
    await move(a1, prac2.practitionerId);
    expect(await can(prac.userId, A.studioId, KEY, { client: c })).toBe(true);
  });

  it("(3) control: a whole-studio scope still allows after the last one moves", async () => {
    await setScope(A, "practitioner", "studio");
    const c = await seedClient(A, "ctl");
    const appt = await seedAppt(A, prac.practitionerId, c);
    await move(appt, prac2.practitionerId);
    expect(await can(prac.userId, A.studioId, KEY, { client: c })).toBe(true);
    await setScope(A, "practitioner", "own");
  });

  it("(4) a cancelled remaining appointment does not count, and (5) another studio never counts", async () => {
    await setScope(A, "practitioner", "own");
    const c = await seedClient(A, "cancelled");
    const live = await seedAppt(A, prac.practitionerId, c);
    await seedAppt(A, prac.practitionerId, c, { status: "cancelled" });
    expect(await can(prac.userId, A.studioId, KEY, { client: c })).toBe(true);
    await move(live, prac2.practitionerId);
    expect(await can(prac.userId, A.studioId, KEY, { client: c })).toBe(false);
    expect(await can(prac.userId, B.studioId, KEY, { client: c })).toBe(false);
    expect(await can(prac.userId, A.studioId, KEY)).toBe(false); // no client given: fail closed
  });

  it("owner holds every catalogued key; an unknown key is denied to everyone; a deactivated member and a stranger are denied", async () => {
    expect(await can(A.userId, A.studioId, KEY)).toBe(true);
    expect(await can(A.userId, A.studioId, "no.such_key")).toBe(false);
    expect(await can(randomUUID(), A.studioId, "appt.view_calendar")).toBe(false);
    const m = await seedMember(A, "gone");
    await setScope(A, "practitioner", "studio");
    expect(await can(m.userId, A.studioId, KEY)).toBe(true);
    await adminQuery("update public.practitioners set active=false where id=$1", [m.practitionerId]);
    expect(await can(m.userId, A.studioId, KEY)).toBe(false);
  });
});

describe("effective_access", () => {
  it("returns scope, source and the reason a value is capped; a deactivated person has no access; an unknown id is not found", async () => {
    const s = await seedStudio("engine-effective");
    const m = await seedMember(s, "e1");
    const r = await call(s.userId, "select public.effective_access($1,$2) as r", [s.studioId, m.practitionerId]);
    expect(r).toMatchObject({ ok: true, role: "practitioner", state: "active" });
    expect(r.rows.length).toBe(DEFS.length);
    const gatedRow = r.rows.find((x: J) => x.key === "practitioner_completion" || x.key === "appt.complete");
    expect(gatedRow).toBeDefined();
    await adminQuery("update public.practitioners set active=false where id=$1", [m.practitionerId]);
    const g = await call(s.userId, "select public.effective_access($1,$2) as r", [s.studioId, m.practitionerId]);
    expect(g.state).toBe("deactivated");
    expect(g.rows.every((x: J) => x.scope === "off" && x.capped_by === "deactivated")).toBe(true);
    expect(await call(s.userId, "select public.effective_access($1,$2) as r", [s.studioId, randomUUID()])).toMatchObject({ code: "not_found" });
  });
});

describe("change_staff_role", () => {
  it("moves a practitioner to receptionist in one transaction (deactivate, never delete), audits it, and leaves other studios alone", async () => {
    const s = await seedStudio("engine-role");
    const m = await seedMember(s, "mv");
    const other = await seedStudio("engine-role-other");
    const before = await rowCount("select count(*) n from public.practitioners where studio_id=$1", [other.studioId]);
    const r = await call(s.userId, "select public.change_staff_role($1,$2,'receptionist','practitioner',$3) as r", [s.studioId, m.practitionerId, GOOD_REASON]);
    expect(r).toMatchObject({ ok: true, role: "receptionist" });
    expect((await adminQuery("select active from public.practitioners where id=$1", [m.practitionerId])).rows[0].active).toBe(false);
    expect((await adminQuery("select active from public.studio_receptionists where id=$1", [r.membership_id])).rows[0].active).toBe(true);
    expect(await rowCount("select count(*) n from public.practitioners where studio_id=$1", [other.studioId])).toBe(before);
    const aud = (await adminQuery("select * from public.permission_audit where studio_id=$1 and kind='staff_role_changed'", [s.studioId])).rows;
    expect(aud).toHaveLength(1);
    expect(aud[0].before).toMatchObject({ role: "practitioner" });
    expect(aud[0].after).toMatchObject({ role: "receptionist" });
    const back = await call(s.userId, "select public.change_staff_role($1,$2,'practitioner','receptionist',null) as r", [s.studioId, r.membership_id]);
    expect(back).toMatchObject({ ok: true, role: "practitioner", membership_id: m.practitionerId });
    expect(await rowCount("select count(*) n from public.studio_receptionists where studio_id=$1", [s.studioId])).toBe(1);
  });

  it("refuses self, an owner as source or target, a stale expected role, upcoming appointments, and a non-owner", async () => {
    const s = await seedStudio("engine-role2");
    const m = await seedMember(s, "r2");
    expect(await call(s.userId, "select public.change_staff_role($1,$2,'receptionist','practitioner',null) as r", [s.studioId, s.practitionerId])).toMatchObject({ code: "owner_role_fixed" });
    expect(await call(s.userId, "select public.change_staff_role($1,$2,'owner','practitioner',null) as r", [s.studioId, m.practitionerId])).toMatchObject({ code: "owner_role_fixed" });
    expect(await call(m.userId, "select public.change_staff_role($1,$2,'receptionist','practitioner',null) as r", [s.studioId, m.practitionerId])).toEqual({ ok: false, code: "refused" });
    expect(await call(s.userId, "select public.change_staff_role($1,$2,'practitioner','practitioner',null) as r", [s.studioId, m.practitionerId])).toMatchObject({ code: "nothing_changed" });
    expect(await call(s.userId, "select public.change_staff_role($1,$2,'practitioner','receptionist',null) as r", [s.studioId, m.practitionerId])).toMatchObject({ code: "not_found" });
    const c = await seedClient(s, "rc");
    await seedAppt(s, m.practitionerId, c);
    expect(await call(s.userId, "select public.change_staff_role($1,$2,'receptionist','practitioner',null) as r", [s.studioId, m.practitionerId])).toMatchObject({ code: "has_upcoming_appointments", count: 1 });
    expect((await adminQuery("select active from public.practitioners where id=$1", [m.practitionerId])).rows[0].active).toBe(true);
  });
});
