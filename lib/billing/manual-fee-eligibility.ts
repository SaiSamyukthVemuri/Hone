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
// Re-export the symbols server-side code already imports from this
// module so existing call sites keep working without touching them.
export {
  MANUAL_FEE_AMOUNT_CEILING_CENTS,
  MANUAL_FEE_INTERNAL_NOTE_MAX_LENGTH,
  type ManualFeeChargeType,
  type ManualFeeEligibility,
} from "./manual-fee-types";

// ---------------------------------------------------------------------------
// Manual fee charge eligibility (PR #145).
// ---------------------------------------------------------------------------
//
// Pure server-side helper. Decides whether a cancelled or no-show
// appointment is eligible for the practitioner to prepare a manual
// cancellation/no-show fee charge. v1 only PREPARES; the actual Stripe
// charge will live in a follow-up PR. This helper exists so the
// preview UI, the prepare action, and that future Stripe-charge action
// all see the same eligibility decision computed exactly once per
// (appointment, charge_type).
//
// Evidence Hone requires before any charge is allowed:
//   1. The appointment is cancelled or no_show (status check).
//   2. An ACTIVE client_payment_methods row matches (studio_id, client_id)
//      and the current environment's Stripe livemode. The card row must
//      carry a non-null card_authorization_signature_id.
//   3. The client_consent_signatures row that the card points at exists
//      and matches the same (studio_id, client_id).
//   4. An appointment_policy_acknowledgements row exists for the
//      appointment scoped to the same (studio_id, client_id).
//   5. The studio has a configured fee amount for the chosen charge_type
//      (late_cancel_fee_cents or no_show_fee_cents).
//   6. No existing 'active' manual_fee_charge_attempts row (i.e. one
//      with status in {ready, pending_stripe, succeeded}) is already
//      sitting against the same (appointment, charge_type) pair.
//
// Timing classification (v1)
// --------------------------
// Hone has cancellation_policy_text and no_show_policy_text on studios
// as free-form text; there is no structured threshold (e.g.
// cancellation_window_hours) yet. The system therefore CANNOT
// mechanically classify "this cancellation crossed the late window".
// v1 records the practitioner's manual assertion of charge_type with a
// surfaced warning. A future PR that adds structured policy thresholds
// can flip this to system_derived.
//
// What this helper does NOT do
// ----------------------------
// * No Stripe call. No PaymentMethod retrieve. No PaymentIntent create.
//   The helper reads only Hone's own tables.
// * No row writes. The prepare action does the writes.
// * No fee currency lookup beyond the launch ceiling. Sam's policy
//   pegs launch currency at 'cad' (also enforced by the table CHECK).
// * No middleware allowlist changes.

type Args = {
  studioId: string;
  appointmentId: string;
  chargeType: ManualFeeChargeType;
};

// Looks up every piece of evidence the prepare path needs. Service-role
// only so the FK targets across client_payment_methods,
// client_consent_signatures, and appointment_policy_acknowledgements
// can all be read in one server call without bumping into the
// authenticated user's row visibility for those rows in particular
// (the appointment detail page already verified studio membership).
export async function getManualFeeChargeEligibility(
  args: Args,
): Promise<ManualFeeEligibility> {
  const admin = createAdminClient();
  const reasons: string[] = [];

  // 1) Appointment + service join.
  const { data: apptRow } = await admin
    .from("appointments")
    .select(
      "id, studio_id, client_id, status, starts_at, cancelled_at, created_at, service:services(name), client:clients(id, name)",
    )
    .eq("id", args.appointmentId)
    .eq("studio_id", args.studioId)
    .maybeSingle();
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
  const appt = apptRow as ApptJoin | null;

  let appointmentSummary: EligibilityAppointmentSummary | null = null;
  let clientSummary: EligibilityClientSummary | null = null;
  let clientId: string | null = null;
  const serverChargeType: ManualFeeChargeType = args.chargeType;
  if (!appt) {
    reasons.push("Appointment not found for this studio.");
  } else {
    clientId = appt.client_id;
    const pick = <T>(v: T | T[] | null): T | null =>
      Array.isArray(v) ? (v[0] ?? null) : v;
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
    clientSummary = client
      ? { id: client.id, name: client.name }
      : null;
    // Positive allowlist for (status, charge_type) pairs. Any future
    // appointment status (e.g. cancelled_late, rescheduled) defaults
    // to BLOCKED until deliberately added here. The previous
    // asymmetric pair of one-direction `if` checks let a no_show
    // appointment be charged as late_cancel and vice-versa; this
    // table forces both directions to match the billing-evidence rule
    // status=cancelled -> late_cancel, status=no_show -> no_show.
    const ALLOWED_STATUS_CHARGE_PAIRS: Record<
      string,
      ReadonlySet<ManualFeeChargeType>
    > = {
      cancelled: new Set(["late_cancel"]),
      no_show: new Set(["no_show"]),
    };
    if (!ALLOWED_STATUS_CHARGE_PAIRS[appt.status]?.has(serverChargeType)) {
      reasons.push(
        serverChargeType === "late_cancel"
          ? "Late cancellation fee requires a cancelled appointment."
          : "No-show fee requires a no-show appointment.",
      );
    }
  }

  // 2) Active client_payment_methods row scoped to (studio, client)
  //    and to the current environment's Stripe livemode.
  let cardSummary: EligibilityCardSummary | null = null;
  let cardSignatureId: string | null = null;
  let cardPaymentMethodId: string | null = null;
  const livemode = inferStripeLivemode();
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
      // PR #158. Practitioner-actionable copy. Chloe was seeing the
      // older terse "No active card on file" line and asking "what
      // do I do?" The new copy tells her exactly what to say to the
      // client and what the prerequisite is.
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
        // PR #158. Matches the practitioner-facing copy on the
        // <PaymentMethodCard /> AuthorizationNotSignedBlock so both
        // surfaces say the same thing.
        reasons.push(
          "Card authorization not signed. The client must sign card authorization in the portal before a card can be added or a manual fee can be prepared.",
        );
      } else {
        cardSignatureId = cardRow.card_authorization_signature_id;
      }
    }
  }

  // 3) Card authorization signature lookup. Must match (studio, client).
  let cardAuthorizationSummary: EligibilityCardAuthorizationSummary | null =
    null;
  if (cardSignatureId && clientId) {
    const { data: sigRow } = await admin
      .from("client_consent_signatures")
      .select(
        "id, signed_at, signature_name, template_title_snapshot, studio_id, client_id",
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
      cardAuthorizationSummary = {
        signature_id: sigRow.id,
        signed_at: sigRow.signed_at,
        signature_name: sigRow.signature_name,
        template_title_snapshot: sigRow.template_title_snapshot,
      };
    }
  }

  // 4) Appointment policy acknowledgement scoped to the same triple.
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
      reasons.push(
        "No policy acknowledgement found for this appointment.",
      );
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

  // 5) Fee amount lookup. Pulled from studios.<type>_fee_cents at the
  //    moment of prepare so a later policy edit does not retroactively
  //    rewrite a prepared row's amount (the prepare action snapshots it
  //    onto the row).
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
    // NULL and 0 both block. The DB CHECK on
    // studios.<type>_fee_cents permits 0 for settings/test clearing
    // semantics, but a $0.00 fee must never become a 'ready' attempt
    // because the future Stripe-charge PR would either reject the
    // PaymentIntent or create a confusing zero-dollar charge. Treat
    // NULL and 0 as the same "not configured" block reason so the
    // practitioner sees one calm message.
    if (cents == null || cents === 0) {
      reasons.push(
        serverChargeType === "late_cancel"
          ? "Late cancellation fee amount is not configured."
          : "No-show fee amount is not configured.",
      );
    } else if (
      cents < 0 ||
      cents > MANUAL_FEE_AMOUNT_CEILING_CENTS
    ) {
      reasons.push("Configured fee amount is outside the allowed range.");
    } else {
      amountCents = cents;
      currency = "cad";
    }
  }

  // 6) Existing attempts. Both for the duplicate-protection check and
  //    for surfacing history in the UI.
  const { data: attemptRows } = await admin
    .from("manual_fee_charge_attempts")
    .select(
      "id, charge_type, status, amount_cents, currency, created_at, stripe_payment_intent_id, stripe_charge_id, charged_at, failed_at, failure_code, failure_message, cancelled_at, cancelled_reason",
    )
    .eq("studio_id", args.studioId)
    .eq("appointment_id", args.appointmentId)
    .order("created_at", { ascending: false });
  const existingAttempts: EligibilityExistingAttemptSummary[] = (
    attemptRows ?? []
  ).map((row) => ({
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
  const ACTIVE_STATUSES = new Set([
    "ready",
    "pending_stripe",
    "succeeded",
  ]);
  const activeForType = existingAttempts.find(
    (row) =>
      row.charge_type === serverChargeType && ACTIVE_STATUSES.has(row.status),
  );
  if (activeForType) {
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
