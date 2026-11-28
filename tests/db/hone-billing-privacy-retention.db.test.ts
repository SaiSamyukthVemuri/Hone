import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertMayMutateFrontDeskRollout } from "./helpers/rollout-mutation-guard";
import { adminQuery, closePool, userQuery } from "./helpers/harness";

beforeAll(async () => {
  await assertMayMutateFrontDeskRollout();
  await adminQuery("update public.platform_rollouts set mode='pilot' where key='front_desk'");
});
afterAll(async () => {
  await adminQuery("update public.platform_rollouts set mode='off' where key='front_desk'");
  // The guard proved the stack started with nobody listed, so everything listed now is this suite's.
  await adminQuery("delete from public.platform_rollout_studios where rollout_key='front_desk'");
  await closePool();
});

async function authUser() {
  const id = randomUUID();
  await adminQuery("insert into auth.users(id,email,email_confirmed_at) values ($1,$2,now())", [id, id + "@example.test"]);
  return id;
}

async function attempt(plan = "solo") {
  const user = await authUser();
  const id = (await adminQuery("select public.claim_hone_signup($1,$2,'Retention test','Owner') as r", [user, plan])).rows[0].r.id;
  return { user, id: id as string };
}

async function paidStudio(plan = "studio") {
  const a = await attempt(plan);
  const result = await adminQuery(
    "select public.apply_hone_billing_invoice($1,$2,$3,$4,$5,$6,$7,'initial_paid',now()) as r",
    ["evt_" + a.user, a.id, a.user, plan, "cus_" + a.user, "sub_" + a.user, "in_" + a.user],
  );
  expect(result.rows[0].r).toBe("provisioned");
  const studio = (await adminQuery("select studio_id from public.hone_signup_attempts where id=$1", [a.id])).rows[0].studio_id as string;
  return { ...a, studio };
}

const exists = async (id: string) =>
  (await adminQuery("select 1 from public.hone_signup_attempts where id=$1", [id])).rowCount === 1;
const age = (id: string, days: number) =>
  adminQuery("update public.hone_signup_attempts set last_activity_at=now()-make_interval(days=>$2) where id=$1", [id, days]);
const purge = async (days = 30) =>
  (await adminQuery("select public.purge_abandoned_hone_signups($1) as n", [days])).rows[0].n as number;

describe("billing status carries no raw provider id", () => {
  it("returns neither the Stripe customer nor the subscription to the signed-in owner", async () => {
    const t = await paidStudio();
    const status = (await userQuery(t.user, "select public.my_hone_billing_status($1) as b", [t.studio])).rows[0].b;
    expect(status).toMatchObject({ plan: "studio", status: "active" });
    expect(Object.keys(status)).not.toContain("customer");
    expect(Object.keys(status)).not.toContain("subscription");
    expect(Object.keys(status)).not.toContain("invoice");
    expect(JSON.stringify(status)).not.toMatch(/cus_|sub_/);
  });

  it("gives the ids only to the server, and only for the verified active owner of that studio", async () => {
    const t = await paidStudio();
    const other = await paidStudio();
    const ids = (p: string, u: string | null) =>
      adminQuery("select public.read_hone_billing_provider_ids($1,$2) as ids", [p, u]);
    expect((await ids(t.studio, t.user)).rows[0].ids).toEqual({ customer: "cus_" + t.user, subscription: "sub_" + t.user, invoice: null });
    expect((await ids(t.studio, other.user)).rows[0].ids).toBeNull();
    expect((await ids(t.studio, null)).rows[0].ids).toBeNull();
    expect((await ids(t.studio, await authUser())).rows[0].ids).toBeNull();
    await adminQuery("update public.practitioners set active=false where studio_id=$1 and user_id=$2", [t.studio, t.user]);
    expect((await ids(t.studio, t.user)).rows[0].ids).toBeNull();
    await expect(userQuery(t.user, "select public.read_hone_billing_provider_ids($1,$2)", [t.studio, t.user])).rejects.toMatchObject({ code: "42501" });
  });
});

describe("grants and definer settings, by function name", () => {
  const callable = [
    "my_hone_billing_status(uuid)",
    "my_hone_solo_impact(uuid)",
    "my_hone_team_seats(uuid)",
    "request_hone_subscription_change(uuid,text,uuid,text)",
  ];
  const serverOnly = [
    "read_hone_billing_provider_ids(uuid,uuid)",
    "purge_abandoned_hone_signups(integer)",
    "hone_sync_included_desk(uuid,text)",
    "check_hone_new_work_allowed()",
  ];
  const facts = async (signature: string) =>
    (await adminQuery(
      `select p.prosecdef as definer,
         coalesce(p.proconfig::text,'') as config,
         has_function_privilege('anon', p.oid, 'execute') as anon,
         has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
         has_function_privilege('service_role', p.oid, 'execute') as service_role,
         (select count(*)::int from aclexplode(p.proacl) a where a.grantee = 0) as public_grants
       from pg_proc p where p.oid = ('public.' || $1)::regprocedure`,
      [signature],
    )).rows[0];

  it.each(callable)("%s is SECURITY DEFINER, search_path pinned, authenticated only", async (signature) => {
    expect(await facts(signature)).toEqual({
      definer: true, config: expect.stringContaining("search_path"), anon: false, authenticated: true, service_role: false, public_grants: 0,
    });
  });

  it.each(serverOnly)("%s is SECURITY DEFINER, search_path pinned, no client role", async (signature) => {
    const f = await facts(signature);
    expect(f).toMatchObject({ definer: true, anon: false, authenticated: false, public_grants: 0 });
    expect(f.config).toContain("search_path");
  });

  it("the two server commands reach only service_role", async () => {
    expect((await facts("read_hone_billing_provider_ids(uuid,uuid)")).service_role).toBe(true);
    expect((await facts("purge_abandoned_hone_signups(integer)")).service_role).toBe(true);
  });
});

describe("abandoned signup retention", () => {
  it("deletes only never-paid attempts idle for 30 days and keeps everything Stripe or a studio needs", async () => {
    const stale = await attempt();
    const staleExpired = await attempt();
    await adminQuery("update public.hone_signup_attempts set state='expired' where id=$1", [staleExpired.id]);
    const recent = await attempt();
    const sessionYoung = await attempt();
    const sessionOld = await attempt();
    const withCustomer = await attempt();
    const withInvoice = await attempt();
    const paid = await paidStudio();
    await adminQuery("update public.hone_signup_attempts set session_id=$2 where id=$1", [sessionYoung.id, 'cs_' + randomUUID()]);
    await adminQuery("update public.hone_signup_attempts set session_id=$2 where id=$1", [sessionOld.id, 'cs_' + randomUUID()]);
    await adminQuery("update public.hone_signup_attempts set customer_id=$2 where id=$1", [withCustomer.id, 'cus_' + randomUUID()]);
    await adminQuery("insert into public.hone_renewal_invoices(invoice_id,attempt_id,failed_at) values ($2,$1,now())", [withInvoice.id, 'in_' + randomUUID()]);
    await age(stale.id, 31); await age(staleExpired.id, 31); await age(recent.id, 10);
    await age(sessionYoung.id, 40); await age(sessionOld.id, 100);
    await age(withCustomer.id, 400); await age(withInvoice.id, 400); await age(paid.id, 400);

    expect(await purge()).toBeGreaterThanOrEqual(3);
    expect(await exists(stale.id)).toBe(false);
    expect(await exists(staleExpired.id)).toBe(false);
    expect(await exists(sessionOld.id)).toBe(false);
    for (const kept of [recent, sessionYoung, withCustomer, withInvoice, paid]) expect(await exists(kept.id)).toBe(true);
    // The paid studio, its owner and the sign-in accounts (including the deleted attempts') all remain.
    expect((await adminQuery("select 1 from public.studios where id=$1", [paid.studio])).rowCount).toBe(1);
    expect((await adminQuery("select 1 from public.practitioners where studio_id=$1 and user_id=$2 and role='owner' and active", [paid.studio, paid.user])).rowCount).toBe(1);
    expect((await adminQuery("select 1 from auth.users where id = any($1)", [[stale.user, staleExpired.user, sessionOld.user]])).rowCount).toBe(3);
    expect(await purge()).toBe(0);
  });

  it("restarts the clock on a signup that is still being used", async () => {
    const a = await attempt();
    await age(a.id, 29);
    await adminQuery("select public.claim_hone_signup($1,'solo','Retention test','Owner')", [a.user]);
    await purge();
    expect(await exists(a.id)).toBe(true);
    expect((await adminQuery("select last_activity_at > now()-interval '1 minute' as fresh from public.hone_signup_attempts where id=$1", [a.id])).rows[0].fresh).toBe(true);
  });

  it("refuses a retention window under seven days and any client role", async () => {
    await expect(purge(6)).rejects.toThrow("invalid_retention_days");
    const user = await authUser();
    await expect(userQuery(user, "select public.purge_abandoned_hone_signups(30)")).rejects.toMatchObject({ code: "42501" });
  });

  it("erases the pending records with the studio or the owner", async () => {
    const byStudio = await paidStudio();
    await adminQuery("insert into public.hone_renewal_invoices(invoice_id,attempt_id,failed_at) values ($1,$2,now())", ["in_" + randomUUID(), byStudio.id]);
    await adminQuery("delete from public.practitioners where studio_id=$1", [byStudio.studio]);
    await adminQuery("delete from public.studios where id=$1", [byStudio.studio]);
    expect(await exists(byStudio.id)).toBe(false);
    expect((await adminQuery("select 1 from public.hone_renewal_invoices where attempt_id=$1", [byStudio.id])).rowCount).toBe(0);
    expect((await adminQuery("select 1 from public.hone_subscription_notices where attempt_id=$1", [byStudio.id])).rowCount).toBe(0);

    const byOwner = await attempt();
    await adminQuery("delete from auth.users where id=$1", [byOwner.user]);
    expect(await exists(byOwner.id)).toBe(false);
  });
});

describe("the plan's receptionist seat is audited, never over-removed, and race-free", () => {
  const enrol = (studio: string) =>
    adminQuery("insert into public.platform_rollout_studios(rollout_key,studio_id) values ('front_desk',$1) on conflict do nothing", [studio]);
  const setPlan = (studio: string, plan: string) =>
    adminQuery("update public.hone_signup_attempts set plan=$2 where studio_id=$1", [studio, plan]);
  const events = async (studio: string) =>
    (await adminQuery("select action,actor_email,metadata from public.admin_action_events where studio_id=$1 and actor_email='hone-billing' order by created_at,id", [studio])).rows;

  it("audits every grant and withdrawal with ids and counts only", async () => {
    const t = await paidStudio("studio");
    await setPlan(t.studio, "solo");
    await setPlan(t.studio, "studio");
    const rows = await events(t.studio);
    expect(rows.map((r) => r.action).sort()).toEqual([
      "front_desk_seats_granted", "front_desk_seats_granted", "front_desk_seats_withdrawn",
    ]);
    expect(rows.every((r) => r.actor_email === "hone-billing")).toBe(true);
    expect(JSON.stringify(rows.map((r) => r.metadata))).not.toMatch(/@/);
  });

  it("never enrols a studio on its own, so 'pilot' reaches only the studios an operator listed", async () => {
    const pilot = (await adminQuery("insert into public.studios(name,owner_email,slug) values ('Pilot','p@example.test',$1) returning id", [randomUUID()])).rows[0].id;
    await adminQuery("insert into public.platform_rollout_studios(rollout_key,studio_id) values ('front_desk',$1)", [pilot]);
    const studio = await paidStudio("studio");
    const solo = await paidStudio("solo");
    const on = async (id: string) => (await adminQuery("select public.platform_rollout_enabled_for('front_desk',$1) as e, public.front_desk_seat_limit($1) as n", [id])).rows[0];
    expect(await on(pilot)).toMatchObject({ e: true });
    expect(await on(studio.studio)).toMatchObject({ e: false });
    expect(await on(solo.studio)).toMatchObject({ e: false });
    // The plan's grant exists, but it has no effect until an operator lists the studio.
    expect((await adminQuery("select 1 from public.studio_front_desk_seats where studio_id=$1 and source='plan_included'", [studio.studio])).rowCount).toBe(1);
    expect((await adminQuery("select 1 from public.studio_front_desk_seats where studio_id=$1", [solo.studio])).rowCount).toBe(0);
    await adminQuery("insert into public.platform_rollout_studios(rollout_key,studio_id) values ('front_desk',$1)", [studio.studio]);
    expect(await on(studio.studio)).toMatchObject({ e: true, n: 1 });
    await adminQuery("insert into public.platform_rollout_studios(rollout_key,studio_id) values ('front_desk',$1)", [solo.studio]);
    expect(await on(solo.studio)).toMatchObject({ e: true, n: 0 });
  });

  it("keeps a custom grant through Studio to Solo, and removes only the plan's own seat", async () => {
    const t = await paidStudio("studio");
    await enrol(t.studio);
    await adminQuery(
      "insert into public.studio_front_desk_seats(studio_id,seats,source,reason,granted_by_admin) values ($1,2,'custom_agreed','agreed outside the plan','ops@example.test')",
      [t.studio],
    );
    await setPlan(t.studio, "solo");
    const grants = (await adminQuery("select source,revoked_at is not null as revoked from public.studio_front_desk_seats where studio_id=$1 order by source", [t.studio])).rows;
    expect(grants).toEqual([{ source: "custom_agreed", revoked: false }, { source: "plan_included", revoked: true }]);
    expect((await adminQuery("select public.front_desk_seat_limit($1) as n", [t.studio])).rows[0].n).toBe(2);
  });

  it("never removes the enrolment on its own: Solo leaves a zero limit that seats nobody", async () => {
    const t = await paidStudio("studio");
    await enrol(t.studio);
    await setPlan(t.studio, "solo");
    expect((await adminQuery("select 1 from public.platform_rollout_studios where rollout_key='front_desk' and studio_id=$1", [t.studio])).rowCount).toBe(1);
    expect((await adminQuery("select public.front_desk_seat_limit($1) as n", [t.studio])).rows[0].n).toBe(0);
  });

  it("runs invitations and plan changes concurrently without a deadlock", async () => {
    for (let round = 0; round < 6; round++) {
      const t = await paidStudio("studio");
      await enrol(t.studio);
      const owner = (await adminQuery("select id from public.practitioners where studio_id=$1 and user_id=$2", [t.studio, t.user])).rows[0].id;
      const results = await Promise.allSettled([
        userQuery(t.user, "insert into public.pending_invitations(studio_id,invited_by,email,role) values ($1,$2,$3,'receptionist')", [t.studio, owner, randomUUID() + "@example.test"]),
        setPlan(t.studio, "solo"),
        userQuery(t.user, "insert into public.pending_invitations(studio_id,invited_by,email,role) values ($1,$2,$3,'practitioner')", [t.studio, owner, randomUUID() + "@example.test"]),
        setPlan(t.studio, "studio"),
      ]);
      for (const r of results) if (r.status === "rejected") expect((r.reason as { code?: string }).code).not.toBe("40P01");
    }
  });
});
