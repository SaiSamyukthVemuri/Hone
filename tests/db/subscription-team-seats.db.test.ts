import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, adminTx, closePool, userQuery } from "./helpers/harness";
import { PLANS, type PlanKey } from "@/lib/subscriptions/plans";
import type { InvitationRole } from "@/lib/types/database";

afterAll(closePool);

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
      code: "HN002",
    });
    await expect(
      adminQuery(
        "insert into public.studio_receptionists(studio_id,display_name) values ($1,'Front desk')",
        [t.studio],
      ),
    ).rejects.toMatchObject({ code: "HN002" });
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
      code: "HN002",
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
        reason: { code: role === "practitioner" ? "HN001" : "HN002" },
      });
      await cancel(t, won[0].value);
      await invite(t, role);
    },
  );

  it("serializes two transactions that already saw the same last desk seat", async () => {
    const t = await signup("studio");
    let arrived = 0;
    let release!: () => void;
    const bothReady = new Promise<void>((r) => {
      release = r;
    });
    const contender = () =>
      adminTx(async (query) => {
        await query("set transaction isolation level repeatable read");
        await query("select * from public.hone_team_seat_counts($1)", [
          t.studio,
        ]);
        if (++arrived === 2) release();
        await bothReady;
        await query(
          "insert into public.pending_invitations(studio_id,email,role) values($1,$2,'receptionist')",
          [t.studio, email()],
        );
      });
    const results = await Promise.allSettled([contender(), contender()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "40001" },
    });
    expect(await usage(t)).toMatchObject({ receptionist_used: 1 });
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
    await expect(setActive(true)).rejects.toMatchObject({ code: "HN002" });
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
    ).rejects.toMatchObject({ code: "HN002" });
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

  it("refuses a downgrade over either limit and allows it once the owner frees the seats", async () => {
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
    await expect(setPlan("solo")).rejects.toMatchObject({ code: "HN002" });
    expect(await usage(t)).toMatchObject({
      plan: "studio",
      receptionist_used: 1,
    });
    await cancel(t, desk);
    await setPlan("solo");
    await expect(invite(t, "receptionist")).rejects.toMatchObject({
      code: "HN002",
    });
    await setPlan("studio");
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
    await adminQuery(
      "insert into public.studio_receptionists(studio_id,display_name) values ($1,'One'),($1,'Two')",
      [pilot],
    );
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
