import { randomUUID } from "node:crypto";
import { adminQuery, type SeededStudio } from "./harness";

// ===========================================================================
// PAY-CCY-06 (#824) — a COMPOSABLE US/USD payment layer for any seeded studio
// ===========================================================================
//
// TEST-ONLY. This is the payment half of the synthetic Fett studio. It does not
// create a studio: it takes one that already exists — #853's seedFettStudio, the
// harness seedStudio, or anything else with a studio, an owner practitioner and
// a client — and makes it able to take USD card payments against the FAKE
// Stripe processor.
//
// REQUIRES MIGRATION 0214 (#833), WHICH IS NOT ON THE PRODUCTION CHAIN. On a
// 0210 stack the layer REFUSES (assertUsdCapableDatabase) rather than seeding a
// scenario that would silently be CAD. A rehearsal on the production chain
// cannot demonstrate USD; it needs a stack carrying the #833 stack.
//
// Composing with #853 (head 42dccc7d): seedFettStudio defaults capacity to
// "live" (per-practitioner resources), so pass its studio straight in, and pass
// its `services.treatmentId` as `serviceId` to price the existing treatment.
// The visit is inserted directly as an already-completed appointment, because
// create_internal_appointment_v2 books future slots only.
//
// Order matters, and the functions enforce it:
//   1. makeStudioUsd           — the operator's switch (0214's protected
//                                command), allowed ONLY before the studio has a
//                                Stripe account or any money; refused after.
//   2. bindFakeStripeAccount   — a connected account bound to the studio, with
//                                the country Stripe "reported" for it. "US" for
//                                the happy path; "CA" builds the wrong-country
//                                refusal scenario.
//   3. seedCardOnFile          — card-authorization template, a current
//                                signature, a Stripe customer and an active card
//                                for one client, all on that account.
//   4. seedChargeableVisit     — a priced service, a completed appointment and a
//                                started session: the visit a practitioner
//                                charges at checkout.
//
// Everything is recognizably synthetic: `acct_test_e2e_*` / `cus_test_e2e_*`
// identifiers (the fake processor's namespace), harness emails, no card data.
// Nothing here calls Stripe; nothing here can run against a hosted database
// (the harness refuses hosted URLs).

export type UsdStudioRef = Pick<SeededStudio, "studioId" | "practitionerId" | "clientId">;

const token = () => randomUUID().replace(/-/g, "").slice(0, 12);

/**
 * USD EXISTS ONLY WHERE 0214 IS APPLIED. On the production chain (0210, and on
 * any stack without #833) every ledger's currency is CAD-only and services have
 * no currency, so a "USD" scenario there would quietly be a CAD one. This
 * refuses instead, naming why, so no rehearsal or proof built on this layer can
 * read as stronger than the database it ran on.
 */
export async function assertUsdCapableDatabase(
  query: (text: string) => Promise<{ rows: unknown[] }> = (text) => adminQuery(text),
): Promise<void> {
  const r = await query(
    `select to_regclass('public.studio_payment_jurisdictions') is not null as has_table,
            to_regprocedure('public.set_studio_payment_jurisdiction(uuid,text,text,text,text,boolean,text)') is not null as has_command`,
  );
  const row = r.rows[0] as { has_table: boolean; has_command: boolean };
  if (!row.has_table || !row.has_command) {
    throw new Error(
      "usd-payment-fixture: this database has no migration 0214 (studio_payment_jurisdictions). " +
        "USD cannot be demonstrated on it; on a 0210 chain every payment is CAD. Use a stack carrying #833.",
    );
  }
}

/**
 * Switch a studio to US/usd through the real 0214 command. `acknowledgePrices`
 * must be true if the studio already has priced services or fees (e.g. #853's
 * services after prices are set); the command refuses otherwise. Throws on any
 * result other than `initialized`, `changed` or `unchanged`, so a fixture can never silently
 * leave a studio Canadian.
 */
export async function makeStudioUsd(
  studio: Pick<UsdStudioRef, "studioId">,
  opts: { acknowledgePrices?: boolean } = {},
): Promise<void> {
  await assertUsdCapableDatabase();
  const r = await adminQuery(
    `select out_result from public.set_studio_payment_jurisdiction($1,'US','usd','harness:usd-fixture','synthetic verified US studio',$2,'fixture:usd-payment')`,
    [studio.studioId, opts.acknowledgePrices ?? false],
  );
  const result = r.rows[0]?.out_result as string | undefined;
  if (result !== "initialized" && result !== "changed" && result !== "unchanged") {
    throw new Error(`makeStudioUsd: set_studio_payment_jurisdiction returned ${result}`);
  }
}

export type FakeStripeAccount = { accountId: string; reportedCountry: "US" | "CA" };

/**
 * Bind a connected account (test mode) as Stripe would have after onboarding
 * and an account.updated: enabled, charges and payouts on, and the COUNTRY
 * Stripe reported recorded through the real 0214 recorder.
 */
export async function bindFakeStripeAccount(
  studio: Pick<UsdStudioRef, "studioId">,
  opts: { reportedCountry?: "US" | "CA"; accountId?: string } = {},
): Promise<FakeStripeAccount> {
  const accountId = opts.accountId ?? `acct_test_e2e_${token()}`;
  const reportedCountry = opts.reportedCountry ?? "US";
  await adminQuery(
    `insert into public.studio_payment_settings
       (studio_id, stripe_account_id, stripe_account_status, stripe_charges_enabled,
        stripe_payouts_enabled, stripe_livemode, stripe_onboarding_completed_at)
     values ($1,$2,'enabled',true,true,false,now())`,
    [studio.studioId, accountId],
  );
  const rec = await adminQuery(
    `select out_result from public.record_stripe_account_jurisdiction($1,$2,false,$3,$4)`,
    [studio.studioId, accountId, reportedCountry, reportedCountry === "US" ? "usd" : "cad"],
  );
  if (rec.rows[0]?.out_result !== "recorded") {
    throw new Error(`bindFakeStripeAccount: record returned ${rec.rows[0]?.out_result}`);
  }
  return { accountId, reportedCountry };
}

export type CardOnFile = {
  customerId: string;
  paymentMethodId: string;
  signatureId: string;
  clientEmail: string;
};

/**
 * A client with a signed, current card authorization and an active card on the
 * bound account. The client's email is set to a `success+` harness address so
 * the E2E fake email transport ACCEPTS the receipt (its lane default refuses).
 */
export async function seedCardOnFile(
  studio: UsdStudioRef,
  account: FakeStripeAccount,
): Promise<CardOnFile> {
  const t = token();
  const customerId = `cus_test_e2e_${t}`;
  const paymentMethodId = `pm_test_e2e_${t}`;
  const clientEmail = `success+usd-${t}@harness.local`;
  await adminQuery(`update public.clients set email = $2 where id = $1 and studio_id = $3`, [
    studio.clientId,
    clientEmail,
    studio.studioId,
  ]);
  await adminQuery(
    `insert into public.client_stripe_customers
       (client_id, studio_id, stripe_account_id, stripe_livemode, stripe_customer_id)
     values ($1,$2,$3,false,$4)`,
    [studio.clientId, studio.studioId, account.accountId, customerId],
  );
  const tpl = await adminQuery(
    `insert into public.consent_form_templates
       (studio_id, title, body, form_type, version, status, is_live)
     values ($1,'SYNTHETIC card authorization','SYNTHETIC body','card_authorization',1,'active',true)
     returning id`,
    [studio.studioId],
  );
  const sig = await adminQuery(
    `insert into public.client_consent_signatures
       (studio_id, client_id, template_id, template_title_snapshot,
        template_body_snapshot, template_version, template_hash, signature_name)
     values ($1,$2,$3,'SYNTHETIC card authorization','SYNTHETIC body',1,$4,'Synthetic Client')
     returning id`,
    [studio.studioId, studio.clientId, tpl.rows[0].id, `hash_${t}`],
  );
  const signatureId = sig.rows[0].id as string;
  await adminQuery(
    `insert into public.client_payment_methods
       (studio_id, client_id, stripe_account_id, stripe_livemode, stripe_customer_id,
        stripe_payment_method_id, stripe_setup_intent_id, brand, last4, exp_month, exp_year,
        status, card_authorization_signature_id)
     values ($1,$2,$3,false,$4,$5,$6,'visa','4242',12,2030,'active',$7)`,
    [
      studio.studioId,
      studio.clientId,
      account.accountId,
      customerId,
      paymentMethodId,
      `seti_test_e2e_${t}`,
      signatureId,
    ],
  );
  return { customerId, paymentMethodId, signatureId, clientEmail };
}

export type ChargeableVisit = {
  serviceId: string;
  appointmentId: string;
  sessionId: string;
  priceCents: number;
};

/**
 * A completed, started treatment the practitioner can charge: a service at
 * `priceCents` (in the studio's currency — the services table has no currency
 * of its own), an appointment that ended half an hour ago, and its session.
 * `serviceId` reuses an existing service (e.g. #853's treatment) and prices it.
 */
export async function seedChargeableVisit(
  studio: UsdStudioRef,
  opts: { priceCents: number; serviceId?: string; practitionerId?: string },
): Promise<ChargeableVisit> {
  const practitionerId = opts.practitionerId ?? studio.practitionerId;
  let serviceId = opts.serviceId;
  if (serviceId) {
    await adminQuery(`update public.services set price_cents = $2 where id = $1 and studio_id = $3`, [
      serviceId,
      opts.priceCents,
      studio.studioId,
    ]);
  } else {
    const svc = await adminQuery(
      `insert into public.services (studio_id, name, default_duration_minutes, price_cents, active, modality)
       values ($1,$2,60,$3,true,'electrolysis') returning id`,
      [studio.studioId, `SYNTH USD Electrolysis ${token()}`, opts.priceCents],
    );
    serviceId = svc.rows[0].id as string;
  }
  const appt = await adminQuery(
    `insert into public.appointments
       (studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, service_id)
     values ($1,$2,$3, now() - interval '90 minutes', now() - interval '30 minutes', 60, 'completed', $4)
     returning id`,
    [studio.studioId, practitionerId, studio.clientId, serviceId],
  );
  const appointmentId = appt.rows[0].id as string;
  const sess = await adminQuery(
    `insert into public.sessions
       (studio_id, client_id, practitioner_id, performed_by_practitioner_id, modality,
        appointment_id, started_at)
     values ($1,$2,$3,$3,'electrolysis',$4, now() - interval '85 minutes') returning id`,
    [studio.studioId, studio.clientId, practitionerId, appointmentId],
  );
  return { serviceId, appointmentId, sessionId: sess.rows[0].id as string, priceCents: opts.priceCents };
}

/**
 * The whole layer, in the only order 0214 permits: switch first, then the
 * account, card and visit. `accountCountry: "CA"` builds the wrong-country
 * refusal scenario (US studio, Canadian account); everything else is equal.
 */
export async function seedUsdPaymentLayer(
  studio: UsdStudioRef,
  opts: { priceCents?: number; serviceId?: string; accountCountry?: "US" | "CA" } = {},
): Promise<{ account: FakeStripeAccount; card: CardOnFile; visit: ChargeableVisit }> {
  await makeStudioUsd(studio);
  const account = await bindFakeStripeAccount(studio, { reportedCountry: opts.accountCountry ?? "US" });
  const card = await seedCardOnFile(studio, account);
  const visit = await seedChargeableVisit(studio, {
    priceCents: opts.priceCents ?? 15_000,
    serviceId: opts.serviceId,
  });
  return { account, card, visit };
}
