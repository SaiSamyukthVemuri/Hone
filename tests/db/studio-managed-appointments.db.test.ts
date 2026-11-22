import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, adminTx, closePool, type UserQuery } from "./helpers/harness";

// Proposal qualification only. DDL and all fixtures roll back on one guarded
// local connection. No numbered migration or hosted apply is assumed.
const proposal = readFileSync(new URL("../../docs/proposals/studio-managed-appointments/UP.sql", import.meta.url), "utf8")
  .replace(/^begin;\n/m, "").replace(/\ncommit;\s*$/, "");
const names = ["create_public_appointment", "create_public_appointment_v2", "create_public_appointment_for_new_client", "create_public_appointment_for_new_client_v2", "create_waitlist_public_appointment", "redeem_and_book_waitlist_invitation", "public_cancel_appointment_with_token", "reschedule_appointment_v3"];
type Fixture = { studio: string; other: string; owner: string; member: string; practitioner: string; client: string; appointment: string; token: string; service: string };

async function catalog() {
  return (await adminQuery(`select p.oid, p.proacl::text, pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1) order by p.oid`, [names])).rows;
}
async function withProposal(run: (q: UserQuery, f: Fixture) => Promise<void>) {
  const before = await catalog();
  const rolledBack = new Error("test transaction rolled back");
  try {
    await adminTx(async q => {
      await q(proposal);
      const f: Fixture = { studio: randomUUID(), other: randomUUID(), owner: randomUUID(), member: randomUUID(), practitioner: randomUUID(), client: randomUUID(), appointment: randomUUID(), token: randomUUID().replaceAll("-", "").repeat(2), service: randomUUID() };
      await q(`insert into auth.users(id,email) values ($1,'owner@harness.local'),($2,'member@harness.local')`, [f.owner, f.member]);
      await q(`insert into public.studios(id,name,owner_email,timezone) values ($1,'Managed fixture','owner@harness.local','UTC'),($2,'Other fixture','other@harness.local','UTC')`, [f.studio, f.other]);
      await q(`insert into public.practitioners(id,studio_id,user_id,display_name,email,role,active) values ($1,$2,$3,'Owner','owner@harness.local','owner',true),(gen_random_uuid(),$2,$4,'Member','member@harness.local','practitioner',true)`, [f.practitioner, f.studio, f.owner, f.member]);
      await q(`insert into public.clients(id,studio_id,name) values ($1,$2,'Fixture client')`, [f.client,f.studio]);
      await q(`insert into public.services(id,studio_id,name,default_duration_minutes,price_cents,active) values ($1,$2,'Consult',30,0,true)`,[f.service,f.studio]);
      await q(`insert into public.appointments(id,studio_id,practitioner_id,client_id,starts_at,ends_at,duration_minutes,status,cancellation_token_hash,buffer_minutes_snapshot,blocked_ends_at) values ($1,$2,$3,$4,now()+interval '3 days',now()+interval '3 days 30 minutes',30,'confirmed',$5,0,now()+interval '3 days 30 minutes')`,[f.appointment,f.studio,f.practitioner,f.client,f.token]);
      await run(q, f);
      throw rolledBack;
    });
  } catch (error) { if (error !== rolledBack) throw error; }
  expect(await catalog()).toEqual(before);
}
async function actor(q: UserQuery, user: string, role = "authenticated") {
  await q(`select set_config('request.jwt.claims',$1,true)`,[JSON.stringify({sub:user,role})]);
  // Test literals only. This helper never interpolates an arbitrary SQL role.
  if(role === "authenticated") await q("set local role authenticated");
  else if(role === "service_role") await q("set local role service_role");
  else await q("set local role anon");
}
async function denied(q: UserQuery, sql: string, params: unknown[] = []) {
  await q("savepoint refusal");
  let error: { code?: string } | undefined;
  try { await q(sql,params); } catch (e) { error=e as {code?:string}; }
  await q("rollback to savepoint refusal");
  await q("release savepoint refusal");
  expect(error?.code).toBe("42501");
}
afterAll(closePool);

describe("studio-managed appointments proposal against the real migrated database",()=>{
  it("defaults off; owner toggles only their mode and restores prior preferences",()=>withProposal(async(q,f)=>{
    const original=(await q(`select client_cancellation_enabled,client_reschedule_enabled,new_client_admission_mode from public.studios where id=$1`,[f.studio])).rows[0];
    expect((await q(`select studio_managed_appointments from public.studios where id=$1`,[f.studio])).rows[0].studio_managed_appointments).toBe(false);
    await q(`insert into public.practitioners(id,studio_id,user_id,display_name,email,role,active) values (gen_random_uuid(),$1,$2,'Second owner','owner@harness.local','owner',true)`,[f.other,f.owner]);
    await actor(q,f.owner);
    expect((await q(`select public.set_studio_managed_appointments($1,true) as enabled`,[f.studio])).rows[0].enabled).toBe(true);
    expect((await q(`select public.set_studio_managed_appointments($1,false) as enabled`,[f.studio])).rows[0].enabled).toBe(false);
    await q("reset role");
    expect((await q(`select client_cancellation_enabled,client_reschedule_enabled,new_client_admission_mode from public.studios where id=$1`,[f.studio])).rows[0]).toEqual(original);
    expect((await q(`select studio_managed_appointments from public.studios where id=$1`,[f.other])).rows[0].studio_managed_appointments).toBe(false);
  }));
  it("non-owners, anonymous and service-role callers cannot change the setting",()=>withProposal(async(q,f)=>{
    for(const [user,role] of [[f.member,"authenticated"],[f.owner,"anon"],[f.owner,"service_role"]]){
      await actor(q,user,role);
      await denied(q,`select public.set_studio_managed_appointments($1,true)`,[f.studio]);
      await q("reset role");
    }
    await actor(q,f.owner);
    await denied(q,`select public.set_studio_managed_appointments($1,true)`,[f.other]);
    await q("reset role");
    expect((await q(`select count(*)::int as n from public.studios where id=any($1) and studio_managed_appointments`,[[f.studio,f.other]])).rows[0].n).toBe(0);
  }));
  it("each public commit command refuses under the studio lock with zero record changes",()=>withProposal(async(q,f)=>{
    await q(`update public.studios set studio_managed_appointments=true where id=$1`,[f.studio]);
    const before=(await q(`select (select count(*) from public.appointments where studio_id=$1) as appointments,(select count(*) from public.clients where studio_id=$1) as clients`,[f.studio])).rows[0];
    const commands=(await q(`select p.proname,p.proargnames,p.proargtypes::oid[] as types from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1) and (p.proname<>'public_cancel_appointment_with_token' or p.pronargs=7)`,[names])).rows;
    expect(commands).toHaveLength(8);
    for(const cmd of commands){
      const types=cmd.types as number[];
      const params=types.map((_,i)=>cmd.proargnames[i]==="p_studio_id"?f.studio:cmd.proargnames[i]==="p_original_appointment_id"?f.appointment:cmd.proargnames[i]==="p_token"?f.token:null);
      const castTypes=(await q(`select format_type(t,null) as type from unnest($1::oid[]) with ordinality as a(t,n) order by n`,[types])).rows;
      const args=castTypes.map((t,i)=>`$${i+1}::${t.type}`).join(",");
      await actor(q,f.owner,"service_role");
      await denied(q,`select * from public.${cmd.proname}(${args})`,params);
      await q("reset role");
    }
    expect((await q(`select (select count(*) from public.appointments where studio_id=$1) as appointments,(select count(*) from public.clients where studio_id=$1) as clients`,[f.studio])).rows[0]).toEqual(before);
    expect((await q(`select status from public.appointments where id=$1`,[f.appointment])).rows[0].status).toBe("confirmed");
  }));
  it("staff can create an internal appointment while client self-service is off",()=>withProposal(async(q,f)=>{
    await q(`update public.studios set studio_managed_appointments=true where id=$1`,[f.studio]);
    await actor(q,f.owner,"service_role");
    const result=await q(`select * from public.create_internal_appointment_v2($1,$2,$2,$3,$4,(now()+interval '4 days')::timestamptz,$5,null,null,true)`,[f.studio,f.practitioner,f.client,f.service,randomUUID().replaceAll("-", "").repeat(2)]);
    expect(result.rows[0].result).toBe("created");
  }));
  it("managed mode off reaches the existing public command's validation",()=>withProposal(async(q,f)=>{
    await actor(q,f.owner,"service_role");
    const result=await q(`select * from public.create_public_appointment($1,null,null,null,null,null,null)`,[f.studio]);
    expect(result.rows[0].result).not.toBe("created");
  }));
});
