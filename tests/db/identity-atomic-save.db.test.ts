// 0281: identity revisions, the identity audit, and the atomic profile save (update_client_profile_if_unchanged). Synthetic values only.
// Part 1: update_client_profile_if_unchanged (the atomic profile save). Part 2: M1's revisions, audit and grants.
// Negative controls (run in the slot, in this order): (a) on the baseline stack (no 0281) every test here fails; (b) the "interim
// read-compare-write" control below documents the gap this function closes and MUST pass on every stack (it asserts the lost update).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, asRole, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

afterAll(closePool);

const FN = "public.update_client_profile_if_unchanged(uuid, uuid, jsonb, jsonb)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LONG_ALLERGIES = "latex; " + "x".repeat(24_980) + " end"; // 24,991 characters
const LONG_ADDRESS = "1 Test Road, " + "y".repeat(29_980) + " end"; // 29,997 characters

const save = (s: SeededStudio, patch: Record<string, unknown>, expected: Record<string, unknown>, studioId = s.studioId, clientId = s.clientId) =>
  asUser(s.userId, async (q) =>
    (await q(`select ${FN.replace("(uuid, uuid, jsonb, jsonb)", "")}($1,$2,$3::jsonb,$4::jsonb) as id`, [studioId, clientId, JSON.stringify(patch), JSON.stringify(expected)])).rows[0].id as string | null,
  );
const row = async (clientId: string) => (await adminQuery(`select * from public.clients where id = $1`, [clientId])).rows[0];

async function seedClient(label: string, fields: Record<string, unknown> = {}) {
  const s = await seedStudio(label);
  for (const [k, v] of Object.entries(fields)) await adminQuery(`update public.clients set ${k} = $2 where id = $1`, [s.clientId, v]);
  return s;
}

describe("0281 part 1: update_client_profile_if_unchanged", () => {
  it("catalog: SECURITY INVOKER, fixed search_path, grants by name (authenticated only)", async () => {
    const r = await adminQuery(
      `select p.prosecdef, p.proconfig::text as cfg, has_function_privilege('public', p.oid, 'execute') as pub,
              has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p where p.oid = '${FN}'::regprocedure`,
    );
    const f = r.rows[0];
    expect(f.prosecdef, "must be SECURITY INVOKER").toBe(false);
    expect(f.cfg).toContain("search_path=pg_catalog, pg_temp");
    expect({ pub: f.pub, anon: f.anon, svc: f.svc, auth: f.auth }).toEqual({ pub: false, anon: false, svc: false, auth: true });
  });

  it("anon and service_role cannot execute it", async () => {
    for (const role of ["anon", "service_role"] as const) {
      await expect(
        asRole(role, (q) => q(`select ${FN.replace("(uuid, uuid, jsonb, jsonb)", "")}($1,$2,'{"phone":"1"}'::jsonb,'{"phone":null}'::jsonb)`, [randomUUID(), randomUUID()])),
        role,
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("applies when every expected value still holds: only the patched columns change, the id is returned", async () => {
    const s = await seedClient("atomic-ok", { phone: "555-0100", pronouns: "they/them", fitzpatrick_type: 3 });
    const before = await row(s.clientId);
    const id = await save(s, { phone: "555-0199", fitzpatrick_type: 4 }, { phone: "555-0100", fitzpatrick_type: 3 });
    expect(id).toBe(s.clientId);
    const after = await row(s.clientId);
    expect(after.phone).toBe("555-0199");
    expect(after.fitzpatrick_type).toBe(4);
    for (const k of ["name", "pronouns", "email", "address", "allergies", "date_of_birth", "preferred_name", "emergency_contact_name", "emergency_contact_phone", "skin_notes"]) {
      expect(after[k], `${k} untouched`).toEqual(before[k]);
    }
  });

  it("null in the patch clears a column; null in expected means 'was empty'; a date round-trips", async () => {
    const s = await seedClient("atomic-null", { phone: "555-0100" });
    expect(await save(s, { phone: null, date_of_birth: "1990-02-03" }, { phone: "555-0100", date_of_birth: null })).toBe(s.clientId);
    const r = await row(s.clientId);
    expect(r.phone).toBeNull();
    expect(String(r.date_of_birth.toISOString?.().slice(0, 10) ?? r.date_of_birth)).toContain("1990-02-03");
    expect(await save(s, { date_of_birth: "1991-01-01" }, { date_of_birth: "1990-02-03" })).toBe(s.clientId);
  });

  it("stale: a changed expected value matches zero rows and writes nothing", async () => {
    const s = await seedClient("atomic-stale", { phone: "555-0100", allergies: "none" });
    await adminQuery(`update public.clients set phone = '555-0111' where id = $1`, [s.clientId]);
    const id = await save(s, { allergies: "latex" }, { allergies: "none", phone: "555-0100" });
    expect(id).toBeNull();
    const r = await row(s.clientId);
    expect(r.allergies).toBe("none");
    expect(r.phone).toBe("555-0111");
  });

  it("identity guards: an expected key that is NOT in the patch still conditions the write", async () => {
    const s = await seedClient("atomic-guard", { phone: "555-0100" });
    await adminQuery(`update public.clients set phone = '555-0122' where id = $1`, [s.clientId]);
    const id = await save(s, { name: "Changed Name" }, { name: (await row(s.clientId)).name, phone: "555-0100" });
    expect(id).toBeNull();
    expect((await row(s.clientId)).name).not.toBe("Changed Name");
  });

  it("refuses malformed input with 22023: unknown key, empty patch, a patched key with no expected value, non-objects", async () => {
    const s = await seedClient("atomic-bad");
    const cases: Array<[Record<string, unknown> | string, Record<string, unknown> | string]> = [
      [{ skin_notes: "x" }, { skin_notes: null }],
      [{ phone: "1" }, { phone: null, archived_at: null }],
      [{}, { phone: null }],
      [{ phone: "1" }, {}],
      ['"text"', "{}"],
    ];
    for (const [patch, expected] of cases) {
      const p = typeof patch === "string" ? patch : JSON.stringify(patch);
      const e = typeof expected === "string" ? expected : JSON.stringify(expected);
      await expect(
        asUser(s.userId, (q) => q(`select ${FN.replace("(uuid, uuid, jsonb, jsonb)", "")}($1,$2,$3::jsonb,$4::jsonb)`, [s.studioId, s.clientId, p, e])),
        `${p} / ${e}`,
      ).rejects.toMatchObject({ code: "22023" });
    }
    expect((await row(s.clientId)).phone).toBeNull();
  });

  it("a long allergies (about 25,000 characters) and address (about 30,000) compare and save in the JSON body", async () => {
    const s = await seedClient("atomic-long", { allergies: LONG_ALLERGIES, address: LONG_ADDRESS });
    expect(await save(s, { allergies: LONG_ALLERGIES + "!" }, { allergies: LONG_ALLERGIES })).toBe(s.clientId);
    expect(await save(s, { address: LONG_ADDRESS + "!" }, { address: LONG_ADDRESS })).toBe(s.clientId);
    const r = await row(s.clientId);
    expect(r.allergies.length).toBe(LONG_ALLERGIES.length + 1);
    expect(r.address.length).toBe(LONG_ADDRESS.length + 1);
    // One differing character at the very END of a long baseline is still stale (exact comparison, not a prefix or a hash of a prefix).
    expect(await save(s, { allergies: "replaced" }, { allergies: LONG_ALLERGIES })).toBeNull();
    expect((await row(s.clientId)).allergies.length).toBe(LONG_ALLERGIES.length + 1);
  });

  it("another studio's staff member gets zero rows (row-level security), and the client is untouched", async () => {
    const a = await seedClient("atomic-rls-a", { phone: "555-0100" });
    const b = await seedStudio("atomic-rls-b");
    const id = await save(b, { phone: "555-0199" }, { phone: "555-0100" }, a.studioId, a.clientId);
    expect(id).toBeNull();
    expect((await row(a.clientId)).phone).toBe("555-0100");
    // And with the right client but the wrong studio id in the call.
    expect(await save(a, { phone: "555-0199" }, { phone: "555-0100" }, b.studioId, a.clientId)).toBeNull();
  });

  it("the write's own errors are not swallowed: a duplicate normalized email raises 23505", async () => {
    const s = await seedClient("atomic-dup");
    const other = randomUUID();
    await adminQuery(`insert into public.clients (id, studio_id, name, email) values ($1,$2,'Other Synthetic','dup-atomic@example.test')`, [other, s.studioId]);
    await expect(save(s, { email: "dup-atomic@example.test" }, { email: null })).rejects.toMatchObject({ code: "23505" });
  });

  // ---- the race ---------------------------------------------------------------------------------------------------------------------
  // A: another staff member's transaction has changed the field and not yet committed. B: this person's stale save arrives. B must WAIT
  // for A and then re-evaluate its WHERE clause against A's committed row, so it matches zero rows (nothing written, A's change kept).
  it("deterministic: a save that waits on a concurrent committed change re-checks and writes nothing", async () => {
    const s = await seedClient("atomic-race", { allergies: LONG_ALLERGIES });
    let bPid: number | null = null;
    let bDone = false;
    let bResult: string | null | undefined;
    let bPromise: Promise<void> = Promise.resolve();
    await adminTx(async (qa) => {
      await qa(`update public.clients set allergies = 'changed by someone else' where id = $1`, [s.clientId]);
      bPromise = asUser(s.userId, async (qb) => {
        bPid = (await qb(`select pg_backend_pid() as pid`)).rows[0].pid;
        bResult = (await qb(
          `select ${FN.replace("(uuid, uuid, jsonb, jsonb)", "")}($1,$2,$3::jsonb,$4::jsonb) as id`,
          [s.studioId, s.clientId, JSON.stringify({ allergies: LONG_ALLERGIES + " mine" }), JSON.stringify({ allergies: LONG_ALLERGIES })],
        )).rows[0].id;
      }).finally(() => { bDone = true; });
      let waiting = false;
      for (let i = 0; i < 100 && !bDone && !waiting; i++) {
        if (bPid !== null) {
          const w = await adminQuery(`select wait_event_type from pg_stat_activity where pid = $1`, [bPid]);
          waiting = w.rows[0]?.wait_event_type === "Lock";
        }
        if (!waiting) await sleep(50);
      }
      expect(waiting, "the stale save must be WAITING on the row, not have read-and-written already").toBe(true);
    });
    await bPromise;
    expect(bResult, "stale save").toBeNull();
    expect((await row(s.clientId)).allergies).toBe("changed by someone else");
  });

  it("randomised: two saves with the SAME expected value at once: exactly one applies, the other is stale, never both", async () => {
    for (let i = 0; i < 12; i += 1) {
      const s = await seedClient(`atomic-pair-${i}`, { allergies: LONG_ALLERGIES });
      const [x, y] = await Promise.all([
        save(s, { allergies: "writer-x" }, { allergies: LONG_ALLERGIES }),
        save(s, { allergies: "writer-y" }, { allergies: LONG_ALLERGIES }),
      ]);
      expect([x, y].filter((v) => v === s.clientId).length, `round ${i}`).toBe(1);
      expect([x, y].filter((v) => v === null).length, `round ${i}`).toBe(1);
      expect(["writer-x", "writer-y"]).toContain((await row(s.clientId)).allergies);
    }
  });

  // CONTROL: the interim app behaviour for a long field (read the current value, compare in the app, then write with no condition) loses
  // an update that lands between the read and the write. This documents the gap Sam does not accept; it passes on every stack, because
  // it asserts the LOST UPDATE. It is what the atomic function replaces.
  it("CONTROL: the interim read-compare-write overwrites a change made between its read and its write", async () => {
    const s = await seedClient("atomic-control", { allergies: LONG_ALLERGIES });
    const current = (await adminQuery(`select allergies from public.clients where id = $1`, [s.clientId])).rows[0].allergies;
    expect(current, "the app's read matches its baseline, so it proceeds").toBe(LONG_ALLERGIES);
    await adminQuery(`update public.clients set allergies = 'changed by someone else' where id = $1`, [s.clientId]); // lands in the gap
    await adminQuery(`update public.clients set allergies = $2 where id = $1`, [s.clientId, "mine, written blind"]); // the unconditioned write
    expect((await row(s.clientId)).allergies, "someone else's change was silently lost").toBe("mine, written blind");
  });

  it("conflict review data path is unchanged: after a stale (null) result the current values are readable in the body", async () => {
    const s = await seedClient("atomic-review", { allergies: "none", phone: "555-0100" });
    await adminQuery(`update public.clients set allergies = 'latex' where id = $1`, [s.clientId]);
    expect(await save(s, { allergies: "dust" }, { allergies: "none" })).toBeNull();
    const cur = await asUser(s.userId, async (q) => (await q(`select allergies, phone from public.clients where id = $1 and studio_id = $2`, [s.clientId, s.studioId])).rows[0]);
    expect(cur).toEqual({ allergies: "latex", phone: "555-0100" });
  });
});

describe("0281 part 2: M1 revisions, audit, grants", () => {
  it("name_revision bumps only when the name really changes; an unrelated or no-op update bumps nothing", async () => {
    const s = await seedClient("m1-rev", { phone: "555-0100" });
    const r0 = await row(s.clientId);
    expect([r0.name_revision, r0.preferred_name_revision]).toEqual([1, 1]);
    await adminQuery(`update public.clients set phone = '555-0101' where id = $1`, [s.clientId]);
    await adminQuery(`update public.clients set name = name where id = $1`, [s.clientId]);
    expect((await row(s.clientId)).name_revision).toBe(1);
    await asUser(s.userId, (q) => q(`update public.clients set name = 'Renamed Synthetic' where id = $1`, [s.clientId]));
    const r1 = await row(s.clientId);
    expect(r1.name_revision).toBe(2);
    await asUser(s.userId, (q) => q(`update public.clients set preferred_name = 'Sam' where id = $1`, [s.clientId]));
    const r2 = await row(s.clientId);
    expect([r2.name_revision, r2.preferred_name_revision]).toEqual([2, 2]);
  });

  it("name shape rule: blank or over-200 names are refused with 23514, only when the name itself is edited", async () => {
    const s = await seedClient("m1-shape");
    await expect(asUser(s.userId, (q) => q(`update public.clients set name = '   ' where id = $1`, [s.clientId]))).rejects.toMatchObject({ code: "23514" });
    await expect(asUser(s.userId, (q) => q(`update public.clients set name = $2 where id = $1`, [s.clientId, "n".repeat(201)]))).rejects.toMatchObject({ code: "23514" });
    await asUser(s.userId, (q) => q(`update public.clients set phone = '555-0102' where id = $1`, [s.clientId]));
  });

  it("the audit row records who, when, which concept and the new revision, and contains NO name value", async () => {
    const s = await seedClient("m1-audit");
    const before = (await row(s.clientId)).name as string;
    await asUser(s.userId, (q) => q(`update public.clients set name = 'Audit Probe Synthetic' where id = $1`, [s.clientId]));
    const a = (await adminQuery(`select * from public.client_identity_audit where client_id = $1`, [s.clientId])).rows;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ concept: "name", revision: 2, changed_by: s.practitionerId, studio_id: s.studioId });
    const flat = JSON.stringify(a[0]);
    expect(flat).not.toContain("Audit Probe Synthetic");
    expect(flat).not.toContain(before);
    expect(Object.keys(a[0]).sort()).toEqual(["changed_at", "changed_by", "client_id", "concept", "id", "revision", "studio_id"]);
  });

  it("audit grants: the owner reads their studio's rows, nobody has insert, update or delete; another studio reads none", async () => {
    const s = await seedClient("m1-audit-grants");
    const other = await seedStudio("m1-audit-other");
    await asUser(s.userId, (q) => q(`update public.clients set name = 'Grants Probe Synthetic' where id = $1`, [s.clientId]));
    const mine = await asUser(s.userId, async (q) => (await q(`select count(*)::int as n from public.client_identity_audit where client_id = $1`, [s.clientId])).rows[0].n);
    expect(mine).toBe(1);
    const theirs = await asUser(other.userId, async (q) => (await q(`select count(*)::int as n from public.client_identity_audit where client_id = $1`, [s.clientId])).rows[0].n);
    expect(theirs).toBe(0);
    for (const sql of [
      `insert into public.client_identity_audit (studio_id, client_id, concept, revision) values ('${s.studioId}','${s.clientId}','name',9)`,
      `update public.client_identity_audit set revision = 9`,
      `delete from public.client_identity_audit`,
    ]) {
      await expect(asUser(s.userId, (q) => q(sql)), sql).rejects.toMatchObject({ code: "42501" });
    }
    const g = await adminQuery(
      `select r.rolname, has_table_privilege(r.rolname, 'public.client_identity_audit', 'insert,update,delete') as w
         from pg_roles r where r.rolname in ('anon','authenticated','service_role')`,
    );
    for (const x of g.rows) expect(x.w, `${x.rolname} must not write the audit table`).toBe(false);
  });

  it("removing the practitioner who made a change is not blocked, and the audit row keeps existing with changed_by null", async () => {
    const s = await seedClient("m1-actor-delete");
    const m = await seedMember(s, "m1-actor");
    await adminQuery(`update public.clients set name = 'Actor Probe Synthetic' where id = $1`, [s.clientId]); // admin: no actor
    await asUser(m.userId, (q) => q(`update public.clients set name = 'Actor Probe Two Synthetic' where id = $1`, [s.clientId]));
    const before = (await adminQuery(`select changed_by from public.client_identity_audit where client_id = $1 order by revision`, [s.clientId])).rows;
    expect(before.map((r) => r.changed_by)).toContain(m.practitionerId);
    await adminQuery(`delete from public.practitioners where id = $1`, [m.practitionerId]);
    const after = (await adminQuery(`select changed_by from public.client_identity_audit where client_id = $1 order by revision`, [s.clientId])).rows;
    expect(after).toHaveLength(before.length);
    expect(after.map((r) => r.changed_by)).not.toContain(m.practitionerId);
  });

  it("legal identity: revision bumps only on a real change of a name part; the audit row has no value", async () => {
    const s = await seedClient("m1-legal");
    await asUser(s.userId, (q) =>
      q(`insert into public.client_legal_identities (client_id, studio_id, legal_given_name, legal_family_name) values ($1,$2,'Given','Family')`, [s.clientId, s.studioId]),
    );
    const rev = async () => (await adminQuery(`select revision from public.client_legal_identities where client_id = $1`, [s.clientId])).rows[0].revision as number;
    expect(await rev()).toBe(1);
    await asUser(s.userId, (q) => q(`update public.client_legal_identities set legal_given_name = 'Given' where client_id = $1`, [s.clientId]));
    expect(await rev()).toBe(1);
    await asUser(s.userId, (q) => q(`update public.client_legal_identities set legal_given_name = 'Other' where client_id = $1`, [s.clientId]));
    expect(await rev()).toBe(2);
    const a = (await adminQuery(`select * from public.client_identity_audit where client_id = $1 and concept = 'legal_name'`, [s.clientId])).rows;
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0])).not.toMatch(/Given|Family|Other/);
  });

  it("source: 'client_provided' is allowed, anything else still refused (23514)", async () => {
    const s = await seedClient("m1-source");
    await adminQuery(`insert into public.client_legal_identities (client_id, studio_id, legal_given_name, source) values ($1,$2,'Given','client_provided')`, [s.clientId, s.studioId]);
    await expect(adminQuery(`update public.client_legal_identities set source = 'insurer_response' where client_id = $1`, [s.clientId])).rejects.toMatchObject({ code: "23514" });
  });

  it("the trigger functions are not executable by any API role (revoked by name)", async () => {
    const r = await adminQuery(
      `select p.proname, has_function_privilege('public', p.oid, 'execute') as pub, has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('clients_identity_guard','client_legal_identities_revision')`,
    );
    expect(r.rows).toHaveLength(2);
    for (const x of r.rows) expect({ pub: x.pub, anon: x.anon, auth: x.auth, svc: x.svc }, x.proname).toEqual({ pub: false, anon: false, auth: false, svc: false });
  });

  it("the profile save and M1 compose: a name change through the function bumps name_revision and writes one value-free audit row", async () => {
    const s = await seedClient("m1-compose");
    const cur = (await row(s.clientId)).name as string;
    expect(await save(s, { name: "Composed Synthetic" }, { name: cur })).toBe(s.clientId);
    const r = await row(s.clientId);
    expect(r.name_revision).toBe(2);
    const n = (await adminQuery(`select count(*)::int as n from public.client_identity_audit where client_id = $1`, [s.clientId])).rows[0].n;
    expect(n).toBe(1);
    // A stale name save writes nothing and bumps nothing.
    expect(await save(s, { name: "Stale Synthetic" }, { name: cur })).toBeNull();
    expect((await row(s.clientId)).name_revision).toBe(2);
  });
  // ---- Privacy AT1/AT2/AT3/AT5/AT6, Insurance CB-1/CB-2/CB-3 ----
  const seedReceptionist = async (s: SeededStudio) => {
    const userId = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [userId, `m1-recept-${userId.slice(0, 8)}@harness.local`]);
    await adminQuery(`insert into public.studio_receptionists (studio_id, user_id, display_name, active) values ($1, $2, 'Synthetic Front Desk', true)`, [s.studioId, userId]);
    return userId;
  };
  const auditCount = (userId: string, clientId: string) =>
    asUser(userId, async (q) => (await q(`select count(*)::int as n from public.client_identity_audit where client_id = $1`, [clientId])).rows[0].n as number);

  it("AT1: owner and practitioner read the audit rows; an active receptionist of the same studio reads ZERO rows", async () => {
    const s = await seedClient("m1-audit-desk");
    const pract = await seedMember(s, "m1-audit-pract");
    const desk = await seedReceptionist(s);
    await asUser(s.userId, (q) => q(`update public.clients set name = 'Desk Probe Synthetic' where id = $1`, [s.clientId]));
    expect(await auditCount(s.userId, s.clientId)).toBe(1);
    expect(await auditCount(pract.userId, s.clientId)).toBe(1);
    expect(await auditCount(desk, s.clientId)).toBe(0);
    const admin = (await adminQuery(`select count(*)::int as n from public.client_identity_audit where client_id = $1`, [s.clientId])).rows[0].n;
    expect(admin, "the row exists; the desk role is simply denied it").toBe(1);
  });

  it("AT2: a direct write to a revision column has no effect (update, combined update, insert, and as the table owner)", async () => {
    const s = await seedClient("m1-forge");
    await asUser(s.userId, (q) => q(`update public.clients set name_revision = 99, preferred_name_revision = 77 where id = $1`, [s.clientId]));
    let r = await row(s.clientId);
    expect([r.name_revision, r.preferred_name_revision]).toEqual([1, 1]);
    await asUser(s.userId, (q) => q(`update public.clients set name = 'Forge Synthetic', name_revision = 1, preferred_name_revision = 50 where id = $1`, [s.clientId]));
    r = await row(s.clientId);
    expect([r.name_revision, r.preferred_name_revision], "a real name change bumps once; the forged preferred revision is discarded").toEqual([2, 1]);
    await adminQuery(`update public.clients set name_revision = 1 where id = $1`, [s.clientId]);
    expect((await row(s.clientId)).name_revision, "not even the owner role can lower it").toBe(2);
    await asUser(s.userId, (q) => q(`update public.clients set name_revision = name_revision - 1 where id = $1`, [s.clientId]));
    expect((await row(s.clientId)).name_revision).toBe(2);
    const ins = await adminQuery(
      `insert into public.clients (studio_id, name, name_revision, preferred_name_revision) values ($1, 'Forge Insert Synthetic', 88, 66) returning id`,
      [s.studioId],
    );
    const i = await row(ins.rows[0].id);
    expect([i.name_revision, i.preferred_name_revision]).toEqual([1, 1]);
    // The audit shows exactly the one real change.
    const a = (await adminQuery(`select concept, revision from public.client_identity_audit where client_id = $1`, [s.clientId])).rows;
    expect(a).toEqual([{ concept: "name", revision: 2 }]);
  });

  it("CB-8: a legal-identity row is stamped revision 1 on INSERT whatever the caller sent (practitioner and table owner), and an update still bumps once", async () => {
    const s = await seedClient("m1-legal-forge");
    await asUser(s.userId, (q) =>
      q(`insert into public.client_legal_identities (client_id, studio_id, legal_given_name, legal_family_name, revision) values ($1,$2,'Given','Family', 99)`, [s.clientId, s.studioId]),
    );
    const rev = async () => (await adminQuery(`select revision from public.client_legal_identities where client_id = $1`, [s.clientId])).rows[0].revision as number;
    expect(await rev(), "forged insert revision is discarded").toBe(1);
    await asUser(s.userId, (q) => q(`update public.client_legal_identities set legal_given_name = 'Other' where client_id = $1`, [s.clientId]));
    expect(await rev(), "the next real change audits revision 2, not 100").toBe(2);
    await adminQuery(`delete from public.client_legal_identities where client_id = $1`, [s.clientId]);
    await adminQuery(`insert into public.client_legal_identities (client_id, studio_id, legal_given_name, revision) values ($1,$2,'Given', 55)`, [s.clientId, s.studioId]);
    expect(await rev(), "not even the table owner can seed a revision").toBe(1);
  });

  // Codex P2 on #1358: a client whose stored name is ALREADY over 200 characters (older data) must still save other fields.
  // The shape rule applies when the name is written or changed, never to an unrelated update.
  it("legacy over-length name: an unrelated edit, the atomic profile save and re-sending the same name all succeed; a changed name is still checked", async () => {
    const s = await seedClient("m1-legacy-long");
    const LONG = "L".repeat(250);
    // Create the legacy shape the way older data has it: the trigger is switched off for this one transaction.
    await adminTx(async (q) => {
      await q(`alter table public.clients disable trigger clients_identity_guard`);
      await q(`update public.clients set name = $2 where id = $1`, [s.clientId, LONG]);
      await q(`alter table public.clients enable trigger clients_identity_guard`);
    });
    expect((await row(s.clientId)).name).toBe(LONG);
    const before = await row(s.clientId);
    // 1) unrelated direct update as a practitioner
    await asUser(s.userId, (q) => q(`update public.clients set phone = '555-0199' where id = $1`, [s.clientId]));
    let r = await row(s.clientId);
    expect([r.phone, r.name, r.name_revision]).toEqual(["555-0199", LONG, before.name_revision]);
    // 2) the atomic profile save, patching another field only
    const saved = await asUser(s.userId, async (q) =>
      (await q(`select public.update_client_profile_if_unchanged($1,$2,$3::jsonb,$4::jsonb) as id`, [s.studioId, s.clientId, JSON.stringify({ pronouns: "they/them" }), JSON.stringify({ pronouns: r.pronouns })])).rows[0].id,
    );
    expect(saved).toBe(s.clientId);
    // 3) re-sending the SAME over-length name is not a name change
    await asUser(s.userId, (q) => q(`update public.clients set name = $2, email = 'legacy-long@example.test' where id = $1`, [s.clientId, LONG]));
    r = await row(s.clientId);
    expect([r.name, r.email, r.name_revision]).toEqual([LONG, "legacy-long@example.test", before.name_revision]);
    expect((await adminQuery(`select count(*)::int n from public.client_identity_audit where client_id = $1`, [s.clientId])).rows[0].n, "no name change, no audit row").toBe(0);
    // 4) CHANGING the name is still checked: another over-length name is refused, a valid one is saved and bumps the revision once
    await expect(asUser(s.userId, (q) => q(`update public.clients set name = $2 where id = $1`, [s.clientId, "M".repeat(251)]))).rejects.toMatchObject({ code: "23514" });
    await asUser(s.userId, (q) => q(`update public.clients set name = 'Short Synthetic' where id = $1`, [s.clientId]));
    r = await row(s.clientId);
    expect([r.name, r.name_revision]).toEqual(["Short Synthetic", before.name_revision + 1]);
  });

  it("AT5: a write with no signed-in practitioner (service role) still audits, with changed_by null", async () => {
    const s = await seedClient("m1-svc");
    const out = await asRole("service_role", async (q) => {
      await q(`update public.clients set name = 'Service Synthetic' where id = $1`, [s.clientId]);
      return (await q(`select name_revision from public.clients where id = $1`, [s.clientId])).rows[0].name_revision;
    });
    expect(out).toBe(2);
    // asRole rolls back, so prove the audit inside the same transaction by repeating through adminTx.
    await adminTx(async (q) => {
      await q(`set local role service_role`);
      await q(`update public.clients set name = 'Service Synthetic' where id = $1`, [s.clientId]);
      await q(`reset role`);
      const a = (await q(`select changed_by, concept, revision from public.client_identity_audit where client_id = $1`, [s.clientId])).rows;
      expect(a).toEqual([{ changed_by: null, concept: "name", revision: 2 }]);
    });
  });

  it("AT6: an active receptionist cannot use the profile save: nothing is written", async () => {
    const s = await seedClient("m1-fn-desk", { allergies: "none" });
    const desk = await seedReceptionist(s);
    const result = await asUser(desk, async (q) => {
      try {
        return (await q(`select public.update_client_profile_if_unchanged($1,$2,$3::jsonb,$4::jsonb) as id`, [s.studioId, s.clientId, JSON.stringify({ allergies: "changed" }), JSON.stringify({ allergies: "none" })])).rows[0].id as string | null;
      } catch (e) {
        return `error:${(e as { code?: string }).code}`;
      }
    });
    expect(result === null || String(result).startsWith("error:"), `receptionist result: ${result}`).toBe(true);
    expect((await row(s.clientId)).allergies).toBe("none");
  });

  it("AT3/CB-3: every code path that inserts a client is listed here; each refuses a blank or over-200 name and accepts a valid one", async () => {
    // The census: any function whose source inserts into public.clients. A NEW path must be added here WITH its own check below.
    const fns = (await adminQuery(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosrc ~* 'insert\\s+into\\s+(public\\.)?clients\\y' order by 1`,
    )).rows.map((r) => r.proname);
    expect(fns).toEqual([
      "create_public_appointment_for_new_client",
      "create_public_appointment_for_new_client_v2",
      "find_or_create_client_for_booking",
      "find_or_create_client_for_booking_payment_strict",
    ]);
    const s = await seedStudio("m1-insert-paths");
    const BAD = ["", "   ", "x".repeat(201)];
    // Direct table insert: the three staff paths (new client form, calendar quick-create, quick import) all use this as an authenticated practitioner.
    for (const name of BAD) {
      await expect(asUser(s.userId, (q) => q(`insert into public.clients (studio_id, name) values ($1, $2)`, [s.studioId, name])), `direct insert ${JSON.stringify(name.slice(0, 5))}`).rejects.toMatchObject({ code: "23514" });
    }
    const ok = await asUser(s.userId, async (q) => (await q(`insert into public.clients (studio_id, name) values ($1, $2) returning name_revision`, [s.studioId, "y".repeat(200)])).rows[0].name_revision);
    expect(ok).toBe(1);
    // Bulk statement (quick import inserts many rows in one statement): one bad row refuses the whole statement.
    await expect(asUser(s.userId, (q) => q(`insert into public.clients (studio_id, name) values ($1,'Bulk A Synthetic'), ($1, $2)`, [s.studioId, "z".repeat(201)]))).rejects.toMatchObject({ code: "23514" });
    // Public booking: find-or-create, both variants.
    for (const fn of ["find_or_create_client_for_booking", "find_or_create_client_for_booking_payment_strict"]) {
      for (const name of BAD) {
        await expect(adminQuery(`select * from public.${fn}($1, $2, $3, $4)`, [s.studioId, `${fn}-bad@example.test`, name, null]), `${fn} ${JSON.stringify(name.slice(0, 5))}`).rejects.toMatchObject({ code: "23514" });
      }
      const g = await adminQuery(`select * from public.${fn}($1, $2, $3, $4)`, [s.studioId, `${fn}-ok@example.test`, "Valid Synthetic", null]);
      expect(g.rows[0].client_created_during_call).toBe(true);
    }
  });

  // Privacy CD2: the two booking commands that create a client inside the appointment transaction get the SAME refusal
  // cases as the find-or-create pair above. The public form limits the name first (client-name-length.test.ts), so a
  // customer never sees 23514 raw; this proves the database still refuses if anything ever reaches it.
  it("CD2: create_public_appointment_for_new_client and _v2 refuse a blank, spaces-only or over-200 name and write nothing; a valid name books", async () => {
    const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");
    const studioId = randomUUID();
    const userId = randomUUID();
    const serviceId = randomUUID();
    const email = `cd2-${studioId.slice(0, 8)}@harness.local`;
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [userId, email]);
    await adminQuery(
      `insert into public.studios (id, name, owner_email, timezone, buffer_minutes, slug, public_booking_horizon_months)
       values ($1, 'CD2 booking', $2, 'UTC', 0, $3, 3)`,
      [studioId, email, `cd2-${studioId.slice(0, 8)}`],
    );
    await adminQuery(
      `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active) values ($1, $2, $3, 'Owner', $4, 'owner', true)`,
      [randomUUID(), studioId, userId, email],
    );
    await adminQuery(
      `insert into public.services (id, studio_id, name, default_duration_minutes, active) values ($1, $2, 'Consultation', 60, true)`,
      [serviceId, studioId],
    );
    await adminQuery(
      `insert into public.studio_availability_default (studio_id, day_of_week, is_open, open_time, close_time, practitioner_id)
       select $1, g, true, '09:00', '17:00', null from generate_series(0, 6) g`,
      [studioId],
    );
    await adminTx(async (q) => {
      await q("select set_config('hone.admission_mode_studio_id', $1, true)", [studioId]);
      await q(`update public.studios set new_client_admission_mode = 'open', new_client_admission_mode_set_at = now() where id = $1`, [studioId]);
    });
    const slot = (days: number) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + days);
      d.setUTCHours(11, 0, 0, 0);
      return d.toISOString();
    };
    const call = (fn: string, name: string, mail: string, startsAt: string) =>
      adminTx(async (q) => {
        await q("set local role service_role");
        return q(
          `select * from public.${fn}($1, null, $2, $3, '+15550177', now(), $4, $5::timestamptz, $6, false, null, null)`,
          [studioId, name, mail, serviceId, startsAt, hash64()],
        );
      });
    let n = 0;
    for (const fn of ["create_public_appointment_for_new_client", "create_public_appointment_for_new_client_v2"]) {
      n += 1;
      for (const name of ["", "   ", "x".repeat(201)]) {
        await expect(call(fn, name, `cd2-bad-${n}@example.test`, slot(5 + n)), `${fn} ${JSON.stringify(name.slice(0, 5))}`).rejects.toMatchObject({ code: "23514" });
      }
      expect((await adminQuery(`select count(*)::int c from public.clients where studio_id = $1 and email = $2`, [studioId, `cd2-bad-${n}@example.test`])).rows[0].c).toBe(0);
      const ok = await call(fn, "Valid Synthetic", `cd2-ok-${n}@example.test`, slot(5 + n));
      expect(ok.rows[0].result).toBe("created");
    }
  });
});
