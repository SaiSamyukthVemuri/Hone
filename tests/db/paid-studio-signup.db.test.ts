import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, closePool, userQuery } from "./helpers/harness";
import { createBillingStripeClient } from "@/lib/subscriptions/billing-client";
import {
  acceptBillingInvoice,
  type PaidInvoiceCommand,
} from "@/lib/subscriptions/paid-signup";
import {
  ENV_ON,
  SOLO_PRICE,
  STUDIO_PRICE,
  subscription,
} from "../lib/subscriptions/helpers/fake-billing-client";

afterAll(closePool);
const applySql =
  "select public.apply_hone_billing_invoice($1,$2,$3,$4,$5,$6,$7,$8,$9) as result";

async function fixture(plan: "solo" | "studio" = "solo") {
  const user = randomUUID();
  const email = user + "@example.test";
  await adminQuery(
    "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
    [user, email],
  );
  const claim = async () =>
    (
      await adminQuery(
        "select public.claim_hone_signup($1,$2,'Test studio','Test owner') as a",
        [user, plan],
      )
    ).rows[0].a;
  const [a, b] = await Promise.all([claim(), claim()]);
  expect(a.id).toBe(b.id);
  const amount = plan === "solo" ? 4900 : 9900;
  const price = plan === "solo" ? SOLO_PRICE : STUDIO_PRICE;
  const sub = subscription(
    {
      id: "sub_" + user,
      customer: "cus_" + user,
      metadata: { hone_attempt_id: a.id, hone_user_id: user, hone_plan: plan },
    },
    { id: price, unit_amount: amount },
  );
  const invoice: Awaited<
    ReturnType<ReturnType<typeof createBillingStripeClient>["readInvoice"]>
  > = {
    id: "in_" + user,
    subscription: sub.id,
    customer: sub.customer,
    reason: "subscription_create",
    status: "paid",
    currency: "usd",
    total: amount,
    amountPaid: amount,
    collected: amount,
    live: false,
    price,
  };
  const signer = new Stripe("sk_test_fixture");
  const secret = "whsec_local_fixture";
  const client = createBillingStripeClient({
    HONE_BILLING_STRIPE_SECRET_KEY: "sk_test_fixture",
    HONE_BILLING_WEBHOOK_SECRET: secret,
  });
  const adapter = {
    constructEvent: client.constructEvent,
    readInvoice: async () => invoice,
    retrieveSubscription: async () => sub,
  };
  async function receive(
    eventId: string,
    type = "invoice.paid",
    at = Math.floor(Date.now() / 1000),
    account?: string,
  ) {
    const raw = JSON.stringify({
      id: eventId,
      type,
      account,
      created: at,
      livemode: false,
      data: {
        object: {
          id: invoice.id,
          parent: { subscription_details: { subscription: sub.id } },
        },
      },
    });
    const sig = signer.webhooks.generateTestHeaderString({
      payload: raw,
      secret,
    });
    return acceptBillingInvoice(
      raw,
      sig,
      adapter,
      ENV_ON,
      async (c: PaidInvoiceCommand) =>
        (
          await adminQuery(applySql, [
            c.p_event,
            c.p_attempt,
            c.p_user,
            c.p_plan,
            c.p_customer,
            c.p_subscription,
            c.p_invoice,
            c.p_kind,
            c.p_event_at,
          ])
        ).rows[0].result,
    );
  }
  const memberships = async () =>
    (
      await adminQuery(
        "select studio_id,id,role from public.practitioners where user_id=$1",
        [user],
      )
    ).rows;
  return { user, invoice, receive, memberships, sub };
}

describe("sandbox paid signup", () => {
  it.each(["solo", "studio"] as const)(
    "one %s owner and studio after concurrent signed deliveries",
    async (plan) => {
      const f = await fixture(plan);
      expect(await f.memberships()).toHaveLength(0);
      const id = "evt_" + randomUUID();
      expect(
        await Promise.all([
          f.receive(id),
          f.receive(id),
          f.receive("evt_" + randomUUID()),
        ]),
      ).toEqual([200, 200, 200]);
      const members = await f.memberships();
      expect(members).toHaveLength(1);
      expect(members[0].role).toBe("owner");
      expect(
        (
          await userQuery(
            f.user,
            "select public.my_hone_billing_status($1) as value",
            [members[0].studio_id],
          )
        ).rows[0].value.plan,
      ).toBe(plan);
      expect(
        (
          await userQuery(
            randomUUID(),
            "select public.my_hone_billing_status($1) as value",
            [members[0].studio_id],
          )
        ).rows[0].value,
      ).toBeNull();
    },
  );

  it("recovers from a provisioning failure by replaying the same signed event", async () => {
    const f = await fixture();
    const event = "evt_" + randomUUID();
    await adminQuery(
      "update auth.users set email_confirmed_at=null where id=$1",
      [f.user],
    );
    await expect(f.receive(event)).rejects.toThrow();
    expect(await f.memberships()).toHaveLength(0);
    expect(
      (
        await adminQuery(
          "select id from public.hone_billing_events where id=$1",
          [event],
        )
      ).rows,
    ).toHaveLength(0);
    await adminQuery(
      "update auth.users set email_confirmed_at=now() where id=$1",
      [f.user],
    );
    expect(await f.receive(event)).toBe(200);
    expect(await f.memberships()).toHaveLength(1);
  });

  it("ignores a signed delivery for a different Stripe account", async () => {
    const f = await fixture();
    expect(
      await f.receive(
        "evt_" + randomUUID(),
        "invoice.paid",
        undefined,
        "acct_other_fixture",
      ),
    ).toBe(200);
    expect(await f.memberships()).toHaveLength(0);
  });

  it("asks Stripe to redeliver an early renewal until the original purchase exists", async () => {
    const f = await fixture();
    const initial = f.invoice.id;
    const renewal = "in_" + randomUUID();
    const renewalEvent = "evt_" + randomUUID();
    f.invoice.id = renewal;
    f.invoice.reason = "subscription_cycle";
    expect(await f.receive(renewalEvent)).toBe(503);
    expect(await f.memberships()).toHaveLength(0);
    f.invoice.id = initial;
    f.invoice.reason = "subscription_create";
    expect(await f.receive("evt_" + randomUUID())).toBe(200);
    f.invoice.id = renewal;
    f.invoice.reason = "subscription_cycle";
    expect(await f.receive(renewalEvent)).toBe(200);
    expect(await f.memberships()).toHaveLength(1);
  });

  it("declined, manually marked paid and wrong-price first invoices grant nothing", async () => {
    const f = await fixture();
    f.invoice.status = "open";
    f.invoice.collected = 0;
    f.invoice.amountPaid = 0;
    await f.receive("evt_" + randomUUID(), "invoice.payment_failed");
    f.invoice.status = "paid";
    f.invoice.amountPaid = 4900;
    await f.receive("evt_" + randomUUID());
    f.invoice.collected = 4900;
    f.invoice.price = STUDIO_PRICE;
    await f.receive("evt_" + randomUUID());
    expect(await f.memberships()).toHaveLength(0);
  });

  it("grants seven days, keeps the first failure on retry, and recovers the original studio", async () => {
    const f = await fixture();
    await f.receive("evt_" + randomUUID());
    const [owner] = await f.memberships();
    const client = randomUUID();
    await adminQuery(
      "insert into public.clients(id,studio_id,name) values($1,$2,'Demo')",
      [client, owner.studio_id],
    );
    const chart = () =>
      adminQuery(
        "insert into public.sessions(studio_id,client_id,practitioner_id,modality) values($1,$2,$3,'electrolysis') returning id",
        [owner.studio_id, client, owner.id],
      );
    const book = () =>
      adminQuery(
        "insert into public.appointments(studio_id,client_id,practitioner_id,starts_at,ends_at,duration_minutes) values ($1,$2,$3,now()+interval '1 day',now()+interval '1 day 15 min',15)",
        [owner.studio_id, client, owner.id],
      );
    const status = async () =>
      (
        await userQuery(
          f.user,
          "select public.my_hone_billing_status($1) as s",
          [owner.studio_id],
        )
      ).rows[0].s;
    f.invoice.id = "in_" + randomUUID();
    f.invoice.reason = "subscription_cycle";
    f.invoice.status = "open";
    f.invoice.amountPaid = 0;
    f.invoice.collected = 0;
    f.sub.status = "past_due";
    const first = Math.floor(Date.now() / 1000) - 6 * 86400;
    await f.receive("evt_" + randomUUID(), "invoice.payment_failed", first);
    await f.receive(
      "evt_" + randomUUID(),
      "invoice.payment_failed",
      first + 3600,
    );
    expect(Date.parse((await status()).deadline)).toBe(
      (first + 7 * 86400) * 1000,
    );
    const sessionId = (await chart()).rows[0].id;
    // Deliver the earlier failure late. The clock crosses the deadline without any new job.
    await f.receive(
      "evt_" + randomUUID(),
      "invoice.payment_failed",
      first - 86400,
    );
    await expect(chart()).rejects.toThrow(/subscription_payment_required/);
    await expect(book()).rejects.toThrow(/subscription_payment_required/);
    await expect(
      adminQuery(
        "insert into public.session_blocks(studio_id,session_id) values ($1,$2)",
        [owner.studio_id, sessionId],
      ),
    ).rejects.toThrow(/subscription_payment_required/);
    await expect(
      adminQuery(
        "insert into public.electrolysis_entries(session_id,area) values ($1,'chin')",
        [sessionId],
      ),
    ).rejects.toThrow(/subscription_payment_required/);
    await expect(
      adminQuery(
        "insert into public.laser_entries(session_id,zone) values ($1,'chin')",
        [sessionId],
      ),
    ).rejects.toThrow(/subscription_payment_required/);
    f.invoice.status = "paid";
    f.invoice.amountPaid = 4900;
    f.invoice.collected = 4900;
    f.sub.status = "active";
    await f.receive("evt_" + randomUUID());
    await f.receive("evt_" + randomUUID(), "invoice.payment_failed", first);
    expect((await status()).deadline).toBeNull();
    await book();
    await chart();
    expect(await f.memberships()).toEqual([owner]);
  });

  it.each(["anon", "authenticated"] as const)(
    "rejects direct purchase commands for %s",
    async (role) => {
      await expect(
        asRole(role, (q) =>
          q("select public.claim_hone_signup($1,'solo','Studio','Owner')", [
            randomUUID(),
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asRole(role, (q) => q("select * from public.hone_signup_attempts")),
      ).rejects.toThrow(/permission denied/);
    },
  );
});
