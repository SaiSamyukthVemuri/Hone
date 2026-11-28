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
          await adminQuery(c.p_restart ? "select public.apply_hone_restart_invoice($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as result" : applySql, [
            c.p_event,
            c.p_attempt,
            c.p_user,
            c.p_plan,
            c.p_customer,
            c.p_subscription,
            c.p_invoice,
            c.p_kind,
            c.p_event_at,
            ...(c.p_restart ? [c.p_restart] : []),
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
  return { user, email, invoice, receive, memberships, sub };
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
      expect((await adminQuery("select onboarding_v2_enabled from public.studios where id=$1",[members[0].studio_id])).rows[0].onboarding_v2_enabled).toBe(true);
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

  it("restores the original studio only after collection and ignores old cancellation events", async () => {
    const f = await fixture("studio");
    const event = () => "evt_" + randomUUID();
    await f.receive(event());
    const [owner] = await f.memberships();
    const attempt = f.sub.metadata.hone_attempt_id;
    const original = f.sub.id;
    async function claim(user = f.user) {
      return (await adminQuery("select public.claim_hone_restart($1,$2) as r",[owner.studio_id,user])).rows[0].r;
    }
    const cancel = () => adminQuery("select public.record_hone_subscription_canceled($1,$2,$3,$4) as ok",[original,f.sub.customer,attempt,f.user]);
    const status = async () => (await userQuery(f.user,"select public.my_hone_billing_status($1) as b",[owner.studio_id])).rows[0].b.status;
    expect(await claim()).toBeNull();
    await cancel();
    expect(await claim(randomUUID())).toBeNull();
    const [a,b] = await Promise.all([claim(),claim()]);
    expect(a.id).toBe(b.id);
    f.sub.id = f.invoice.subscription = "sub_new_" + randomUUID();
    f.invoice.id = "in_new_" + randomUUID();
    f.sub.metadata.hone_restart_id = randomUUID();
    await f.receive(event());
    expect(await status()).toBe("canceled");
    f.sub.metadata.hone_restart_id = a.id;
    f.invoice.collected=0;
    await f.receive(event());
    expect(await status()).toBe("canceled");
    f.invoice.collected=f.invoice.total;
    await Promise.all([f.receive(event()),f.receive(event())]);
    expect((await cancel()).rows[0].ok).toBe(false);
    expect(await status()).toBe("active");
    expect(await f.memberships()).toEqual([owner]);
    expect((await adminQuery("select count(*) as n from public.hone_subscription_notices where invoice_id=$1 and kind='receipt'",[f.invoice.id])).rows[0].n).toBe("1");
  });

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
    expect(await status()).toMatchObject({
      status: "past_due", invoice: f.invoice.id,
    });
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
    expect(await status()).toMatchObject({ status: "paused", invoice: f.invoice.id });
    await expect(chart()).rejects.toThrow(/subscription_payment_required/);
    await expect(book()).rejects.toThrow(/subscription_payment_required/);
    // Care already under way is never refused: the session existed before the lock, so its block,
    // electrolysis entry and laser entry are all accepted.
    await adminQuery("insert into public.session_blocks(studio_id,session_id) values ($1,$2)", [owner.studio_id, sessionId]);
    await adminQuery("insert into public.electrolysis_entries(session_id,area) values ($1,'chin')", [sessionId]);
    await adminQuery("insert into public.laser_entries(session_id,zone) values ($1,'chin')", [sessionId]);
    f.invoice.status = "paid";
    f.invoice.amountPaid = 4900;
    f.invoice.collected = 4900;
    f.sub.status = "active";
    await f.receive("evt_" + randomUUID());
    await f.receive("evt_" + randomUUID(), "invoice.payment_failed", first);
    expect(await status()).toMatchObject({ status: "active", deadline: null, invoice: null });
    await book();
    await chart();
    expect(await f.memberships()).toEqual([owner]);
  });

  it("offers the oldest unpaid invoice and advances to the next after settlement", async () => {
    const f = await fixture();
    await f.receive(randomUUID());
    const [owner] = await f.memberships();
    const snapshot = async () => (await userQuery(f.user,
      "select public.my_hone_billing_status($1) as s", [owner.studio_id])).rows[0].s;
    const earlier = "in_" + randomUUID();
    const later = "in_" + randomUUID();
    const now = Math.floor(Date.now() / 1000);
    f.invoice.reason = "subscription_cycle";
    f.invoice.status = "open";
    f.invoice.amountPaid = f.invoice.collected = 0;
    f.sub.status = "past_due";
    f.invoice.id = later;
    await f.receive(randomUUID(), "invoice.payment_failed", now - 60);
    f.invoice.id = earlier;
    await f.receive(randomUUID(), "invoice.payment_failed", now - 8 * 86400);
    expect(await snapshot()).toMatchObject({ status: "paused", invoice: earlier });
    f.invoice.status = "paid";
    f.invoice.amountPaid = f.invoice.collected = 4900;
    await f.receive(randomUUID());
    expect(await snapshot()).toMatchObject({ status: "past_due", invoice: later });
    f.invoice.id = later;
    await f.receive(randomUUID());
    expect(await snapshot()).toMatchObject({ status: "active", invoice: null });
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

describe("subscription notification outbox", () => {
  const claim = async (email: string) =>
    (
      await adminQuery(
        "select public.claim_hone_subscription_notice($1) as notice",
        [email],
      )
    ).rows[0].notice;
  type Claimed = {
    id: string;
    lease: string;
    kind: string;
    deadline: string | null;
    recipient: string;
  };
  const authorize = async (n: Claimed, digest = "a".repeat(64)) =>
    (
      await adminQuery(
        "select public.authorize_hone_subscription_notice($1,$2,$3,$4,$5) as ok",
        [n.id, n.lease, n.recipient, digest, n.deadline],
      )
    ).rows[0].ok;
  const finish = async (n: Claimed) =>
    (
      await adminQuery(
        "select public.finish_hone_subscription_notice($1,$2) as ok",
        [n.id, n.lease],
      )
    ).rows[0].ok;
  async function initial() {
    const f = await fixture();
    await Promise.all([f.receive(randomUUID()), f.receive(randomUUID())]);
    const receipts = (
      await Promise.all([claim(f.email), claim(f.email)])
    ).filter(Boolean);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].kind).toBe("receipt");
    expect(await authorize(receipts[0])).toBe(true);
    expect(await finish(receipts[0])).toBe(true);
    expect(await claim(f.email)).toBeNull();
    f.invoice.id = "in_" + randomUUID();
    f.invoice.reason = "subscription_cycle";
    f.invoice.status = "open";
    f.invoice.amountPaid = 0;
    f.invoice.collected = 0;
    f.sub.status = "past_due";
    return f;
  }
  async function recover(f: Awaited<ReturnType<typeof initial>>) {
    f.invoice.status = "paid";
    f.invoice.amountPaid = 4900;
    f.invoice.collected = 4900;
    f.sub.status = "active";
    await Promise.all([f.receive(randomUUID()), f.receive(randomUUID())]);
    const receipt = await claim(f.email);
    expect(receipt.kind).toBe("receipt");
    expect(await authorize(receipt)).toBe(true);
    expect(await finish(receipt)).toBe(true);
    expect(await claim(f.email)).toBeNull();
  }
  it("delivers the first warning once, then the pause without a new Stripe event, then a renewal receipt", async () => {
    const f = await initial();
    const first = Math.floor(Date.now() / 1000) - 86400;
    await f.receive(randomUUID(), "invoice.payment_failed", first);
    await f.receive(randomUUID(), "invoice.payment_failed", first + 600);
    const warning = await claim(f.email);
    expect(warning.kind).toBe("warning");
    expect(Date.parse(warning.deadline)).toBe((first + 7 * 86400) * 1000);
    expect(await authorize(warning)).toBe(true);
    expect(await finish(warning)).toBe(true);
    expect(await claim(f.email)).toBeNull();
    // Move the fixture's deadline past the database clock without another webhook.
    await adminQuery(
      "update public.hone_renewal_invoices set failed_at=now()-interval '168 hours' where invoice_id=$1",
      [f.invoice.id],
    );
    const pause = await claim(f.email);
    expect(pause.kind).toBe("paused");
    expect(await authorize(pause)).toBe(true);
    expect(await finish(pause)).toBe(true);
    expect(await claim(f.email)).toBeNull();
    await recover(f);
  });
  it.each([1, 8])(
    "payment during dispatch suppresses a pending warning or pause (day %i)",
    async (days) => {
      const f = await initial();
      await f.receive(
        randomUUID(),
        "invoice.payment_failed",
        Math.floor(Date.now() / 1000) - days * 86400,
      );
      const pending = await claim(f.email);
      expect(pending.kind).toBe(days === 1 ? "warning" : "paused");
      await recover(f);
      expect(await authorize(pending)).toBe(false);
    },
  );
  it("retries a lost acknowledgement with the same payload only inside the provider window", async () => {
    const f = await fixture();
    await f.receive(randomUUID());
    const receipt = await claim(f.email);
    expect(await authorize(receipt)).toBe(true);
    const expire = () =>
      adminQuery(
        "update public.hone_subscription_notices set retry_at=now() where id=$1",
        [receipt.id],
      );
    await expire();
    const retry = await claim(f.email);
    expect(retry.id).toBe(receipt.id);
    expect(retry.lease).not.toBe(receipt.lease);
    expect(await authorize(retry, "b".repeat(64))).toBe(false);
    expect(await authorize(retry)).toBe(true);
    expect(await finish(receipt)).toBe(false);
    await expire();
    await adminQuery(
      "update public.hone_subscription_notices set first_send_at=now()-interval '24 hours' where id=$1",
      [retry.id],
    );
    expect(await claim(f.email)).toEqual({ needs_review: true });
  });
  it("rechecks the owner's membership and denies ordinary roles access to dispatch", async () => {
    const f = await fixture();
    await f.receive(randomUUID());
    expect(await claim("other@example.test")).toBeNull();
    const notice = await claim(f.email);
    await adminQuery(
      "update public.practitioners set active=false where user_id=$1",
      [f.user],
    );
    expect(await authorize(notice)).toBe(false);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(
        asRole(role, (q) =>
          q("select public.claim_hone_subscription_notice($1)", [f.email]),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asRole(role, (q) =>
          q("select * from public.hone_due_subscription_notices"),
        ),
      ).rejects.toThrow(/permission denied/);
    }
  });
});
