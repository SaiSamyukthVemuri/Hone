import type { SupabaseClient } from "@supabase/supabase-js";

// SMS SENDER STATUS — the first operator-visible surface for the 0191 lifecycle.
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
// ---------------------------------------------------------------------------
// Hone ships a complete per-studio sender lifecycle — `provisionStudioSmsSender`,
// `adoptExistingStudioSmsSender`, migration 0191's state machine and lease, and
// 0194's outbound resolver — and NOTHING in the running product can reach any of
// it. Measured: zero callers in `app/` and `scripts/` for every one of those
// symbols, and `studio_sms_senders` holds zero rows in production. The blocker
// is a CALLER gap, not a capability gap.
//
// This module is the smallest honest step out of that: it lets a studio owner
// SEE whether their studio has a sender and what state it is in. It reads. That
// is all it does.
//
// It cannot provision, adopt, configure, test, activate, retry or release. It
// constructs no provider — not even the fake — so there is no code path here
// that could become a provider effect if an environment variable changed. The
// controls that drive the machine are later slices; this is the surface they
// will render into, built first so each of them adds one control to a proven
// view rather than inventing its own.
//
// WHY THIS NEEDS NO MIGRATION
// ---------------------------------------------------------------------------
// 0191 already shipped the exact authority this needs, and it is live in
// production (verified against the database, not read off the migration file):
//
//   policy studio_sms_senders_owner_select  SELECT  {authenticated}
//     using (public.is_studio_owner(studio_id))
//
//   grant select (id, studio_id, provider, status, country, requested_area_code,
//                 phone_number, provisioned_at, last_test_ok_at, last_error_code,
//                 last_error_at, released_at, created_at, updated_at)
//     on public.studio_sms_senders to authenticated;
//
// So an owner reads their own row through their ORDINARY session, and the
// database is what enforces it. This module adds no authority of its own and
// must never be given a service-role client.

/**
 * Exactly the columns 0191 grants to `authenticated`, in the order that grant
 * lists them.
 *
 * Spelled here as data rather than inlined into a select string so the guard
 * test can compare this list against the migration and fail when they drift.
 * The columns NOT in this list are the point: `messaging_service_sid`,
 * `phone_number_sid`, `provisioning_claim_key`, `provisioning_lease_generation`
 * and `claimed_phone_number` are readable only by the definer commands, so a
 * provider SID can never become something the browser knows — and therefore
 * never something it can echo back as authority.
 */
export const OWNER_READABLE_SENDER_COLUMNS = [
  "id",
  "studio_id",
  "provider",
  "status",
  "country",
  "requested_area_code",
  "phone_number",
  "provisioned_at",
  "last_test_ok_at",
  "last_error_code",
  "last_error_at",
  "released_at",
  "created_at",
  "updated_at",
] as const;

/** The eight statuses 0191's CHECK constraint allows. */
export const SENDER_STATUSES = [
  "off",
  "selecting",
  "provisioning",
  "active",
  "suspended",
  "error",
  "releasing",
  "released",
] as const;

export type SenderStatus = (typeof SENDER_STATUSES)[number];

/** The owner-readable shape of a `studio_sms_senders` row. */
export type StudioSmsSenderState = {
  id: string;
  studio_id: string;
  provider: string;
  status: SenderStatus;
  country: string | null;
  requested_area_code: string | null;
  phone_number: string | null;
  provisioned_at: string | null;
  last_test_ok_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  released_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * What the operator can do next.
 *
 * Derived from 0191's transition guard, which is the authority — not from what
 * would be convenient to render:
 *
 *   error      -> provisioning | releasing     (NEVER back to `off`)
 *   releasing  -> released | error
 *   released   -> nothing; it is history and is never rewritten
 *
 * `operator_decision` exists because of a storage fact discovered while
 * designing this, and it is the one that matters most — see
 * RECOVERY_ROUTE_BY_ERROR_CODE below.
 */
export type RecoveryRoute =
  | "none"
  | "retry"
  | "operator_decision"
  | "release_only"
  | "support";

/**
 * Stored error code -> what resolves it.
 *
 * THE FINDING THIS TABLE EXISTS TO RECORD. `adoption.ts` refuses with a rich
 * vocabulary — `provider_configuration_required` (the service is real but is
 * not wired the way Hone requires, which #677's configure path is built to
 * repair) is a genuinely different situation from
 * `number_not_owned_by_account` (the account does not hold this number at all,
 * which nothing can repair). But `REFUSAL_TO_STORE_CODE` collapses BOTH — and
 * four more besides — into the single stored code `provider_resource_mismatch`.
 *
 * So the persisted state cannot tell those apart, and any surface reading
 * `last_error_code` alone MUST NOT claim it can. Routing
 * `provider_resource_mismatch` to `retry` would be a lie in the
 * not-owned case; routing it to `none` would recreate exactly the dead end
 * #677 exists to remove, one layer further down.
 *
 * `operator_decision` is the honest third answer: say that the provider
 * resource did not match, say that resolving it is an operator decision rather
 * than a retry, and do not pretend to know which. When the adoption flow goes
 * live, THAT is the lane that must either widen the stored vocabulary or carry
 * the refusal alongside it — and `tests/lib/sms/sender-status.test.ts` pins
 * this so the requirement cannot be quietly dropped.
 */
export const RECOVERY_ROUTE_BY_ERROR_CODE: Record<string, RecoveryRoute> = {
  // Transport and capacity: the same attempt may simply work next time.
  provider_timeout: "retry",
  provider_network: "retry",
  provider_unavailable: "retry",
  provider_rate_limited: "retry",
  // The chosen number is gone, or search found none. A new choice is needed,
  // which from `error` means a fresh provisioning attempt, never a reset.
  number_no_longer_available: "retry",
  no_numbers_available: "retry",
  // Hone is not wired to a provider, or is not authorized against it. An
  // operator cannot fix either from this screen.
  provider_not_configured: "support",
  provider_unauthorized: "support",
  // See the note above: six distinct refusals arrive here as one code.
  provider_resource_mismatch: "operator_decision",
  // The provider answered in a shape we refuse to trust, or rejected us
  // outright. Neither is a retry and neither is self-service.
  provider_response_unparseable: "support",
  provider_rejected: "support",
  provider_error_unspecified: "support",
  // Bookkeeping failures around the claim, not provider conditions.
  finalize_failed: "retry",
  finalize_conflict: "retry",
  lease_lost: "retry",
};

export type SenderStatusView = {
  /** The row, or null when this studio has never had a sender. */
  status: SenderStatus | null;
  /** Coarse grouping for presentation. */
  tone: "none" | "working" | "live" | "attention" | "retired";
  headline: string;
  detail: string;
  /** Owner-safe: a phone number the owner already owns, never a provider SID. */
  phoneNumber: string | null;
  recovery: RecoveryRoute;
  /** Present only when the row records one. Never invented. */
  errorCode: string | null;
  lastTestOkAt: string | null;
};

/**
 * Turn an owner-readable row into what the panel renders.
 *
 * Pure. No I/O, no clock, no provider. Every branch is reachable from a status
 * 0191 permits, and the null case is the one production is actually in today:
 * `studio_sms_senders` holds zero rows, so EVERY studio renders "no sender".
 * That is not a placeholder — it is the true answer, and making it visible is
 * most of this slice's value.
 */
export function presentSenderStatus(
  row: StudioSmsSenderState | null,
): SenderStatusView {
  if (!row) {
    return {
      status: null,
      tone: "none",
      headline: "No sender configured",
      detail:
        "This studio has no SMS sender of its own. Messages are sent using Hone's shared sender.",
      phoneNumber: null,
      recovery: "none",
      errorCode: null,
      lastTestOkAt: null,
    };
  }

  const errorCode = row.last_error_code;
  // An unrecognised code is routed to `support`, never silently to `retry`:
  // the codes are a closed vocabulary in `PROVIDER_ERROR_CODES`, so anything
  // outside it means this table is behind the orchestration, and guessing
  // "try again" would be the expensive direction to be wrong in.
  const recoveryFromError: RecoveryRoute = errorCode
    ? (RECOVERY_ROUTE_BY_ERROR_CODE[errorCode] ?? "support")
    : "support";

  switch (row.status) {
    case "off":
      return {
        status: row.status,
        tone: "none",
        headline: "No sender configured",
        detail:
          "This studio has no SMS sender of its own. Messages are sent using Hone's shared sender.",
        phoneNumber: null,
        recovery: "none",
        errorCode: null,
        lastTestOkAt: null,
      };
    case "selecting":
      return {
        status: row.status,
        tone: "working",
        headline: "Choosing a number",
        detail: "A number has been requested and is not yet reserved.",
        phoneNumber: null,
        recovery: "none",
        errorCode: null,
        lastTestOkAt: null,
      };
    case "provisioning":
      return {
        status: row.status,
        tone: "working",
        headline: "Setting up the sender",
        detail:
          "The number is being set up and tested. It cannot send until that finishes.",
        phoneNumber: row.phone_number,
        recovery: "none",
        errorCode: null,
        lastTestOkAt: null,
      };
    case "active":
      return {
        status: row.status,
        tone: "live",
        headline: "Sender active",
        detail: "This studio has its own number and it has passed a send test.",
        phoneNumber: row.phone_number,
        recovery: "none",
        errorCode: null,
        lastTestOkAt: row.last_test_ok_at,
      };
    case "suspended":
      return {
        status: row.status,
        tone: "attention",
        headline: "Sender suspended",
        detail:
          "This studio's number is not sending. Outbound messages will not leave from it.",
        phoneNumber: row.phone_number,
        recovery: "operator_decision",
        errorCode,
        lastTestOkAt: row.last_test_ok_at,
      };
    case "error":
      return {
        status: row.status,
        tone: "attention",
        headline: "Setup did not finish",
        detail: detailForError(recoveryFromError),
        phoneNumber: row.phone_number,
        recovery: recoveryFromError,
        errorCode,
        lastTestOkAt: row.last_test_ok_at,
      };
    case "releasing":
      return {
        status: row.status,
        tone: "working",
        headline: "Releasing the number",
        detail: "This number is being given up and will not be used again.",
        phoneNumber: row.phone_number,
        recovery: "none",
        errorCode: null,
        lastTestOkAt: null,
      };
    case "released":
      return {
        status: row.status,
        tone: "retired",
        headline: "Number released",
        detail:
          "This number was given up. Released senders are kept as history and are never reused.",
        phoneNumber: row.phone_number,
        recovery: "none",
        errorCode: null,
        lastTestOkAt: null,
      };
  }
}

/**
 * The sentence that goes with a recovery route.
 *
 * `operator_decision` is deliberately the vaguest of the four, because the
 * stored code genuinely does not say more — see RECOVERY_ROUTE_BY_ERROR_CODE.
 * Writing a more specific sentence here would be inventing certainty the data
 * does not carry.
 */
function detailForError(route: RecoveryRoute): string {
  switch (route) {
    case "retry":
      return "Setup stopped part-way and can be attempted again.";
    case "operator_decision":
      return "The phone number or messaging service did not match what Hone expected. Resolving this is a setup decision, not a retry.";
    case "release_only":
      return "This attempt cannot continue. The number can only be given up.";
    case "support":
    case "none":
      return "Setup stopped and cannot be continued from this screen.";
  }
}

/**
 * Read this studio's sender row through the CALLER'S OWN session.
 *
 * `client` must be the request-scoped anon client, never a service-role one:
 * the whole authority argument is that 0191's RLS policy and column grant
 * decide what comes back. A service-role client would bypass both and make
 * this module the thing granting access, which is exactly what it must not be.
 *
 * Returns `null` both when no row exists and when the caller may not see one.
 * Those are deliberately indistinguishable here — a non-owner learns nothing
 * about whether a sender exists, and the panel renders the same honest "no
 * sender configured" either way.
 *
 * A failed read also returns `null` rather than throwing: this is a status
 * panel on a settings page, and it must never be the reason the page 500s.
 */
export async function readOwnStudioSmsSender(
  client: SupabaseClient,
  studioId: string,
): Promise<StudioSmsSenderState | null> {
  const { data, error } = await client
    .from("studio_sms_senders")
    .select(OWNER_READABLE_SENDER_COLUMNS.join(", "))
    .eq("studio_id", studioId)
    .neq("status", "released")
    .maybeSingle();

  if (error) return null;
  return (data as StudioSmsSenderState | null) ?? null;
}
