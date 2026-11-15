import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, closePool, seedMember, seedSession, seedStudio, type SeededStudio, type UserQuery } from "./helpers/harness";

// RBAC Nov-20 matrix G6 (FD-5/FD-6/F-5/C12): a REAL receptionist login against every member-gated table and function.
//
// Where a receptionist lives (0001, 0216, 0218): practitioners.role is CHECKED to ('owner','practitioner') (0001:24), so a receptionist can NOT be a practitioners row;
// the membership is a studio_receptionists row (0216), and a dual-membership trigger on practitioners refuses a user who is both. pending_invitations.role admits
// 'receptionist' (0218) but acceptance writes studio_receptionists, never practitioners. is_studio_member() reads practitioners only, so it is false for a receptionist.
// This file PROVES that (structure test) instead of assuming it, then checks the consequence on every object:
//   TABLES  every public base table with a studio_id column: rows of studio A visible to the receptionist, and rows she can update or delete, must equal what a
//           STRANGER (an authenticated user with no membership anywhere) gets. Positive controls: an owner sees rows in each seeded key table.
//   RPCs    every public function executable by `authenticated` (not trigger functions, not extension functions, not the reviewed receptionist_* family) is called as the
//           receptionist, as a stranger and as a practitioner (control) with arguments built from the fixture (rolled back). The receptionist outcome must equal the stranger's.
//           Functions where even the practitioner's outcome equals the stranger's did not reach their gate with these arguments; they are LISTED, not counted as proof.
// Anything the receptionist can do beyond a stranger fails the test and names the object: that would be a live gap. Synthetic ids only. Each probe runs in a rolled-back transaction.

type J = Record<string, any>;
let A: SeededStudio;
let M: { userId: string; practitionerId: string }; // practitioner (control)
let R: { userId: string }; // receptionist
let S: { userId: string }; // stranger
const seeded: string[] = [];
const real: J = {}; // real fixture ids for function arguments

const newUser = async (label: string): Promise<string> => {
  const id = randomUUID();
  await adminQuery("insert into auth.users (id,email) values ($1,$2)", [id, `${label}-${id.slice(0, 8)}@harness.local`]);
  return id;
};
async function asJwt<T>(userId: string, fn: (q: UserQuery) => Promise<T>): Promise<T> {
  return asRole("authenticated", async (q) => {
    await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    return fn(q);
  });
}
// outcome of a statement as a comparable string, in a savepoint so one failure does not poison the transaction
async function outcome(q: UserQuery, sql: string, params: unknown[] = []): Promise<string> {
  await q("savepoint probe");
  try {
    const r = await q(sql, params);
    await q("release savepoint probe");
    return "ok:" + JSON.stringify(r.rows ?? []).slice(0, 400) + ":" + (r.rowCount ?? "");
  } catch (e) {
    await q("rollback to savepoint probe");
    const err = e as { code?: string; message?: string };
    return "err:" + (err.code ?? "?");
  }
}
async function trySeed(label: string, sql: string, params: unknown[]): Promise<void> {
  try {
    await adminQuery(sql, params);
    seeded.push(label);
  } catch (e) {
    console.log(`fixture seed FAILED, its checks are vacuous: ${label}: ${(e as Error).message}`);
  }
}

beforeAll(async () => {
  A = await seedStudio("rb-rec");
  const { sessionId, blockId } = await seedSession(A);
  real.session = sessionId;
  real.block = blockId;
  M = await seedMember(A, "rb-rec-m");
  R = { userId: await newUser("rb-rec-desk") };
  S = { userId: await newUser("rb-rec-stranger") };
  await adminQuery("insert into public.studio_receptionists(studio_id,user_id,display_name,active) values ($1,$2,'Synthetic Front Desk',true)", [A.studioId, R.userId]);
  const svc = randomUUID();
  await trySeed("services", "insert into public.services(id,studio_id,name) values ($1,$2,'Synthetic service')", [svc, A.studioId]);
  await trySeed("client_pricing", "insert into public.client_pricing(studio_id,client_id,service_name,price_cents) values ($1,$2,'Synthetic service',12345)", [A.studioId, A.clientId]);
  await trySeed("studio_payment_settings", "insert into public.studio_payment_settings(studio_id,stripe_account_id,stripe_livemode) values ($1,$2,false)", [A.studioId, `acct_${A.studioId.slice(0, 8)}`]);
  await trySeed("client_stripe_customers", "insert into public.client_stripe_customers(client_id,studio_id,stripe_account_id,stripe_livemode,stripe_customer_id) values ($1,$2,$3,false,'cus_x')", [A.clientId, A.studioId, `acct_${A.studioId.slice(0, 8)}`]);
  await trySeed("client_payment_methods", "insert into public.client_payment_methods(studio_id,client_id,stripe_account_id,stripe_customer_id,stripe_payment_method_id,stripe_setup_intent_id,brand,last4,exp_month,exp_year) values ($1,$2,$3,'cus_x','pm_x','seti_x','visa','4242',12,2030)", [A.studioId, A.clientId, `acct_${A.studioId.slice(0, 8)}`]);
  real.appointment = randomUUID();
  real.image = randomUUID();
  await trySeed("appointments", "insert into public.appointments(id,studio_id,client_id,practitioner_id,starts_at,ends_at,duration_minutes,buffer_minutes_snapshot,blocked_ends_at) values ($4,$1,$2,$3,now()+interval '2 days',now()+interval '2 days 1 hour',60,0,now()+interval '2 days 1 hour')", [A.studioId, A.clientId, A.practitionerId, real.appointment]);
  await trySeed("treatment_images", "insert into public.treatment_images(id,studio_id,client_id,session_id,session_block_id,storage_path,content_type,size_bytes) values ($6,$1,$2,$3,$4,$5,'image/jpeg',10)", [A.studioId, A.clientId, sessionId, blockId, `${A.studioId}/${A.clientId}/synthetic.jpg`, real.image]);
  await trySeed("client_clinical_notes", "insert into public.client_clinical_notes(client_id,studio_id,practitioner_id,kind,body) values ($1,$2,$3,'consultation','Synthetic clinical text')", [A.clientId, A.studioId, A.practitionerId]);
});
afterAll(async () => {
  await closePool();
});

async function compareTables(who: string): Promise<string[]> {
  const tables = (
    await adminQuery(
      `select t.table_name n from information_schema.tables t join information_schema.columns c on c.table_schema=t.table_schema and c.table_name=t.table_name and c.column_name='studio_id'
       where t.table_schema='public' and t.table_type='BASE TABLE' order by 1`,
    )
  ).rows.map((r: J) => r.n as string);
  expect(tables.length).toBeGreaterThan(80);
  const diffs: string[] = [];
  for (const t of tables) {
    const probes: [string, string][] = [
      ["select", `select count(*) n from public.${t} where studio_id=$1`],
      ["update", `update public.${t} set studio_id=studio_id where studio_id=$1`],
      ["delete", `delete from public.${t} where studio_id=$1`],
    ];
    for (const [kind, sql] of probes) {
      if (t === "studio_receptionists" && kind === "select") continue; // her own membership row is read on purpose; asserted exactly in the next test
      const rec = await asJwt(who, (q) => outcome(q, sql, [A.studioId]));
      const str = await asJwt(S.userId, (q) => outcome(q, sql, [A.studioId]));
      if (rec !== str) diffs.push(`${t} ${kind}: ${rec.slice(0, 120)} vs stranger ${str.slice(0, 120)}`);
    }
  }
  return diffs;
}

describe("where a receptionist lives (structure, proven not assumed)", () => {
  it("practitioners.role cannot be 'receptionist'; a user cannot be both; is_studio_member/owner are false for her and true for a practitioner", async () => {
    const check = await adminQuery("select pg_get_constraintdef(c.oid) d from pg_constraint c where conrelid='public.practitioners'::regclass and contype='c' and pg_get_constraintdef(c.oid) ilike '%role%'");
    expect(check.rows.map((r: J) => r.d).join(" ")).not.toMatch(/receptionist/);
    await expect(
      adminQuery("insert into public.practitioners(id,studio_id,user_id,display_name,email,role,active) values ($1,$2,$3,'x','x@harness.local','receptionist',true)", [randomUUID(), A.studioId, await newUser("rb-rec-role")]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      adminQuery("insert into public.practitioners(id,studio_id,user_id,display_name,email,role,active) values ($1,$2,$3,'x','y@harness.local','practitioner',true)", [randomUUID(), A.studioId, R.userId]),
    ).rejects.toThrow();
    expect((await adminQuery("select count(*) n from public.practitioners where user_id=$1", [R.userId])).rows[0].n).toBe("0");
    const gate = async (u: string) => asJwt(u, async (q) => (await q("select public.is_studio_member($1) m, public.is_studio_owner($1) o", [A.studioId])).rows[0]);
    expect(await gate(R.userId)).toEqual({ m: false, o: false });
    expect(await gate(S.userId)).toEqual({ m: false, o: false });
    expect(await gate(M.userId)).toEqual({ m: true, o: false }); // control
    expect(await gate(A.userId)).toEqual({ m: true, o: true }); // control
  });
});

describe("every studio-scoped table: the receptionist gets what a stranger gets", () => {
  it("positive controls: the owner sees rows in the key tables this fixture seeded", async () => {
    expect(seeded, "fixture seeds that failed would make the checks below vacuous for those tables").toEqual(
      expect.arrayContaining(["services", "client_pricing", "client_payment_methods", "appointments", "treatment_images", "client_clinical_notes"]),
    );
    for (const t of ["clients", "sessions", "session_blocks", "practitioners", "services", "client_pricing", "client_payment_methods", "appointments", "treatment_images", "client_clinical_notes"]) {
      const n = await asJwt(A.userId, async (q) => Number((await q(`select count(*) n from public.${t} where studio_id=$1`, [A.studioId])).rows[0].n));
      expect(n, `${t}: the owner must see seeded rows (positive control)`).toBeGreaterThan(0);
    }
  });

  it("read, update and delete reach nothing beyond the stranger's reach, table by table", async () => {
    expect(await compareTables(R.userId), "objects where a receptionist reaches more than a stranger (LIVE GAP)").toEqual([]);
  });

  it("NEGATIVE CONTROL: the same comparison run as a practitioner finds many differences (so it can fail)", async () => {
    const diffs = await compareTables(M.userId);
    expect(diffs.length, "a practitioner must differ from a stranger on at least the seeded key tables, or the comparison proves nothing").toBeGreaterThanOrEqual(10); // one per seeded key table at least (14 measured)
  });
});

describe("her own membership row, and nothing else of the desk table", () => {
  it("a receptionist reads exactly her own studio_receptionists row; a stranger and a practitioner read none of it", async () => {
    const mine = async (u: string) => asJwt(u, async (q) => (await q("select user_id from public.studio_receptionists where studio_id=$1", [A.studioId])).rows.map((r: J) => r.user_id));
    expect(await mine(R.userId)).toEqual([R.userId]);
    expect(await mine(S.userId)).toEqual([]);
    expect(await mine(M.userId)).toEqual([]); // a practitioner who is not the owner sees none; 0216 policy is the receptionist's own row only
  });
});

async function compareFns(who: string): Promise<{ diffs: string[]; reached: string[]; notExercised: string[]; total: number }> {
    const fns = (
      await adminQuery(
        `select p.oid::int8 oid, p.proname, pg_get_function_identity_arguments(p.oid) a, p.proargnames names, p.proargtypes::oid[] types
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.prokind='f' and has_function_privilege('authenticated',p.oid,'EXECUTE')
           and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
           and pg_get_function_result(p.oid)<>'trigger' and p.proname not like 'receptionist\\_%'
           and p.proname not in ('is_studio_member','is_studio_owner') order by 2, 3`,
      )
    ).rows;
    expect(fns.length).toBeGreaterThan(40);
    const typeName = async (oid: number) => (await adminQuery("select format_type($1,null) t", [oid])).rows[0].t as string;
    const ids: J = { studio: A.studioId, client: A.clientId, practitioner: A.practitionerId, session: real.session, block: real.block, appointment: real.appointment, image: real.image };
    const arg = (name: string, type: string): string => {
      const n = (name ?? "").toLowerCase();
      if (type === "uuid") return `'${n.includes("studio") ? ids.studio : n.includes("client") ? ids.client : n.includes("practitioner") || n.includes("performer") ? ids.practitioner : n.includes("session") ? ids.session : n.includes("block") ? ids.block : n.includes("appointment") ? ids.appointment : n.includes("image") ? ids.image : randomUUID()}'::uuid`;
      if (type === "text") return "'x'";
      if (type === "integer" || type === "smallint" || type === "bigint") return "1";
      if (type === "boolean") return "true";
      if (type === "jsonb") return "'{}'::jsonb";
      if (type.endsWith("[]")) return "null";
      return "null";
    };
    const diffs: string[] = [];
    const reached: string[] = [];
    const notExercised: string[] = [];
    for (const f of fns) {
      const names: string[] = f.names ?? [];
      const argSql: string[] = [];
      for (let i = 0; i < f.types.length; i++) argSql.push(arg(names[i] ?? "", await typeName(f.types[i])) + `::${await typeName(f.types[i])}`);
      const sql = `select public.${f.proname}(${argSql.join(",")}) r`;
      const rec = await asJwt(who, (q) => outcome(q, sql));
      const str = await asJwt(S.userId, (q) => outcome(q, sql));
      const mem = await asJwt(M.userId, (q) => outcome(q, sql));
      const label = `${f.proname}(${f.a})`.slice(0, 110);
      if (rec !== str) diffs.push(`${label}: receptionist ${rec.slice(0, 100)} vs stranger ${str.slice(0, 100)}`);
      (mem !== str ? reached : notExercised).push(label);
    }
    return { diffs, reached, notExercised, total: fns.length };
}

describe("every callable function: the receptionist gets what a stranger gets", () => {
  it("calls each authenticated-executable public function with fixture arguments", async () => {
    const { diffs, reached, notExercised, total } = await compareFns(R.userId);
    console.log(`RPC probe: ${total} functions; ${reached.length} reached their gate (practitioner differs from stranger); ${notExercised.length} not exercised by these arguments:\n${notExercised.join("\n")}`);
    expect(total).toBeGreaterThan(40);
    expect(diffs, "functions where a receptionist gets more than a stranger (LIVE GAP)").toEqual([]);
    expect(reached.length, "too few functions reached their gate for the comparison to mean anything").toBeGreaterThan(10);
  });
});

describe("REMOVAL (G8/C6): a member removed while holding a valid JWT is refused on the next request, on every table and function", () => {
  it("control: while active the member differs from a stranger; after the real removal command, tables and functions equal the stranger's", async () => {
    const rm = await seedMember(A, "rb-removed");
    const tablesBefore = await compareTables(rm.userId);
    const fnsBefore = await compareFns(rm.userId);
    expect(tablesBefore.length, "positive control: an active member reaches the seeded tables").toBeGreaterThanOrEqual(10);
    expect(fnsBefore.diffs.length, "positive control: an active member reaches functions a stranger cannot").toBeGreaterThan(5);
    expect((await adminQuery("select public.set_practitioner_active_locked($1,$2,$3,false) r", [A.studioId, A.practitionerId, rm.practitionerId])).rows[0].r).toBe("ok");
    // the JWT is unchanged: the same user id, the same claims, the very next request
    expect(await compareTables(rm.userId), "tables a removed member still reaches (LIVE GAP)").toEqual([]);
    const after = await compareFns(rm.userId);
    expect(after.diffs, "functions a removed member still reaches (LIVE GAP)").toEqual([]);
  });
});
