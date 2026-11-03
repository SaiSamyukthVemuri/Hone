import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOG, effectiveScope, type PermissionDef, type Role, type Scope, type StudioPolicy, GATES } from "@/lib/permissions/catalog";
import { consequenceClass } from "@/lib/permissions/consequence";
import { adminQuery, adminTx, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

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
      expect(r.consequence, d.key).toBe(consequenceClass(d));
      expect(r.enforcement, d.key).toBe(d.enforcement ?? "not_yet");
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
    // each item says whether a practitioner LOSES something or is merely protected, and archive/delete/restore are listed as losses (DN-25)
    for (const f of pa.fixed_narrowings) expect(["narrows", "safeguard"]).toContain(f.practitioner_access);
    const kindOf = (id: string) => pa.fixed_narrowings.find((f: { id: string }) => f.id === id)?.practitioner_access;
    for (const id of ["performer_change", "exposure_incident_history", "colleague_private_fields", "studio_columns_read", "archive_clients", "delete_treatment_records_and_photos", "restore_deleted_records", "id_portraits_owner_only"]) expect(kindOf(id), id).toBe("narrows");
    for (const id of ["getting_started_filter", "notification_read_state", "portal_reply_immutable", "anonymous_public_writes_closed", "rate_limit_outage", "google_flags_operator_only", "deactivated_calendar_owner"]) expect(kindOf(id), id).toBe("safeguard");
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

const openStaffRoleGate = (studioId: string) =>
  adminQuery("insert into public.permission_ship_gates(studio_id,gate,met) values ($1,'staff_role_change',true) on conflict (studio_id,gate) do update set met=true", [studioId]);

describe("change_staff_role", () => {
  it("moves a practitioner to receptionist in one transaction (deactivate, never delete), audits it, and leaves other studios alone", async () => {
    const s = await seedStudio("engine-role");
    await openStaffRoleGate(s.studioId);
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
    const back = await call(s.userId, "select public.change_staff_role($1,$2,'practitioner','receptionist',$3) as r", [s.studioId, r.membership_id, GOOD_REASON]);
    expect(back).toMatchObject({ ok: true, role: "practitioner", membership_id: m.practitionerId });
    expect(await rowCount("select count(*) n from public.studio_receptionists where studio_id=$1", [s.studioId])).toBe(1);
  });

  it("refuses self, an owner as source or target, a stale expected role, upcoming appointments, and a non-owner", async () => {
    const s = await seedStudio("engine-role2");
    await openStaffRoleGate(s.studioId);
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

describe("the page can tell when a reason is needed: sensitive flag and consequence class on get_role_permissions and the preview (OPS, Photos gap)", () => {
  it("get_role_permissions exposes sensitive and consequence for every catalogued key, equal to the catalog", async () => {
    const s = await seedStudio("engine-consequence");
    const r = await getp(s.userId, s.studioId);
    expect(Object.keys(r.keys).sort()).toEqual(DEFS.map((d) => d.key).sort());
    for (const d of DEFS) expect(r.keys[d.key], d.key).toEqual({ sensitive: !!d.sensitive, consequence: consequenceClass(d), enforcement: d.enforcement ?? "not_yet" });
    expect(r.keys["pay.refund"].consequence).toBe("financial");
    expect(r.keys["appt.cancel"].consequence).toBeNull();
    expect(Object.values(r.keys).some((k: any) => k.consequence === "destructive")).toBe(false);
  });

  it("the preview and a refused-or-saved diff carry the same two fields, and a preview still writes nothing", async () => {
    const s = await seedStudio("engine-consequence-preview");
    const sensKey = DEFS.find((d) => d.sensitive && d.ownerConfigurable !== false && d.offeredTo.receptionist && !d.shipGate?.receptionist && d.scopes.includes("studio") && d.requires.every((q) => ["client.view_directory", "appt.view_calendar"].includes(q)) && d.newStudioDefault.receptionist === "off")!;
    const p = await call(s.userId, "select public.preview_role_changes($1,$2::jsonb) as r", [s.studioId, JSON.stringify({ receptionist: { [sensKey.key]: "studio" } })]);
    const entry = JSON.stringify(p).includes(sensKey.key) ? p : null;
    expect(entry).not.toBeNull();
    const hit = (function find(o: any): any { if (o && typeof o === "object") { if (o.key === sensKey.key && "before" in o) return o; for (const v of Object.values(o)) { const f = find(v); if (f) return f; } } return null; })(p);
    expect(hit).toMatchObject({ key: sensKey.key, sensitive: true, consequence: consequenceClass(sensKey) });
    expect(await rowCount("select count(*) n from public.studio_role_permissions where studio_id=$1", [s.studioId])).toBe(0);
  });
});

// avail.* are three independent on/off keys; "own" versus "colleague" is the app choosing between avail.manage_own and avail.manage_others
// (lib/permissions/enforcement-wiring.test.ts proves which key each action asks). This proves the keys the app asks resolve as promised.
describe("avail.* keys: existing snapshot is unchanged, ON and OFF are independent, other studios are refused", () => {
  const AVAIL = ["avail.manage_own", "avail.manage_others", "avail.manage_studio_hours"] as const;
  const setBasis = (studioId: string, basis: "existing_snapshot" | "new_studio") =>
    adminQuery("update public.studio_permission_policy set basis=$2 where studio_id=$1", [studioId, basis]);
  const store = (studioId: string, role: Role, key: string, scope: Scope) =>
    adminQuery("insert into public.studio_role_permissions(studio_id,role,key,scope) values ($1,$2,$3,$4) on conflict (studio_id,role,key) do update set scope=excluded.scope", [studioId, role, key, scope]);

  it("existing snapshot: the owner holds all three, a practitioner and a receptionist hold none (no behaviour change)", async () => {
    const s = await seedStudio("avail-snap");
    const p = await seedMember(s, "pa");
    const d = await seedDesk(s, "front");
    await setBasis(s.studioId, "existing_snapshot");
    for (const k of AVAIL) {
      expect(await can(s.userId, s.studioId, k), `owner ${k}`).toBe(true);
      expect(await can(p.userId, s.studioId, k), `practitioner ${k}`).toBe(false);
      expect(await can(d.userId, s.studioId, k), `receptionist ${k}`).toBe(false);
    }
  });

  it("key ON affects only that key; turning it OFF again refuses on the next request", async () => {
    const s = await seedStudio("avail-onoff");
    const p = await seedMember(s, "pa");
    await setBasis(s.studioId, "existing_snapshot");
    await store(s.studioId, "practitioner", "avail.manage_own", "studio");
    expect(await can(p.userId, s.studioId, "avail.manage_own")).toBe(true);
    expect(await can(p.userId, s.studioId, "avail.manage_others")).toBe(false); // own is not colleague
    expect(await can(p.userId, s.studioId, "avail.manage_studio_hours")).toBe(false);
    await store(s.studioId, "practitioner", "avail.manage_own", "off");
    expect(await can(p.userId, s.studioId, "avail.manage_own")).toBe(false);
    await store(s.studioId, "practitioner", "avail.manage_others", "studio");
    expect(await can(p.userId, s.studioId, "avail.manage_others")).toBe(true);
    expect(await can(p.userId, s.studioId, "avail.manage_own")).toBe(false); // colleague is not own
  });

  it("new studio: a practitioner manages their own hours only; nobody gains colleague or studio hours", async () => {
    const s = await seedStudio("avail-new");
    const p = await seedMember(s, "pa");
    await setBasis(s.studioId, "new_studio");
    expect(await can(p.userId, s.studioId, "avail.manage_own")).toBe(true);
    expect(await can(p.userId, s.studioId, "avail.manage_others")).toBe(false);
    expect(await can(p.userId, s.studioId, "avail.manage_studio_hours")).toBe(false);
  });

  it("another studio's owner and practitioner are refused even when the key is ON here", async () => {
    const s = await seedStudio("avail-x");
    const other = await seedStudio("avail-y");
    const op = await seedMember(other, "pz");
    await setBasis(s.studioId, "existing_snapshot");
    await store(s.studioId, "practitioner", "avail.manage_own", "studio");
    for (const k of AVAIL) {
      expect(await can(other.userId, s.studioId, k), `foreign owner ${k}`).toBe(false);
      expect(await can(op.userId, s.studioId, k), `foreign practitioner ${k}`).toBe(false);
    }
  });
});

describe("change_staff_role is behind the operator gate, needs a reason to widen, and locks upcoming appointments (Privacy E2, Insurance RB-3, RB-5)", () => {
  const callRole = (u: string, s: string, m: string, to: string, from: string, reason: string | null) =>
    call(u, "select public.change_staff_role($1,$2,$3,$4,$5) as r", [s, m, to, from, reason]);

  it("is refused while the staff_role_change gate is off (no row = off), changes nothing, and the page can see the gate is false", async () => {
    const s = await seedStudio("role-gate");
    const m = await seedMember(s, "g1");
    expect(await callRole(s.userId, s.studioId, m.practitionerId, "receptionist", "practitioner", GOOD_REASON)).toMatchObject({ ok: false, code: "gate_unmet", gate: "staff_role_change" });
    expect((await adminQuery("select active from public.practitioners where id=$1", [m.practitionerId])).rows[0].active).toBe(true);
    expect(await rowCount("select count(*) n from public.studio_receptionists where studio_id=$1", [s.studioId])).toBe(0);
    expect((await getp(s.userId, s.studioId)).gates).toMatchObject({ staff_role_change: false });
    await adminQuery("insert into public.permission_ship_gates(studio_id,gate,met) values ($1,'staff_role_change',false) on conflict (studio_id,gate) do update set met=false", [s.studioId]);
    expect(await callRole(s.userId, s.studioId, m.practitionerId, "receptionist", "practitioner", GOOD_REASON)).toMatchObject({ code: "gate_unmet" });
    // a non-owner still gets the generic refusal, not a hint about the gate
    expect(await callRole(m.userId, s.studioId, m.practitionerId, "receptionist", "practitioner", GOOD_REASON)).toEqual({ ok: false, code: "refused" });
    await openStaffRoleGate(s.studioId);
    expect((await getp(s.userId, s.studioId)).gates).toMatchObject({ staff_role_change: true });
    expect(await callRole(s.userId, s.studioId, m.practitionerId, "receptionist", "practitioner", GOOD_REASON)).toMatchObject({ ok: true });
  });

  it("RB-3: receptionist to practitioner needs a meaningful reason; practitioner to receptionist does not", async () => {
    const s = await seedStudio("role-reason");
    await openStaffRoleGate(s.studioId);
    const m = await seedMember(s, "r3");
    const down = await callRole(s.userId, s.studioId, m.practitionerId, "receptionist", "practitioner", null);
    expect(down).toMatchObject({ ok: true });
    expect(await callRole(s.userId, s.studioId, down.membership_id, "practitioner", "receptionist", null)).toMatchObject({ ok: false, code: "reason_required" });
    expect(await callRole(s.userId, s.studioId, down.membership_id, "practitioner", "receptionist", "n/a")).toMatchObject({ ok: false, code: "reason_invalid" });
    expect((await adminQuery("select active from public.practitioners where id=$1", [m.practitionerId])).rows[0].active).toBe(false);
    expect(await callRole(s.userId, s.studioId, down.membership_id, "practitioner", "receptionist", GOOD_REASON)).toMatchObject({ ok: true, role: "practitioner" });
  });

  it("RB-5: every non-cancelled future status blocks the move (confirmed, completed, no_show); a cancelled one does not", async () => {
    const s = await seedStudio("role-status");
    await openStaffRoleGate(s.studioId);
    const m = await seedMember(s, "r5");
    const c = await seedClient(s, "r5");
    await seedAppt(s, m.practitionerId, c, { status: "cancelled" });
    expect(await callRole(s.userId, s.studioId, m.practitionerId, "receptionist", "practitioner", GOOD_REASON)).toMatchObject({ ok: true });
    for (const st of ["completed", "no_show"]) {
      const s2 = await seedStudio(`role-status-${st}`);
      await openStaffRoleGate(s2.studioId);
      const m2 = await seedMember(s2, "x");
      const c2 = await seedClient(s2, "x");
      await seedAppt(s2, m2.practitionerId, c2, { status: st });
      expect(await callRole(s2.userId, s2.studioId, m2.practitionerId, "receptionist", "practitioner", GOOD_REASON), st).toMatchObject({ code: "has_upcoming_appointments", count: 1 });
    }
  });

  it("RB-5 race: the move waits for a concurrent change to an upcoming appointment, then counts the committed state", async () => {
    const s = await seedStudio("role-race");
    await openStaffRoleGate(s.studioId);
    const m = await seedMember(s, "rr");
    const c = await seedClient(s, "rr");
    const appt = await seedAppt(s, m.practitionerId, c);
    let racing: Promise<J> | null = null;
    await adminTx(async (q) => {
      await q("select id from public.appointments where id=$1 for update", [appt]);
      racing = callRole(s.userId, s.studioId, m.practitionerId, "receptionist", "practitioner", GOOD_REASON);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i += 1) {
        waiting = Number((await adminQuery("select count(*) n from pg_stat_activity where wait_event_type='Lock' and query ilike '%change_staff_role%'")).rows[0].n) > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 50));
      }
      expect(waiting, "the move must wait on the appointment lock, not read around it").toBe(true);
      await q("update public.appointments set status='cancelled' where id=$1", [appt]);
    });
    // the holder committed the cancellation; the move now sees no upcoming appointment and proceeds on the committed state
    expect(await racing).toMatchObject({ ok: true, role: "receptionist" });
  });
});

describe("reason rule judges the EFFECTIVE widening (Privacy E1)", () => {
  const pair = DEFS.map((k) => ({ k, p: k.requires.length === 1 ? DEFS.find((d) => d.key === k.requires[0]) : undefined })).find(
    ({ k, p }) =>
      !!p && k.sensitive && !p.sensitive && k.ownerConfigurable !== false && p.ownerConfigurable !== false &&
      k.offeredTo.practitioner && p.offeredTo.practitioner && !k.shipGate?.practitioner && !p.shipGate?.practitioner &&
      k.scopes.includes("studio") && p.scopes.includes("studio") && p.requires.every((r) => DEFS.find((d) => d.key === r)?.existingSnapshot.practitioner === "studio"),
  );

  it("raising only a prerequisite that was capping a stored sensitive key needs the confirmation and a reason", async () => {
    expect(pair, "catalog has a sensitive key with one non-sensitive prerequisite").toBeDefined();
    const { k, p } = pair!;
    const s = await seedStudio("engine-widen");
    const store = (key: string, scope: string) =>
      adminQuery("insert into public.studio_role_permissions(studio_id,role,key,scope) values ($1,'practitioner',$2,$3) on conflict (studio_id,role,key) do update set scope=excluded.scope", [s.studioId, key, scope]);
    await adminQuery("update public.studio_permission_policy set basis='existing_snapshot' where studio_id=$1", [s.studioId]);
    await store(p!.key, "off");
    await store(k.key, "studio"); // stored, but capped off by its prerequisite
    const before = (await getp(s.userId, s.studioId)).roles.practitioner[k.key].effective as Scope;
    expect(before).toBe("off");
    const ver = (await getp(s.userId, s.studioId)).version as number;
    const change = { practitioner: { [p!.key]: "studio" } };
    const pv = await call(s.userId, "select public.preview_role_changes($1,$2::jsonb) as r", [s.studioId, JSON.stringify(change)]);
    expect(pv).toMatchObject({ ok: true, reason_required: true });
    expect(pv.sensitive_keys).toContain(k.key);
    expect(await save(s.userId, s.studioId, ver, change, null, false)).toMatchObject({ code: "sensitive_unconfirmed" });
    expect(await save(s.userId, s.studioId, ver, change, null, true)).toMatchObject({ code: "reason_required" });
    expect(await save(s.userId, s.studioId, ver, change, "n/a", true)).toMatchObject({ code: "reason_required" });
    expect(await rowCount("select count(*) n from public.studio_role_permissions where studio_id=$1 and key=$2 and scope='studio'", [s.studioId, p!.key])).toBe(0);
    expect(await save(s.userId, s.studioId, ver, change, GOOD_REASON, true)).toMatchObject({ ok: true });
    expect((await getp(s.userId, s.studioId)).roles.practitioner[k.key].effective).toBe("studio");
  });
});

describe("rollback: the 0287 down SQL removes the engine and touches nothing else", () => {
  it("drops every engine object inside a transaction and leaves studios, practitioners and appointments as they were", async () => {
    const { readFileSync } = await import("node:fs");
    const down = readFileSync("supabase/rollbacks/0287_roles_permission_engine.down.sql", "utf8");
    const s = await seedStudio("engine-down");
    const counts = async (q: (t: string, p?: unknown[]) => Promise<{ rows: any[] }>) => {
      const r = await q("select (select count(*) from public.studios) st, (select count(*) from public.practitioners) pr, (select count(*) from public.appointments) ap");
      return [Number(r.rows[0].st), Number(r.rows[0].pr), Number(r.rows[0].ap)];
    };
    const base = await counts(adminQuery);
    class Rollback extends Error {}
    let gone: Record<string, unknown> = {};
    let realError: { code?: string; message?: string } = {};
    try {
      await adminTx(async (q) => {
        // the file opens its own begin/commit; run its body statements inside this test's transaction instead of committing
        const body = down.replace(/^begin;\s*$/im, "").replace(/^commit;\s*$/im, "");
        await q(body);
        gone = (await q(
          `select to_regprocedure('public.has_studio_permission(uuid,text,uuid,uuid,uuid)') is null as fn,
                  to_regprocedure('public.change_staff_role(uuid,uuid,text,text,text)') is null as role_fn,
                  to_regclass('public.permission_catalog') is null as t1, to_regclass('public.permission_audit') is null as t2,
                  to_regclass('public.studio_role_permissions') is null as t3,
                  not exists (select 1 from pg_trigger where tgname='studios_permission_policy_seed_trg') as trg`,
        )).rows[0];
        // the REAL error Postgres gives for the missing engine, fed to the app's detector (release-order fallback, Privacy X1)
        await q("savepoint probe");
        try {
          await q("select public.has_studio_permission($1,'appt.book',null,null,null)", [randomUUID()]);
        } catch (e) {
          realError = { code: (e as { code?: string }).code, message: (e as Error).message };
        }
        await q("rollback to savepoint probe");
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    expect(gone).toEqual({ fn: true, role_fn: true, t1: true, t2: true, t3: true, trg: true });
    expect(realError.code).toBe("42883");
    const { isEngineAbsent } = await import("@/lib/permissions/require-permission");
    expect(isEngineAbsent(realError)).toBe(true); // with the engine dropped the app falls back to legacy checks, it does not lock out
    expect(await counts(adminQuery)).toEqual(base); // nothing else moved
    // the transaction rolled back: the engine is still there
    expect((await getp(s.userId, s.studioId)).ok).toBe(true);
  });
});
