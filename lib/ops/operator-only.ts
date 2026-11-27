// HON-125. ops_alerts_member_read (0067) lets ANY member of a studio read every row whose studio_id is that studio, with every
// column: client_id, appointment_id, the Stripe ids, manual_fee_attempt_id, message and safe_details. An alert that carries money
// (amounts, a charge, attempt, refund or payment-intent id), a client id, a contact detail (phone, email, name) or a provider's free-text
// error must not be readable that way. Such an alert is routed
// OPERATOR-ONLY: studio_id and client_id are written as NULL (the policy requires studio_id is not null, so no member can read the
// row), and the two ids move into safe_details, which only the operator reads, so the operator keeps the lineage.
//
// Pure and dependency-free so it is trivially testable (tests/lib/ops/operator-only.test.ts). The policy itself is not changed here
// (owner-only read is a migration and a Privacy decision); this closes the exposure at the writer, for every caller, present and future.

export type RoutableAlert = {
  studioId?: string | null;
  clientId?: string | null;
  stripeEventId?: string | null;
  stripePaymentIntentId?: string | null;
  manualFeeAttemptId?: string | null;
  safeDetails?: Record<string, unknown>;
};

// A detail KEY that names money, a payment/client record, or a contact detail. camelCase is normalised to snake_case first.
// Deliberately not "attempt" alone: attempt_count / attempt_number are delivery retries, not payment attempts.
const SENSITIVE_KEY =
  /(^|_)(amount\w*|\w*cents|currency|charge\w*|refund\w*|attempt_id|payment_intent\w*|setup_intent\w*|stripe\w*|customer\w*|client_id|dispute\w*|receipt\w*|price\w*|fee\w*|phone\w*|email\w*|\w*name|balance\w*|total\w*|owed|paid|deposit\w*|tips?)($|_)/;

// A detail KEY that holds a provider's or an exception's FREE TEXT. Provider text can echo the recipient's phone number, email or
// name, so an alert carrying one is operator-only too. Enumerated codes (provider_error_code, failure_class) are not free text.
const FREE_TEXT_KEY = /^(error|err|err_message|error_message|provider_error|provider_message|error_safe|failure_message)$/;

function snake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function hasSensitiveKey(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 4) return false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = snake(k);
    if (SENSITIVE_KEY.test(key) || FREE_TEXT_KEY.test(key)) return true;
    if (hasSensitiveKey(v, depth + 1)) return true;
  }
  return false;
}

export function isMemberSensitiveAlert(input: RoutableAlert): boolean {
  return Boolean(
    input.clientId ||
      input.stripeEventId ||
      input.stripePaymentIntentId ||
      input.manualFeeAttemptId ||
      hasSensitiveKey(input.safeDetails),
  );
}

/** The studio_id, client_id and safe_details to WRITE. Unchanged unless the alert is studio-scoped AND member-sensitive. */
export function routeOperatorOnly(input: RoutableAlert): {
  studioId: string | null;
  clientId: string | null;
  safeDetails: Record<string, unknown> | undefined;
} {
  const studioId = input.studioId ?? null;
  const clientId = input.clientId ?? null;
  if (studioId === null || !isMemberSensitiveAlert(input)) {
    return { studioId, clientId, safeDetails: input.safeDetails };
  }
  const safeDetails: Record<string, unknown> = { ...(input.safeDetails ?? {}) };
  if (safeDetails.studio_id === undefined) safeDetails.studio_id = studioId;
  if (clientId !== null && safeDetails.client_id === undefined) safeDetails.client_id = clientId;
  return { studioId: null, clientId: null, safeDetails };
}
