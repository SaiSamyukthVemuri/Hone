import { randomUUID } from "node:crypto";
import { adminQuery, purgeAppointmentAudit, seedStudio, type SeededStudio } from "./harness";

// Reusable synthetic payment eligibility fixture for the quick-checkout DB
// integration tests (Stage B–I). TEST-ONLY: it seeds the complete real
// eligibility chain via privileged SQL against the disposable local Supabase, so
// the REAL getSessionPaymentEligibility resolver + the real dashboard state loader
// can be exercised without mocking. Nothing here is imported by production code.
//
// Every scenario is fully studio-scoped and uses fresh UUIDs (seedStudio already
// randomises ids + emails), so scenarios are parallel-safe. Synthetic Stripe
// identifiers are obviously test-only (acct_test_e2e_* / cus_* / pm_* / seti_*).
// No real card number, secret, PHI, or authorization content is stored.

const AMOUNT_MINOR = 22500; // synthetic chargeable amount ($225.00)

export type PaymentScenario = {
  runId: string;
  studioId: string;
  practitionerId: string;
  practitionerUserId: string;
  clientId: string;
  appointmentId: string;
  sessionId?: string;
  expectedAmountMinor: number;
  // Set ONLY when opts.bookedService seeded a real services row and stamped it
  // on the appointment. Left null by default so every pre-existing assertion
  // (which relies on the no-service / price_paid_cents fallback) is unchanged.
  serviceId: string | null;
  serviceName: string | null;
  servicePriceCents: number | null;
};

export type SeedOptions = {
  label?: string;
  // Lifecycle
  appointmentStatus?: "confirmed" | "completed" | "cancelled" | "no_show";
  withSession?: boolean;
  sessionStarted?: boolean;
  // Payment method
  withCard?: boolean;
  cardStatus?: "active" | "removed";
  cardLivemode?: boolean;
  cardPointerStale?: boolean; // point the card at a superseded signature
  // Authorization
  withTemplate?: boolean;
  withSignature?: boolean;
  signatureCurrent?: boolean; // false → signed an older template_version
  // Connect
  connect?: "enabled" | "disabled" | "incomplete" | "missing_account";
  connectLivemode?: boolean;
  // Attempt
  attempt?: "none" | "ready" | "pending_stripe" | "succeeded" | "failed" | "receipt_failed" | "refunded";
  // Booked service (Chloe checkout-default regression). OMITTED BY DEFAULT: the
  // historical fixture deliberately books NO service, which is exactly why no
  // test ever exercised the booked-service default-amount path and why the
  // migration-0151 PostgREST embed break shipped unnoticed. Supply this to seed
  // a real public.services row and stamp appointments.service_id.
  bookedService?: { name: string; priceCents: number | null; durationMinutes?: number };
  // Client-specific price rows (public.client_pricing), matched by service NAME.
  clientPricing?: Array<{ serviceName: string; priceCents: number; effectiveFrom: string; notes?: string }>;
};

const runToken = () => randomUUID().replace(/-/g, "").slice(0, 12);

type Ids = {
  runId: string;
  studio: SeededStudio;
  accountId: string;
  customerId: string;
  paymentMethodId: string;
  setupIntentId: string;
};

async function seedConnect(ids: Ids, opts: SeedOptions): Promise<void> {
  const mode = opts.connect ?? "enabled";
  if (mode === "missing_account") return; // no settings row at all
  const status =
    mode === "enabled" ? "enabled" : mode === "incomplete" ? "pending" : "restricted";
  await adminQuery(
    `insert into public.studio_payment_settings
       (studio_id, stripe_account_id, stripe_account_status, stripe_charges_enabled,
        stripe_payouts_enabled, stripe_livemode)
     values ($1,$2,$3,true,true,$4)`,
    [ids.studio.studioId, ids.accountId, status, opts.connectLivemode ?? false],
  );
}

async function seedCustomer(ids: Ids, opts: SeedOptions): Promise<void> {
  if ((opts.connect ?? "enabled") === "missing_account") return;
  await adminQuery(
    `insert into public.client_stripe_customers
       (client_id, studio_id, stripe_account_id, stripe_livemode, stripe_customer_id)
     values ($1,$2,$3,$4,$5)`,
    [
      ids.studio.clientId,
      ids.studio.studioId,
      ids.accountId,
      opts.cardLivemode ?? false,
      ids.customerId,
    ],
  );
}

// Returns { templateId, currentVersion, currentSignatureId, oldSignatureId }.
async function seedAuthorization(
  ids: Ids,
  opts: SeedOptions,
): Promise<{ templateId: string | null; currentSignatureId: string | null; oldSignatureId: string | null }> {
  if (opts.withTemplate === false) return { templateId: null, currentSignatureId: null, oldSignatureId: null };
  const currentVersion = 2; // the live template is at v2
  const t = await adminQuery(
    `insert into public.consent_form_templates
       (studio_id, title, body, form_type, version, status, is_live)
     values ($1,$2,$3,'card_authorization',$4,'active',true) returning id`,
    [ids.studio.studioId, "TEST Card authorization", "SYNTHETIC test body", currentVersion],
  );
  const templateId = t.rows[0].id;
  if (opts.withSignature === false) {
    return { templateId, currentSignatureId: null, oldSignatureId: null };
  }
  const insertSig = async (version: number) => {
    const r = await adminQuery(
      `insert into public.client_consent_signatures
         (studio_id, client_id, template_id, template_title_snapshot,
          template_body_snapshot, template_version, template_hash, signature_name)
       values ($1,$2,$3,'TEST Card authorization','SYNTHETIC test body',$4,$5,'Test Client')
       returning id`,
      [ids.studio.studioId, ids.studio.clientId, templateId, version, `hash_${runToken()}`],
    );
    return r.rows[0].id;
  };
  // Always seed an OLD-version signature (for the stale/superseded variants),
  // and a CURRENT one unless signatureCurrent === false.
  const oldSignatureId = await insertSig(currentVersion - 1);
  const currentSignatureId =
    opts.signatureCurrent === false ? null : await insertSig(currentVersion);
  return { templateId, currentSignatureId, oldSignatureId };
}

async function seedCard(
  ids: Ids,
  opts: SeedOptions,
  auth: { currentSignatureId: string | null; oldSignatureId: string | null },
): Promise<void> {
  if (opts.withCard === false) return;
  if ((opts.connect ?? "enabled") === "missing_account") return;
  const pointer = opts.cardPointerStale
    ? auth.oldSignatureId
    : (auth.currentSignatureId ?? auth.oldSignatureId);
  await adminQuery(
    `insert into public.client_payment_methods
       (studio_id, client_id, stripe_account_id, stripe_livemode, stripe_customer_id,
        stripe_payment_method_id, stripe_setup_intent_id, brand, last4, exp_month, exp_year,
        status, card_authorization_signature_id, removed_at)
     values ($1,$2,$3,$4,$5,$6,$7,'visa','4242',12,2030,$8,$9,$10)`,
    [
      ids.studio.studioId,
      ids.studio.clientId,
      ids.accountId,
      opts.cardLivemode ?? false,
      ids.customerId,
      ids.paymentMethodId,
      ids.setupIntentId,
      opts.cardStatus ?? "active",
      pointer,
      // removed_columns_check: a 'removed' card requires removed_at.
      opts.cardStatus === "removed" ? new Date().toISOString() : null,
    ],
  );
}

async function seedBookedService(
  ids: Ids,
  opts: SeedOptions,
): Promise<{ id: string; name: string; priceCents: number | null } | null> {
  if (!opts.bookedService) return null;
  const row = await adminQuery(
    `insert into public.services
       (studio_id, name, default_duration_minutes, price_cents, active, modality)
     values ($1,$2,$3,$4,true,'electrolysis') returning id`,
    [
      ids.studio.studioId,
      opts.bookedService.name,
      opts.bookedService.durationMinutes ?? 60,
      opts.bookedService.priceCents,
    ],
  );
  return {
    id: row.rows[0].id,
    name: opts.bookedService.name,
    priceCents: opts.bookedService.priceCents,
  };
}

async function seedClientPricing(ids: Ids, opts: SeedOptions): Promise<void> {
  for (const row of opts.clientPricing ?? []) {
    await adminQuery(
      `insert into public.client_pricing
         (studio_id, client_id, service_name, price_cents, effective_from, notes)
       values ($1,$2,$3,$4,$5,$6)`,
      [
        ids.studio.studioId,
        ids.studio.clientId,
        row.serviceName,
        row.priceCents,
        row.effectiveFrom,
        row.notes ?? null,
      ],
    );
  }
}

async function seedAppointmentAndSession(
  ids: Ids,
  opts: SeedOptions,
  service: { id: string } | null,
): Promise<{ appointmentId: string; sessionId?: string }> {
  const now = new Date();
  const starts = new Date(now.getTime() - 90 * 60 * 1000).toISOString();
  const ends = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
  const appt = await adminQuery(
    `insert into public.appointments
       (studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, service_id)
     values ($1,$2,$3,$4,$5,60,$6,$7) returning id`,
    [
      ids.studio.studioId,
      ids.studio.practitionerId,
      ids.studio.clientId,
      starts,
      ends,
      opts.appointmentStatus ?? "completed",
      service?.id ?? null,
    ],
  );
  const appointmentId = appt.rows[0].id;
  if (opts.withSession === false) return { appointmentId };
  const startedAt = opts.sessionStarted === false ? null : new Date().toISOString();
  const sess = await adminQuery(
    `insert into public.sessions
       (studio_id, client_id, practitioner_id, performed_by_practitioner_id, modality,
        appointment_id, started_at, price_paid_cents)
     values ($1,$2,$3,$3,'electrolysis',$4,$5,$6) returning id`,
    [
      ids.studio.studioId,
      ids.studio.clientId,
      ids.studio.practitionerId,
      appointmentId,
      startedAt,
      AMOUNT_MINOR,
    ],
  );
  return { appointmentId, sessionId: sess.rows[0].id };
}

async function seedAttempt(
  ids: Ids,
  sessionId: string | undefined,
  appointmentId: string,
  opts: SeedOptions,
): Promise<void> {
  const kind = opts.attempt ?? "none";
  if (kind === "none" || !sessionId) return;
  const status =
    kind === "receipt_failed" || kind === "refunded" ? "succeeded" : kind;
  await adminQuery(
    `insert into public.payment_charge_attempts
       (studio_id, charge_reason, client_id, session_id, appointment_id,
        created_by_practitioner_id, amount_cents, currency, status, stripe_livemode,
        client_payment_method_id, card_authorization_signature_id,
        stripe_payment_intent_id, stripe_charge_id, charged_at,
        receipt_status, refund_status)
     values ($1,'session_payment',$2,$3,$4,$5,$6,'cad',$7,false,
        (select id from public.client_payment_methods where client_id=$2 and studio_id=$1 limit 1),
        (select id from public.client_consent_signatures where client_id=$2 and studio_id=$1 order by template_version desc limit 1),
        $8,$9,$10,$11,$12)`,
    [
      ids.studio.studioId,
      ids.studio.clientId,
      sessionId,
      appointmentId,
      ids.studio.practitionerId,
      AMOUNT_MINOR,
      status,
      status === "succeeded" ? `pi_test_e2e_${runToken()}` : null,
      status === "succeeded" ? `ch_test_e2e_${runToken()}` : null,
      status === "succeeded" ? new Date().toISOString() : null,
      kind === "receipt_failed" ? "failed" : null,
      kind === "refunded" ? "succeeded" : null,
    ],
  );
}

// The factory. Default options seed the fully-eligible scenario.
export async function seedQuickCheckoutScenario(
  opts: SeedOptions = {},
): Promise<PaymentScenario> {
  const runId = runToken();
  const studio = await seedStudio(`qc-${opts.label ?? "sc"}-${runId}`);
  const ids: Ids = {
    runId,
    studio,
    accountId: `acct_test_e2e_${runId}`,
    customerId: `cus_test_e2e_${runId}`,
    paymentMethodId: `pm_test_e2e_${runId}`,
    setupIntentId: `seti_test_e2e_${runId}`,
  };
  await seedConnect(ids, opts);
  await seedCustomer(ids, opts);
  const auth = await seedAuthorization(ids, opts);
  await seedCard(ids, opts, auth);
  const service = await seedBookedService(ids, opts);
  await seedClientPricing(ids, opts);
  const { appointmentId, sessionId } = await seedAppointmentAndSession(ids, opts, service);
  await seedAttempt(ids, sessionId, appointmentId, opts);
  return {
    runId,
    studioId: studio.studioId,
    practitionerId: studio.practitionerId,
    practitionerUserId: studio.userId,
    clientId: studio.clientId,
    appointmentId,
    sessionId,
    expectedAmountMinor: AMOUNT_MINOR,
    serviceId: service?.id ?? null,
    serviceName: service?.name ?? null,
    servicePriceCents: service?.priceCents ?? null,
  };
}

export function seedEligibleQuickCheckoutScenario(
  opts: SeedOptions = {},
): Promise<PaymentScenario> {
  return seedQuickCheckoutScenario({
    appointmentStatus: "completed",
    withSession: true,
    sessionStarted: true,
    withCard: true,
    cardStatus: "active",
    withTemplate: true,
    withSignature: true,
    signatureCurrent: true,
    connect: "enabled",
    attempt: "none",
    ...opts,
  });
}

// Non-PHI clinical baseline for before/after comparison in the browser E2E.
export type ClinicalIntegritySnapshot = {
  exists: boolean;
  started: boolean;
  blockCount: number;
  areaCount: number;
  consultationNoteCount: number;
  skinHairNoteCount: number;
};

export async function readClinicalIntegritySnapshot(
  sessionId: string,
): Promise<ClinicalIntegritySnapshot> {
  const s = await adminQuery(
    `select started_at from public.sessions where id=$1 and deleted_at is null`,
    [sessionId],
  );
  if (s.rows.length === 0) {
    return { exists: false, started: false, blockCount: 0, areaCount: 0, consultationNoteCount: 0, skinHairNoteCount: 0 };
  }
  const count = async (sql: string) =>
    Number((await adminQuery(sql, [sessionId])).rows[0].n);
  const blockCount = await count(
    `select count(*)::text n from public.session_blocks where session_id=$1 and deleted_at is null`,
  );
  const areaCount = await count(
    `select count(*)::text n from public.session_block_areas a join public.session_blocks b on b.id=a.session_block_id where b.session_id=$1`,
  );
  const consultationNoteCount = await count(
    `select count(*)::text n from public.client_clinical_notes where session_id=$1 and note_kind='consultation'`,
  ).catch(() => 0);
  const skinHairNoteCount = await count(
    `select count(*)::text n from public.client_clinical_notes where session_id=$1 and note_kind='skin_hair_analysis'`,
  ).catch(() => 0);
  return {
    exists: true,
    started: s.rows[0].started_at != null,
    blockCount,
    areaCount,
    consultationNoteCount,
    skinHairNoteCount,
  };
}

// Payment-state readers (test-safe columns only).
export async function getSessionPaymentAttempts(sessionId: string): Promise<
  Array<{ status: string; refund_status: string | null; receipt_status: string | null; amount_cents: number }>
> {
  const r = await adminQuery(
    `select status, refund_status, receipt_status, amount_cents
       from public.payment_charge_attempts
      where session_id=$1 and charge_reason='session_payment'
      order by created_at`,
    [sessionId],
  );
  return r.rows;
}

// Foreign-key-safe, run-scoped cleanup. Deletes ONLY this scenario's rows, in
// child→parent order (client_stripe_customers + client_payment_methods RESTRICT
// the client/settings deletes, so the studio cascade alone can't remove them).
// The final `delete studios` cascades clients + practitioners. Never truncates.
export async function cleanupPaymentScenario(studioId: string): Promise<void> {
  // B5/0174: the audit trail must go before its appointments and its studio,
  // appointment_audit is append-only (no runtime DELETE) and its studio FK is
  // RESTRICT. Owner-only harness fixture; ships in no migration.
  await purgeAppointmentAudit(studioId);
  for (const sql of [
    `delete from public.payment_charge_attempts where studio_id=$1`,
    `delete from public.client_payment_methods where studio_id=$1`,
    `delete from public.client_stripe_customers where studio_id=$1`,
    `delete from public.client_consent_signatures where studio_id=$1`,
    `delete from public.consent_form_templates where studio_id=$1`,
    `delete from public.studio_payment_settings where studio_id=$1`,
    `delete from public.sessions where studio_id=$1`,
    `delete from public.appointments where studio_id=$1`,
    `delete from public.studios where id=$1`,
  ]) {
    await adminQuery(sql, [studioId]);
  }
}
