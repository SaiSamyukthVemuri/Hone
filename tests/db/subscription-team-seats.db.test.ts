import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertMayMutateFrontDeskRollout } from "./helpers/rollout-mutation-guard";
import { adminQuery, adminTx, closePool, userQuery } from "./helpers/harness";
import { PLANS, type PlanKey } from "@/lib/subscriptions/plans";
import type { InvitationRole } from "@/lib/types/database";

// 0390 owns receptionist seats: a studio's receptionists are allowed only while the Front Desk switch is on
// for it and a seat grant covers them. The plan writes its own grant (Studio: 1, Solo: none); the platform
// mode is switched to 'pilot' here only so those per-studio switches take effect, and restored afterwards.
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

const email = () => randomUUID() + "@example.test";

async function authUser(address = email()) {
  const id = randomUUID();
  await adminQuery(
    "insert into auth.users(id,email,email_confirmed_at) values ($1,$2,now())",
    [id, address],
  );
  return id;
}

async function signup(plan: PlanKey) {
  const owner = await authUser();
  const attempt = (
    await adminQuery(
      "select public.claim_hone_signup($1,$2,'Seat test','Owner') as result",
      [owner, plan],
    )
  ).rows[0].result.id;
  const result = await adminQuery(
    "select public.apply_hone_billing_invoice($1,$2,$3,$4,$5,$6,$7,'initial_paid',now()) as result",
    [
      "evt_" + owner,
      attempt,
      owner,
      plan,
      "cus_" + owner,
      "sub_" + owner,
      "in_" + owner,
    ],
  );
  expect(result.rows[0].result).toBe("provisioned");
  const member = (
    await adminQuery(
      "select id,studio_id from public.practitioners where user_id=$1",
      [owner],
    )
  ).rows[0];
  // An operator lists the studio with 0362's own command; billing never does (see 0387).
  if (plan === "studio") {
    await adminQuery(
      "insert into public.platform_rollout_studios(rollout_key,studio_id) values ('front_desk',$1) on conflict do nothing",
      [member.studio_id],
    );
  }
  return {
    owner,
    practitioner: member.id as string,
    studio: member.studio_id as string,
  };
}

type Team = Awaited<ReturnType<typeof signup>>;
const usage = async (team: Team, actor = team.owner) =>
  (
    await userQuery(actor, "select public.my_hone_team_seats($1) as seats", [
      team.studio,
    ])
  ).rows[0].seats;

async function invite(team: Team, role: InvitationRole, address = email()) {
  await userQuery(
    team.owner,
    "insert into public.pending_invitations(studio_id, invited_by, email, role) values ($1,$2,$3,$4)",
    [team.studio, team.practitioner, address, role],
  );
  return address;
}

const accept = async (id: string) =>
  (
    await adminQuery(
      "select public.admin_accept_pending_invitation($1) as result",
      [id],
    )
  ).rows[0].result;
const cancel = (team: Team, address: string) =>
  userQuery(
    team.owner,
    "update public.pending_invitations set status='revoked' where studio_id=$1 and email=$2",
    [team.studio, address],
  );

describe("subscription team limits through the owner invite and acceptance paths", () => {
  it.each(["solo", "studio"] as const)(
    "provisions the %s owner and exposes usage only to the owner",
    async (plan) => {
      const t = await signup(plan);
      expect(await usage(t)).toEqual({
        plan,
        practitioner_used: 1,
        practitioner_limit: PLANS[plan].practitionerLimit,
        receptionist_used: 0,
        receptionist_limit: PLANS[plan].receptionistLimit,
      });
      expect(await usage(t, await authUser())).toBeNull();
    },
  );

  it("Solo refuses other practitioners, owners and receptionists at both invitation and membership creation", async () => {
    const t = await signup("solo");
    for (const role of ["practitioner", "owner"] as const) {
      await expect(invite(t, role)).rejects.toMatchObject({ code: "HN001" });
      await expect(
        adminQuery(
          "insert into public.practitioners(studio_id,display_name,role,email) values ($1,'New member',$2,$3)",
          [t.studio, role, email()],
        ),
      ).rejects.toMatchObject({ code: "HN001" });
    }
    await expect(invite(t, "receptionist")).rejects.toMatchObject({
      message: "front_desk_not_enabled",
    });
    await expect(
      adminQuery(
        "insert into public.studio_receptionists(studio_id,display_name) values ($1,'Front desk')",
        [t.studio],
      ),
    ).rejects.toMatchObject({ message: "front_desk_not_enabled" });
    expect((await usage(t)).practitioner_used).toBe(1);
  });

  it("permits three practitioners plus one receptionist and converts pending reservations exactly once", async () => {
    const t = await signup("studio");
    const people = await Promise.all([
      invite(t, "practitioner"),
      invite(t, "owner"),
      invite(t, "receptionist"),
    ]);
    await expect(invite(t, "practitioner")).rejects.toMatchObject({
      code: "HN001",
    });
    await expect(invite(t, "receptionist")).rejects.toMatchObject({
      message: "front_desk_seat_limit_reached",
    });
    const ids = await Promise.all(people.map(authUser));
    for (const id of ids) await accept(id);
    await accept(ids[2]);
    expect(await usage(t)).toMatchObject({
      practitioner_used: 3,
      receptionist_used: 1,
    });
    expect(
      (
        await adminQuery(
          "select count(*)::int n from public.pending_invitations where studio_id=$1 and status='accepted'",
          [t.studio],
        )
      ).rows[0].n,
    ).toBe(3);
    expect(
      (
        await adminQuery(
          "select count(*)::int n from public.practitioners where user_id=$1",
          [ids[2]],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it.each(["practitioner", "receptionist"] as const)(
    "gives the final %s seat to exactly one concurrent invite and returns it on cancellation",
    async (role) => {
      const t = await signup("studio");
      if (role === "practitioner") await invite(t, role);
      const results = await Promise.allSettled([
        invite(t, role),
        invite(t, role),
      ]);
      const won = results.filter((r) => r.status === "fulfilled");
      expect(won).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: role === "practitioner" ? { code: "HN001" } : { message: "front_desk_seat_limit_reached" },
      });
      await cancel(t, won[0].value);
      await invite(t, role);
    },
  );

  it.each([
    // A receptionist seat is 0390's: one advisory lock serializes the claim, and the loser is refused.
    ["receptionist", "read committed", "front_desk_seat_limit_reached"],
    // A clinical seat is 0388's: a stale snapshot that raced a writer is refused by serialization failure.
    ["practitioner", "repeatable read", "40001"],
  ] as const)("serializes two %s transactions racing for the same last seat (%s)", async (role, isolation, refusal) => {
    const t = await signup("studio");
    if (role === "practitioner") await invite(t, "practitioner");
    let arrived = 0;
    let release!: () => void;
    const bothReady = new Promise<void>((r) => {
      release = r;
    });
    const contender = () =>
      adminTx(async (query) => {
        await query(`set transaction isolation level ${isolation}`);
        await query("select * from public.hone_team_seat_counts($1)", [t.studio]);
        if (++arrived === 2) release();
        await bothReady;
        await query(
          "insert into public.pending_invitations(studio_id,email,role) values($1,$2,$3)",
          [t.studio, email(), role],
        );
      });
    const results = await Promise.allSettled([contender(), contender()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refusal === "40001" ? loser.reason.code : loser.reason.message).toBe(refusal);
    expect(await usage(t)).toMatchObject(role === "receptionist" ? { receptionist_used: 1 } : { practitioner_used: 3 });
  });

  it("releases a removed receptionist's seat and refuses reactivation if a replacement was invited", async () => {
    const t = await signup("studio");
    const account = await authUser(await invite(t, "receptionist"));
    await accept(account);
    const desk = (
      await adminQuery(
        "select id from public.studio_receptionists where user_id=$1",
        [account],
      )
    ).rows[0].id;
    const setActive = (active: boolean) =>
      adminQuery(
        "select public.set_studio_receptionist_active($1,$2,$3,$4) as result",
        [t.studio, t.practitioner, desk, active],
      );
    expect((await setActive(false)).rows[0].result).toBe("updated");
    const replacement = await invite(t, "receptionist");
    expect((await setActive(true)).rows[0].result).toBe("seat_limit");
    await cancel(t, replacement);
    expect((await setActive(true)).rows[0].result).toBe("updated");
  });

  it("checks practitioner reactivation and changes to pending roles", async () => {
    const t = await signup("studio");
    const account = await authUser(await invite(t, "practitioner"));
    await accept(account);
    await adminQuery(
      "update public.practitioners set active=false where user_id=$1",
      [account],
    );
    const replacement = await invite(t, "practitioner");
    await invite(t, "owner");
    await invite(t, "receptionist");
    await expect(
      adminQuery(
        "update public.practitioners set active=true where user_id=$1",
        [account],
      ),
    ).rejects.toMatchObject({ code: "HN001" });
    await expect(
      userQuery(
        t.owner,
        "update public.pending_invitations set role='receptionist' where email=$1",
        [replacement],
      ),
    ).rejects.toMatchObject({ message: "front_desk_seat_limit_reached" });
    await cancel(t, replacement);
    await adminQuery(
      "update public.practitioners set active=true where user_id=$1",
      [account],
    );
    expect(await usage(t)).toMatchObject({
      practitioner_used: 3,
      receptionist_used: 1,
    });
  });

  it("protects direct plan writes unless the resulting team fits", async () => {
    const t = await signup("studio");
    const clinical = await invite(t, "practitioner");
    const desk = await invite(t, "receptionist");
    const setPlan = (plan: PlanKey) =>
      adminQuery(
        "update public.hone_signup_attempts set plan=$2 where studio_id=$1",
        [t.studio, plan],
      );
    await expect(setPlan("solo")).rejects.toMatchObject({ code: "HN001" });
    await cancel(t, clinical);
    await cancel(t, desk);
    // The plan decides the receptionist right even for a direct write: Solo withdraws the grant.
    await setPlan("solo");
    expect(await usage(t)).toMatchObject({ plan: "solo", receptionist_limit: 0 });
    // Billing never removes the enrolment, so a studio that held the seat now has a limit of zero.
    await expect(invite(t, "receptionist")).rejects.toMatchObject({
      message: "front_desk_seat_limit_reached",
    });
    await setPlan("studio");
    expect(await usage(t)).toMatchObject({ plan: "studio", receptionist_limit: 1 });
    await invite(t, "receptionist");
  });

  it("leaves existing pilot teams independent of a paid studio's seats", async () => {
    const t = await signup("studio");
    await invite(t, "receptionist");
    const pilot = (
      await adminQuery(
        "insert into public.studios(name,owner_email,slug) values ('Pilot',$1,$2) returning id",
        [email(), randomUUID()],
      )
    ).rows[0].id;
    expect(
      (
        await adminQuery("select * from public.hone_team_seat_counts($1)", [
          pilot,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(await usage(t)).toMatchObject({
      practitioner_used: 1,
      receptionist_used: 1,
    });
  });
});

async function requestChange(t: Team, target: string, version: string | null = null, actor = t.owner) {
  const impact = target === "solo"
    ? (await userQuery(actor, "select public.my_hone_solo_impact($1) as impact", [t.studio])).rows[0].impact
    : null;
  return (await userQuery(actor, "select public.request_hone_subscription_change($1,$2,$3,$4) as decision",
    [t.studio, target, version, impact?.version ?? null])).rows[0].decision;
}
const settle = async (id: string) =>
  (await adminQuery("select public.finish_hone_subscription_change($1,true) as applied", [id])).rows[0].applied;
const billingState = async (t: Team) =>
  (await userQuery(t.owner, "select public.my_hone_billing_status($1) as billing", [t.studio])).rows[0].billing;

it("switches tiers once and reserves the lower limits while Stripe confirms a downgrade", async () => {
  const t = await signup("solo");
  expect(await requestChange(t, "studio", null, await authUser())).toBeNull();
  const up = await requestChange(t, "studio");
  expect(up.result).toBe("pending");
  expect(await requestChange(t, "studio")).toEqual(up);
  expect(await settle(up.id)).toBe(true);
  expect(await settle(up.id)).toBe(false);
  expect(await usage(t)).toMatchObject({ plan: "studio", receptionist_limit: 1 });
  // The upgrade writes the plan's seat but does not list the studio: Front Desk stays off until an operator does.
  await expect(invite(t, "receptionist")).rejects.toThrow("front_desk_not_enabled");
  await adminQuery("insert into public.platform_rollout_studios(rollout_key,studio_id) values ('front_desk',$1)", [t.studio]);
  const recipient = await invite(t, "receptionist");
  expect((await requestChange(t, "solo")).result).toBe("stale");
  const down = await requestChange(t, "solo", up.id);
  expect(down.result).toBe("pending");
  await expect(invite(t, "practitioner")).rejects.toMatchObject({ code: "HN001" });
  expect(await settle(down.id)).toBe(true);
  expect(await usage(t)).toMatchObject({ plan: "solo", receptionist_limit: 0 });
  expect((await adminQuery("select status from public.pending_invitations where email=$1",[recipient])).rows[0].status).toBe("revoked");
});

it("locks only new bookings and new unscheduled sessions once cancellation takes effect, never on a pending cancel", async () => {
  const t = await signup("studio");
  const staff = await authUser(await invite(t, "practitioner"));
  await accept(staff);
  const desk = await authUser(await invite(t, "receptionist"));
  await accept(desk);
  const client = (await adminQuery("insert into public.clients(studio_id,name) values($1,'Example') returning id", [t.studio])).rows[0].id;
  const chart = (appointment: string | null = null) => adminQuery("insert into public.sessions(studio_id,client_id,practitioner_id,modality,appointment_id) values($1,$2,$3,'electrolysis',$4) returning id", [t.studio,client,t.practitioner,appointment]);
  let hour = 24;
  const book = () => adminQuery("insert into public.appointments(studio_id,client_id,practitioner_id,starts_at,ends_at,duration_minutes) values ($1,$2,$3,now()+make_interval(hours=>$4),now()+make_interval(hours=>$4,mins=>15),15) returning id", [t.studio,client,t.practitioner,hour += 2]);
  const entry = (session: string) => adminQuery("insert into public.electrolysis_entries(session_id,area) values ($1,'chin')", [session]);
  const existingBooking = (await book()).rows[0].id;
  const existingChart = (await chart()).rows[0].id;
  const canceled = async (actor: string) => (await userQuery(actor, "select public.my_hone_studio_canceled($1) as paused", [t.studio])).rows[0].paused;

  // A PENDING cancellation is visible to the owner only and locks nothing.
  const change = await requestChange(t, "cancel");
  expect((await billingState(t)).status).toBe("canceling");
  for (const actor of [t.owner, staff, desk]) expect(await canceled(actor)).toBe(false);
  expect(await requestChange(t,"cancel",null,staff)).toBeNull();
  await book(); await chart(); await entry(existingChart);

  const claim = (await adminQuery("select public.claim_hone_subscription_change($1) as job", [change.id])).rows[0].job;
  expect(claim.target).toBe("cancel");
  // Cancellation takes effect.
  await adminQuery("select public.record_hone_subscription_canceled($1,$2,$3,$4)", [claim.subscription,claim.customer,claim.attempt,t.owner]);
  await adminQuery("select public.apply_hone_billing_invoice($1,$2,$3,'studio',$4,$5,$6,'renewal_paid',now())",
    [randomUUID(),claim.attempt,t.owner,claim.customer,claim.subscription,randomUUID()]);
  expect((await billingState(t)).status).toBe("canceled");
  expect((await requestChange(t,"studio",change.id)).result).toBe("canceled");
  // Staff see the operational status only once it is effective: the studio's receptionist and
  // practitioner get true; a deactivated member, another studio's member and a no-studio user get false.
  for (const actor of [t.owner, staff, desk]) expect(await canceled(actor)).toBe(true);
  await adminQuery("update public.studio_receptionists set active=false,deactivated_at=now() where studio_id=$1 and user_id=$2", [t.studio, desk]);
  expect(await canceled(desk)).toBe(false);
  expect(await canceled((await signup("studio")).owner)).toBe(false);
  expect(await canceled(await authUser())).toBe(false);
  // Only a new booking and a new session with no earlier appointment are refused.
  await expect(book()).rejects.toThrow("subscription_canceled");
  await expect(chart()).rejects.toThrow("subscription_canceled");
  // Care already begun can always be documented: an existing session takes a new entry, a session for an
  // appointment that existed before the lock is allowed, and everything stays readable.
  await entry(existingChart);
  await adminQuery("insert into public.session_blocks(studio_id,session_id) values ($1,$2)", [t.studio, existingChart]);
  await adminQuery("insert into public.laser_entries(session_id,zone) values ($1,'chin')", [existingChart]);
  await chart(existingBooking);
  expect((await adminQuery("select id from public.sessions where id=$1", [existingChart])).rowCount).toBe(1);
  expect((await billingState(await signup("studio"))).status).toBe("active");
});

it("applies the same narrow lock at the seven-day non-payment deadline and lifts it on payment", async () => {
  const t = await signup("studio");
  const client = (await adminQuery("insert into public.clients(studio_id,name) values($1,'Example') returning id", [t.studio])).rows[0].id;
  let hour = 24;
  const book = () => adminQuery("insert into public.appointments(studio_id,client_id,practitioner_id,starts_at,ends_at,duration_minutes) values ($1,$2,$3,now()+make_interval(hours=>$4),now()+make_interval(hours=>$4,mins=>15),15) returning id", [t.studio,client,t.practitioner,hour += 2]);
  const chart = (appointment: string | null = null) => adminQuery("insert into public.sessions(studio_id,client_id,practitioner_id,modality,appointment_id) values($1,$2,$3,'electrolysis',$4) returning id", [t.studio,client,t.practitioner,appointment]);
  const existing = (await book()).rows[0].id;
  await adminQuery("update public.appointments set created_at=now()-interval '10 days' where id=$1", [existing]);
  const attempt = (await adminQuery("select id from public.hone_signup_attempts where studio_id=$1", [t.studio])).rows[0].id;
  const invoice = "in_late_" + randomUUID();
  await adminQuery("insert into public.hone_renewal_invoices(invoice_id,attempt_id,failed_at) values ($2,$1,now()-interval '6 days')", [attempt, invoice]);
  await book(); await chart();
  await adminQuery("update public.hone_renewal_invoices set failed_at=now()-interval '8 days' where invoice_id=$1", [invoice]);
  await expect(book()).rejects.toThrow("subscription_payment_required");
  await expect(chart()).rejects.toThrow("subscription_payment_required");
  await chart(existing);
  await adminQuery("update public.hone_renewal_invoices set paid=true,settled_at=now() where invoice_id=$1", [invoice]);
  await book(); await chart();
});

it("automatically retains the subscribing owner, deactivates staff only here, and keeps appointments and charts attributed", async () => {
  const t = await signup("studio");
  const staff = await authUser(await invite(t, "practitioner"));
  const desk = await authUser(await invite(t, "receptionist"));
  await accept(staff); await accept(desk);
  const pending = await invite(t,"owner");
  const other = await signup("studio");
  const staffRows = await adminQuery("select id,email from public.practitioners where studio_id=$1 and user_id=$2",[t.studio,staff]);
  const original = staffRows.rows[0].id;
  await invite(other,"practitioner",staffRows.rows[0].email);
  await accept(staff);
  const authorized = async (team: Team, actor: string) =>
    (await userQuery(actor,"select public.is_studio_member($1) as active",[team.studio])).rows[0].active;
  const deskAccess = async () =>
    (await adminQuery("select active,deactivated_at from public.studio_receptionists where studio_id=$1 and user_id=$2",[t.studio,desk])).rows[0];
  const teamImpact = async (actor: string) =>
    (await userQuery(actor,"select public.my_hone_solo_impact($1) as impact",[t.studio])).rows[0].impact;

  expect(await teamImpact(staff)).toBeNull();
  expect(await teamImpact((await authUser()))).toBeNull();
  expect(await teamImpact(t.owner)).toMatchObject({owner:"Owner",can_confirm:true,invitations:[pending]});
  expect((await teamImpact(t.owner)).members.map((m:{role:string})=>m.role).sort()).toEqual(["practitioner","receptionist"]);
  const client = (await adminQuery("insert into public.clients(studio_id,name) values($1,'Synthetic') returning id",[t.studio])).rows[0].id;
  const chart = (await adminQuery("insert into public.sessions(studio_id,client_id,practitioner_id,modality) values($1,$2,$3,'electrolysis') returning id",[t.studio,client,original])).rows[0].id;
  const booking = (await adminQuery("insert into public.appointments(studio_id,client_id,practitioner_id,starts_at,ends_at,duration_minutes) values ($1,$2,$3,now()+interval '1 day',now()+interval '1 day 15 min',15) returning id",[t.studio,client,original])).rows[0].id;

  const first = await requestChange(t,"solo");
  expect(first.result).toBe("pending");
  await adminQuery("select public.finish_hone_subscription_change($1,false)", [first.id]);
  expect(await authorized(t,staff)).toBe(true);
  expect((await deskAccess()).active).toBe(true);
  expect((await teamImpact(t.owner)).invitations).toEqual([pending]);

  const confirmed = await requestChange(t,"solo",first.id);
  const completions = await Promise.all([settle(confirmed.id),settle(confirmed.id)]);
  expect(completions.sort()).toEqual([false,true]);
  expect(await usage(t)).toEqual({plan:"solo",practitioner_used:1,practitioner_limit:1,receptionist_used:0,receptionist_limit:0});
  expect(await authorized(t,t.owner)).toBe(true);
  expect(await authorized(t,staff)).toBe(false);
  expect(await authorized(other,staff)).toBe(true);
  expect(await deskAccess()).toMatchObject({active:false,deactivated_at:expect.any(Date)});
  expect((await adminQuery("select status from public.pending_invitations where studio_id=$1 and email=$2",[t.studio,pending])).rows[0].status).toBe("revoked");
  const invited = await authUser(pending);
  await accept(invited);
  expect(await authorized(t,invited)).toBe(false);
  const history = await adminQuery("select practitioner_id from public.sessions where id=$1 union all select practitioner_id from public.appointments where id=$2",[chart,booking]);
  expect(history.rows.map(r=>r.practitioner_id)).toEqual([original,original]);

  const upgrade = await requestChange(t,"studio",confirmed.id);
  expect(await settle(upgrade.id)).toBe(true);
  expect(await authorized(t,staff)).toBe(false);
  expect((await deskAccess()).active).toBe(false);
});

it("requires the owner to review a changed roster before removing access", async () => {
  const t = await signup("studio");
  const original = (await userQuery(t.owner, "select public.my_hone_solo_impact($1) as roster", [t.studio])).rows[0].roster;
  const email = await invite(t, "receptionist");
  for (const displayedVersion of [null, original.version]) {
    const result = await userQuery(t.owner, "select public.request_hone_subscription_change($1,'solo',null,$2) as decision", [t.studio, displayedVersion]);
    expect(result.rows[0].decision.result).toBe("team_changed");
  }
  expect((await billingState(t)).plan).toBe("studio");
  expect((await adminQuery("select status from public.pending_invitations where studio_id=$1 and email=$2", [t.studio, email])).rows[0].status).toBe("pending");
});

it("keeps the subscribing owner's seat when a studio has another owner", async () => {
  const t = await signup("studio");
  const second = await authUser(await invite(t,"owner"));
  await accept(second);
  expect((await requestChange(t,"solo",null,second)).result).toBe("billing_owner");
  const down = await requestChange(t,"solo");
  expect(await settle(down.id)).toBe(true);
  expect((await userQuery(second,"select public.is_studio_owner($1) as allowed",[t.studio])).rows[0].allowed).toBe(false);
  expect((await usage(t)).practitioner_used).toBe(1);
});
