import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import {
  MANUAL_FEE_AMOUNT_CEILING_CENTS,
  type EligibilityAppointmentSummary,
  type EligibilityCardAuthorizationSummary,
  type EligibilityCardSummary,
  type EligibilityClientSummary,
  type EligibilityExistingAttemptSummary,
  type EligibilityPolicyAckSummary,
  type ManualFeeChargeType,
  type ManualFeeEligibility,
} from "./manual-fee-types";

export {
  MANUAL_FEE_AMOUNT_CEILING_CENTS,
  MANUAL_FEE_INTERNAL_NOTE_MAX_LENGTH,
  type ManualFeeChargeType,
  type ManualFeeEligibility,
} from "./manual-fee-types";

type Args = {
  studioId: string;
  appointmentId: string;
  chargeType: ManualFeeChargeType;
};

type ApptJoin = {
  id: string;
  studio_id: string;
  client_id: string;
  status: string;
  starts_at: string;
  cancelled_at: string | null;
  created_at: string;
  service: { name: string } | { name: string }[] | null;
  client: { id: string; name: string } | { id: string; name: string }[] | null;
};

const ACTIVE_ATTEMPT_STATUSES = new Set([
  "ready",
  "pending_stripe",
  "succeeded",
]);

const reasonToType = (reason: string): ManualFeeChargeType =>
  reason === "no_show_fee" ? "no_show" : "late_cancel";

const pick = <T>(v: T | T[] | null): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : v;

export async function getManualFeeChargeEligibility(
  args: Args,
): Promise<ManualFeeEligibility> {
  const admin = createAdminClient();
  const reasons: string[] = [];
  const livemode = inferStripeLivemode();
  const serverChargeType: ManualFeeChargeType = args.chargeType;

  let appointmentSummary: EligibilityAppointmentSummary | null = null;
  let clientSummary: EligibilityClientSummary | null = null;
  let clientId: string | null = null;

  const { data: apptRow } = await admin
    .from("appointments")
    .select(
      "id, studio_id, client_id, status, starts_at, cancelled_at, created_at, service:services(name), client:clients(id, name)",
    )
    .eq("id", args.appointmentId)
    .eq("studio_id", args.studioId)
    .maybeSingle();

  const appt = apptRow as ApptJoin | null;
  if (!appt) {
    reasons.push("Appointment not found for this studio.");
  } else {
    clientId = appt.client_id;
    const service = pick(appt.service);
    const client = pick(appt.client);
    appointmentSummary = {
      id: appt.id,
      status:
        appt.status === "cancelled" || appt.status === "no_show"
          ? appt.status
          : "other",
      starts_at: appt.starts_at,
      cancelled_at: appt.cancelled_at,
      created_at: appt.created_at,
      service_name: service?.name ?? null,
    };
    clientSummary = client ? { id: client.id, name: client.name } : null;

    const allowedStatusChargePairs: Record<
      string,
      ReadonlySet<ManualFeeChargeType>
    > = {
      cancelled: new Set(["late_cancel"]),
      no_show: new Set(["no_show"]),
    };
    if (!allowedStatusChargePairs[appt.status]?.has(serverChargeType)) {
      reasons.push(
        serverChargeType === "late_cancel"
          ? "Late cancellation fee requires a cancelled appointment."
          : "No-show fee requires a no-show appointment.",
      );
    }
  }

  let cardSummary: EligibilityCardSummary | null = null;
  let cardSignatureId: string | null = null;
  let cardPaymentMethodId: string | null = null;
  if (clientId) {
    const { data: cardRow } = await admin
      .from("client_payment_methods")
      .select(
        "id, brand, last4, exp_month, exp_year, status, stripe_livemode, card_authorization_signature_id",
      )
      .eq("studio_id", args.studioId)
      .eq("client_id", clientId)
      .eq("status", "active")
      .eq("stripe_livemode", livemode)
      .maybeSingle();
    if (!cardRow) {
      reasons.push(
        "No card on file. Ask the client to open their portal and add a card. They must first sign card authorization in the portal before the Add card option appears.",
      );
    } else {
      cardSummary = {
        id: cardRow.id,
        brand: cardRow.brand,
        last4: cardRow.last4,
        exp_month: cardRow.exp_month,
        exp_year: cardRow.exp_year,
      };
      cardPaymentMethodId = cardRow.id;
      if (!cardRow.card_authorization_signature_id) {
        reasons.push(
          "Card authorization not signed. The client must sign card authorization in the portal before a card can be added or a manual fee can be prepared.",
        );
      } else {
        cardSignatureId = cardRow.card_authorization_signature_id;
      }
    }
  }

  let cardAuthorizationSummary: EligibilityCardAuthorizationSummary | null =
    null;
  if (cardSignatureId && clientId) {
    const { data: sigRow } = await admin
      .from("client_consent_signatures")
      .select(
        "id, signed_at, signature_name, template_title_snapshot, template_id, template_version, studio_id, client_id",
      )
      .eq("id", cardSignatureId)
      .eq("studio_id", args.studioId)
      .eq("client_id", clientId)
      .maybeSingle();
    if (!sigRow) {
      reasons.push(
        "Card authorization signature missing or not scoped to this client.",
      );
    } else {
      const { data: liveTemplate } = await admin
        .from("consent_form_templates")
        .select("id, version")
        .eq("id", sigRow.template_id)
        .eq("studio_id", args.studioId)
        .eq("is_live", true)
        .eq("status", "active")
        .eq("form_type", "card_authorization")
        .maybeSingle();
      if (!liveTemplate) {
        reasons.push(
          "Card authorization template is no longer live. Ask the client to open their portal and sign the current card authorization.",
        );
      } else if (sigRow.template_version !== liveTemplate.version) {
        reasons.push(
          "Card authorization on file is out of date. Ask the client to open their portal and sign the updated card authorization.",
        );
      } else {
        cardAuthorizationSummary = {
          signature_id: sigRow.id,
          signed_at: sigRow.signed_at,
          signature_name: sigRow.signature_name,
          template_title_snapshot: sigRow.template_title_snapshot,
        };
      }
    }
  }

  let policyAckSummary: EligibilityPolicyAckSummary | null = null;
  let policyAckId: string | null = null;
  let policySnapshotHash: string | null = null;
  if (clientId) {
    const { data: ackRow } = await admin
      .from("appointment_policy_acknowledgements")
      .select("id, acknowledged_at, policy_snapshot_hash")
      .eq("studio_id", args.studioId)
      .eq("appointment_id", args.appointmentId)
      .eq("client_id", clientId)
      .order("acknowledged_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!ackRow) {
      reasons.push("No policy acknowledgement found for this appointment.");
    } else {
      policyAckSummary = {
        id: ackRow.id,
        acknowledged_at: ackRow.acknowledged_at,
        policy_snapshot_hash: ackRow.policy_snapshot_hash,
      };
      policyAckId = ackRow.id;
      policySnapshotHash = ackRow.policy_snapshot_hash;
    }
  }

  let amountCents: number | null = null;
  let currency: string | null = null;
  const { data: studioRow } = await admin
    .from("studios")
    .select("late_cancel_fee_cents, no_show_fee_cents")
    .eq("id", args.studioId)
    .maybeSingle();
  if (!studioRow) {
    reasons.push("Studio not found.");
  } else {
    const cents =
      serverChargeType === "late_cancel"
        ? studioRow.late_cancel_fee_cents
        : studioRow.no_show_fee_cents;
    if (cents == null || cents === 0) {
      reasons.push(
        serverChargeType === "late_cancel"
          ? "Late cancellation fee amount is not configured."
          : "No-show fee amount is not configured.",
      );
    } else if (cents < 0 || cents > MANUAL_FEE_AMOUNT_CEILING_CENTS) {
      reasons.push("Configured fee amount is outside the allowed range.");
    } else {
      amountCents = cents;
      currency = "cad";
    }
  }

  const [{ data: canonicalRows }, { data: legacyRows }] = await Promise.all([
    admin
      .from("payment_charge_attempts")
      .select(
        "id, charge_reason, status, amount_cents, currency, created_at, stripe_payment_intent_id, stripe_charge_id, charged_at, failed_at, failure_code, failure_message_safe, cancelled_at, cancelled_reason, refund_status, refunded_at, receipt_sent_at",
      )
      .eq("studio_id", args.studioId)
      .eq("appointment_id", args.appointmentId)
      .in("charge_reason", ["no_show_fee", "late_cancellation_fee"])
      .eq("stripe_livemode", livemode)
      .order("created_at", { ascending: false }),
    admin
      .from("manual_fee_charge_attempts")
      .select(
        "id, charge_type, status, amount_cents, currency, created_at, stripe_payment_intent_id, stripe_charge_id, charged_at, failed_at, failure_code, failure_message, cancelled_at, cancelled_reason",
      )
      .eq("studio_id", args.studioId)
      .eq("appointment_id", args.appointmentId)
      .order("created_at", { ascending: false }),
  ]);

  const canonicalAttemptSummaries: EligibilityExistingAttemptSummary[] =
    (canonicalRows ?? []).map((row) => ({
      id: row.id as string,
      charge_type: reasonToType(row.charge_reason as string),
      status: row.status as string,
      amount_cents: row.amount_cents as number,
      currency: row.currency as string,
      created_at: row.created_at as string,
      stripe_payment_intent_id:
        (row.stripe_payment_intent_id as string | null) ?? null,
      stripe_charge_id: (row.stripe_charge_id as string | null) ?? null,
      charged_at: (row.charged_at as string | null) ?? null,
      failed_at: (row.failed_at as string | null) ?? null,
      failure_code: (row.failure_code as string | null) ?? null,
      failure_message: (row.failure_message_safe as string | null) ?? null,
      cancelled_at: (row.cancelled_at as string | null) ?? null,
      cancelled_reason: (row.cancelled_reason as string | null) ?? null,
      refund_status: (row.refund_status as string | null) ?? null,
      receipt_sent_at: (row.receipt_sent_at as string | null) ?? null,
    }));
  const legacyAttemptSummaries: EligibilityExistingAttemptSummary[] =
    (legacyRows ?? []).map((row) => ({
      id: row.id as string,
      charge_type: row.charge_type as ManualFeeChargeType,
      status: row.status as string,
      amount_cents: row.amount_cents as number,
      currency: row.currency as string,
      created_at: row.created_at as string,
      stripe_payment_intent_id:
        (row.stripe_payment_intent_id as string | null) ?? null,
      stripe_charge_id: (row.stripe_charge_id as string | null) ?? null,
      charged_at: (row.charged_at as string | null) ?? null,
      failed_at: (row.failed_at as string | null) ?? null,
      failure_code: (row.failure_code as string | null) ?? null,
      failure_message: (row.failure_message as string | null) ?? null,
      cancelled_at: (row.cancelled_at as string | null) ?? null,
      cancelled_reason: (row.cancelled_reason as string | null) ?? null,
    }));
  const existingAttempts: EligibilityExistingAttemptSummary[] = [
    ...canonicalAttemptSummaries,
    ...legacyAttemptSummaries,
  ].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  // Keep them visible in existingAttempts, but legacy/test-only rows no longer
  // block current-mode canonical fee attempts.
  const activeCanonicalForType = canonicalAttemptSummaries.find(
    (row) =>
      row.charge_type === serverChargeType &&
      ACTIVE_ATTEMPT_STATUSES.has(row.status),
  );
  if (activeCanonicalForType) {
    reasons.push(
      "An active fee charge attempt already exists for this appointment.",
    );
  }

  if (
    reasons.length === 0 &&
    appointmentSummary &&
    clientSummary &&
    cardSummary &&
    cardPaymentMethodId &&
    cardAuthorizationSummary &&
    policyAckSummary &&
    policyAckId &&
    policySnapshotHash &&
    amountCents != null &&
    currency
  ) {
    return {
      eligible: true,
      cardPaymentMethodId,
      cardAuthorizationSignatureId: cardAuthorizationSummary.signature_id,
      policyAcknowledgementId: policyAckId,
      policySnapshotHash,
      amountCents,
      currency,
      timingClassification: "practitioner_asserted",
      appointment: appointmentSummary,
      client: clientSummary,
      card: cardSummary,
      cardAuthorization: cardAuthorizationSummary,
      policyAcknowledgement: policyAckSummary,
      existingAttempts,
    };
  }

  return {
    eligible: false,
    blockingReasons: reasons,
    appointment: appointmentSummary,
    client: clientSummary,
    card: cardSummary,
    cardAuthorization: cardAuthorizationSummary,
    policyAcknowledgement: policyAckSummary,
    amountCents,
    currency,
    timingClassification: "practitioner_asserted",
    existingAttempts,
  };
}
