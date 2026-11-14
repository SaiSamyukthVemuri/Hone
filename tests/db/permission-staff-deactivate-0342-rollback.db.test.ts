import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, adminTx, closePool } from "./helpers/harness";

// The 0342 rollback, run INSIDE a transaction that is then rolled back (a sentinel throw), so the stack stays on 0342 for the other files.
// Synthetic only. NOT RUN until a slot is granted.
afterAll(async () => {
  await closePool();
});

const DOWN = readFileSync("supabase/rollbacks/0342_roles_staff_deactivate_core.down.sql", "utf8");
const BODY = DOWN.replace(/^\s*begin;\s*$/m, "").replace(/^\s*commit;\s*$/m, "");
const ROLLBACK = new Error("rollback sentinel");

describe("0342 rollback", () => {
  it("drops the three functions, restores 0287's change_staff_role and the five-kind CHECK, keeps existing audit rows, and leaves 0342 intact once rolled back", async () => {
    const before = (await adminQuery("select count(*)::int n from public.permission_audit", [])).rows[0].n as number;
    const seen: Record<string, any> = {};
    await adminTx(async (q) => {
      await q(BODY, []);
      seen.gone = (await q("select to_regprocedure('public.deactivate_staff_member(uuid,uuid,text,text)') a, to_regprocedure('public.reactivate_staff_member(uuid,uuid,text,text)') b, to_regprocedure('public.perm_upcoming_policy()') c", [])).rows[0];
      seen.def = (await q("select pg_get_functiondef('public.change_staff_role(uuid,uuid,text,text,text)'::regprocedure) d", [])).rows[0].d;
      seen.chk = (await q("select pg_get_constraintdef(oid) d from pg_constraint where conrelid='public.permission_audit'::regclass and conname='permission_audit_kind_check'", [])).rows[0].d;
      await q("savepoint s1", []);
      try {
        await q("insert into public.permission_audit(studio_id,kind,before,after) values (gen_random_uuid(),'staff_deactivated','{}','{}')", []);
        seen.insertRefused = false;
      } catch (e) {
        seen.insertRefused = /check constraint|permission_audit_kind_check/i.test(String(e));
        await q("rollback to savepoint s1", []);
      }
      seen.count = (await q("select count(*)::int n from public.permission_audit", [])).rows[0].n;
      seen.grants = (await q("select has_function_privilege('authenticated','public.change_staff_role(uuid,uuid,text,text,text)','execute') a, has_function_privilege('anon','public.change_staff_role(uuid,uuid,text,text,text)','execute') b, has_function_privilege('service_role','public.change_staff_role(uuid,uuid,text,text,text)','execute') c", [])).rows[0];
      throw ROLLBACK;
    }).catch((e) => {
      if (e !== ROLLBACK) throw e;
    });
    expect(seen.gone).toEqual({ a: null, b: null, c: null });
    expect(seen.def).not.toContain("acquire_studio_capacity_lock"); // 0287's body: RF-1 open again
    expect(seen.def).toContain("has_upcoming_appointments");
    expect(seen.chk).not.toContain("staff_deactivated");
    expect(seen.chk).toContain("permissions_activated");
    expect(seen.insertRefused).toBe(true);
    expect(seen.count).toBe(before);
    expect(seen.grants).toEqual({ a: true, b: false, c: false });
    const still = await adminQuery("select to_regprocedure('public.deactivate_staff_member(uuid,uuid,text,text)') a", []);
    expect(still.rows[0].a).not.toBeNull();
  });
});
