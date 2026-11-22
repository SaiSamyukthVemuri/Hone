import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, adminTx, closePool, type UserQuery } from "./helpers/harness";

// Proposal qualification: one guarded local transaction, DDL + fixtures always
// rolled back. A failure also rolls back. No hosted credentials or schema apply.
const proposal = readFileSync(new URL("../../docs/proposals/client-groups/UP.sql", import.meta.url), "utf8")
  .replace(/^begin;\n/m, "").replace(/\ncommit;\s*$/, "");
const functions = ["create_client_group", "rename_client_group", "set_client_group_membership"];
async function catalog() {
  return (await adminQuery(`select p.oid,p.proacl::text,p.proconfig,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1) order by p.oid`, [functions])).rows;
}
type Fixture = { studio: string; foreign: string; owner: string; member: string; client: string; foreignClient: string };
async function withProposal(run: (q: UserQuery, f: Fixture) => Promise<void>) {
  const before = await catalog();
  const beforeTables = (await adminQuery("select to_regclass('public.client_groups')::text as groups,to_regclass('public.client_group_memberships')::text as memberships")).rows;
  const rollback = new Error("rollback fixture");
  try {
    await adminTx(async q => {
      const existing = beforeTables[0];
      if (Boolean(existing.groups) !== Boolean(existing.memberships)) throw new Error("Client groups qualification requires either both relations or neither, not a partial schema.");
      if (!existing.groups) await q(proposal);
      const f = { studio: randomUUID(), foreign: randomUUID(), owner: randomUUID(), member: randomUUID(), client: randomUUID(), foreignClient: randomUUID() };
      await q(`insert into auth.users(id,email) values ($1,'group-owner@harness.local'),($2,'group-member@harness.local')`, [f.owner, f.member]);
      await q(`insert into public.studios(id,name,owner_email,timezone) values ($1,'Group fixture','group-owner@harness.local','UTC'),($2,'Foreign fixture','foreign@harness.local','UTC')`, [f.studio, f.foreign]);
      await q(`insert into public.practitioners(id,studio_id,user_id,display_name,email,role,active) values(gen_random_uuid(),$1,$2,'Owner','group-owner@harness.local','owner',true),(gen_random_uuid(),$1,$3,'Member','group-member@harness.local','practitioner',true)`, [f.studio, f.owner, f.member]);
      await q(`insert into public.clients(id,studio_id,name) values($1,$2,'One'),($3,$4,'Other')`, [f.client,f.studio,f.foreignClient,f.foreign]);
      await run(q, f); throw rollback;
    });
  } catch (e) { if (e !== rollback) throw e; }
  expect(await catalog()).toEqual(before);
  expect((await adminQuery("select to_regclass('public.client_groups')::text as groups,to_regclass('public.client_group_memberships')::text as memberships")).rows).toEqual(beforeTables);
}
async function actor(q: UserQuery, user: string) {
  await q("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
  await q("set local role authenticated");
}
async function status(q: UserQuery, sql: string, args: unknown[]) { return (await q(`select ${sql} as result`, args)).rows[0].result.status; }
async function denied(q: UserQuery, sql: string, args: unknown[] = []) {
  await q("savepoint denial"); let code: string | undefined;
  try { await q(sql,args); } catch(e) { code=(e as { code?: string }).code; }
  await q("rollback to savepoint denial"); await q("release savepoint denial"); expect(code).toBe("42501");
}
afterAll(closePool);
describe("client groups proposal: real DB authority and rollback", () => {
  it("owner creates idempotently, normalizes uniqueness, refuses stale and duplicate rename", () => withProposal(async(q,f) => {
    await actor(q,f.owner);
    expect(await status(q,"public.create_client_group($1,$2)",[f.studio," Active "])).toBe("created");
    expect(await status(q,"public.create_client_group($1,$2)",[f.studio,"aCTIVE"])).toBe("exists");
    const g=(await q("select id,name,updated_at::text as updated_at from public.client_groups where studio_id=$1",[f.studio])).rows[0];
    expect(g.name).toBe("Active");
    expect(await status(q,"public.create_client_group($1,$2)",[f.studio,"Paused"])).toBe("created");
    expect(await status(q,"public.rename_client_group($1,$2,$3,$4,$5)",[f.studio,g.id,"Paused",g.name,g.updated_at])).toBe("duplicate");
    expect(await status(q,"public.rename_client_group($1,$2,$3,$4,$5)",[f.studio,g.id,"Follow up",g.name,g.updated_at])).toBe("renamed");
    expect(await status(q,"public.rename_client_group($1,$2,$3,$4,$5)",[f.studio,g.id,"Old draft",g.name,g.updated_at])).toBe("stale");
    for(const name of ["", "a".repeat(61), "A\nB"]) expect(await status(q,"public.create_client_group($1,$2)",[f.studio,name])).toBe("invalid");
  }));
  it("owner-only reads/commands, direct writes and service/anon privilege closure", () => withProposal(async(q,f) => {
    await actor(q,f.owner); await status(q,"public.create_client_group($1,$2)",[f.studio,"Active"]);
    await denied(q,"insert into public.client_groups(studio_id,name) values($1,'Forbidden')",[f.studio]);
    await q("reset role"); await actor(q,f.member);
    expect((await q("select id from public.client_groups")).rows).toHaveLength(0);
    expect(await status(q,"public.create_client_group($1,$2)",[f.studio,"Forbidden"])).toBe("denied");
    await q("reset role"); await actor(q,f.owner);
    expect(await status(q,"public.create_client_group($1,$2)",[f.foreign,"Forbidden"])).toBe("denied");
    for(const role of ["anon","service_role"] as const) {
      await q("reset role"); await q(role === "anon" ? "set local role anon" : "set local role service_role");
      await denied(q,"select public.create_client_group($1,'Forbidden')",[f.studio]);
      await denied(q,"select id from public.client_groups");
      await denied(q,"select client_id from public.client_group_memberships");
    }
  }));
  it("multiple memberships are idempotent, same-studio and survive archive/restore", () => withProposal(async(q,f) => {
    await actor(q,f.owner);
    for(const name of ["Active","Follow up"]) await status(q,"public.create_client_group($1,$2)",[f.studio,name]);
    const groups=(await q("select id from public.client_groups order by name")).rows;
    for(const g of groups) for(let n=0;n<2;n++) expect(await status(q,"public.set_client_group_membership($1,$2,$3,true)",[f.studio,f.client,g.id])).toBe("saved");
    expect((await q("select client_id from public.client_group_memberships")).rows).toHaveLength(2);
    expect(await status(q,"public.set_client_group_membership($1,$2,$3,true)",[f.studio,f.foreignClient,groups[0].id])).toBe("missing");
    await q("reset role");
    await q("update public.clients set archived_at=now() where id=$1",[f.client]);
    expect((await q("select group_id from public.client_group_memberships where client_id=$1",[f.client])).rows).toHaveLength(2);
    await q("update public.clients set archived_at=null where id=$1",[f.client]);
    await actor(q,f.owner);
    for(let n=0;n<2;n++) expect(await status(q,"public.set_client_group_membership($1,$2,$3,false)",[f.studio,f.client,groups[0].id])).toBe("saved");
    expect((await q("select group_id from public.client_group_memberships where client_id=$1",[f.client])).rows).toHaveLength(1);
  }));
  it("enforces the 100-group cap and supports one owner in multiple studios", () => withProposal(async(q,f) => {
    await q(`insert into public.practitioners(id,studio_id,user_id,display_name,email,role,active) values(gen_random_uuid(),$1,$2,'Owner','group-owner@harness.local','owner',true)`,[f.foreign,f.owner]);
    await actor(q,f.owner);
    for(let i=0;i<100;i++) expect(await status(q,"public.create_client_group($1,$2)",[f.studio,`Group ${i}`])).toBe("created");
    expect(await status(q,"public.create_client_group($1,$2)",[f.studio,"Overflow"])).toBe("limit");
    expect(await status(q,"public.create_client_group($1,$2)",[f.foreign,"Active"])).toBe("created");
  }));
});
