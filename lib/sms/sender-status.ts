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
  // THE CHOSEN NUMBER IS GONE, AND THIS ATTEMPT CANNOT OUTLIVE IT.
  // `provisioning.ts` fails this one `retryable: false` on purpose — "The owner
  // chose THAT number. We do not quietly hand them another one." The claim's
  // phone number is write-once, so retrying this attempt can only ask about the
  // same vanished number again. The exit is to give the attempt up and choose
  // afresh, which is `releasing`, not `provisioning`.
  number_no_longer_available: "release_only",
  // Search found nothing for the requested country/area code. No number was
  // ever bound, so nothing is stranded and a later search genuinely can
  // succeed — this one really is a retry.
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
  // Bookkeeping around the claim rather than provider conditions — and the two
  // finalize outcomes are NOT the same answer. `provisioning.ts` passes
  // `retryable = (finalized !== "conflict")`, so a plain finalize failure is
  // retryable and a CONFLICT explicitly is not: mismatched identifiers, a
  // resource already held by another studio, or a constraint refusing the
  // write. Reconciliation would return the same resources and hit the same
  // conflict, so this needs looking at, not attempting again.
  finalize_failed: "retry",
  finalize_conflict: "support",
  lease_lost: "retry",
};

/**
 * The outcome of reading this studio's sender.
 *
 * A FAILED READ IS NOT AN ABSENT SENDER, and collapsing the two is a defect
 * this repository has already shipped once and fixed elsewhere:
 * `getAuditEventsByRecord` ignored its `error` and rendered "No history
 * recorded yet." over a read that had failed. The same shape here would have
 * the card assert "No sender configured" — and, worse, "Messages are sent
 * using Hone's shared sender" — while an ACTIVE or ERRORED sender sat behind a
 * transient failure. Those are authoritative claims, and a surface may not make
 * them from a read it did not get.
 *
 * `{ ok: true, sender: null }` means the database answered and there is no
 * live row. `{ ok: false }` means it did not answer.
 */
export type SenderRead =
  | { ok: true; sender: StudioSmsSenderState | null }
  | { ok: false };

export type SenderStatusView = {
  /** The row's status; null when there is no row OR the read did not answer. */
  status: SenderStatus | null;
  /** Coarse grouping for presentation. */
  tone: "none" | "working" | "live" | "attention" | "retired" | "unknown";
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
export function presentSenderStatus(read: SenderRead): SenderStatusView {
  // THE READ DID NOT ANSWER. Say exactly that and claim nothing about whether
  // a sender exists — see SenderRead above for why this branch is separate.
  if (!read.ok) {
    return {
      status: null,
      tone: "unknown",
      headline: "Sender status unavailable",
      detail:
        "Hone could not read this studio's SMS sender just now. Try again in a moment.",
      phoneNumber: null,
      recovery: "none",
      errorCode: null,
      lastTestOkAt: null,
    };
  }

  const row = read.sender;
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
        // Says what happens NOW as well as what happened. This branch is
        // reached when a studio released its number and has not started a
        // replacement, so it is a current-state answer, not just a history
        // note — and an owner reading only "this number was given up" would be
        // left with the same "are my texts going out?" question the empty
        // state exists to answer.
        detail:
          "This number was given up and is never reused. Messages are sent using Hone's shared sender.",
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
 * `{ ok: true, sender: null }` covers both "no row" and "the caller may not see
 * one", deliberately: RLS returns nothing in either case, so a non-owner learns
 * nothing about whether a sender exists. Both are genuine answers from the
 * database.
 *
 * A FAILED read is `{ ok: false }` — a different answer, never `sender: null`.
 * It still does not throw: this is a status panel on a settings page and must
 * never be the reason the page 500s. But it must not launder a failure into a
 * confident claim about sender state either.
 */
export async function readOwnStudioSmsSender(
  client: SupabaseClient,
  studioId: string,
): Promise<SenderRead> {
  // ONE QUERY, AND THE ORDERING IS THE WHOLE TRICK.
  //
  // 0191 keeps released senders as history — `one_live_per_studio` is unique
  // only `where status <> 'released'`, so a studio has at most ONE live row but
  // unboundedly many released ones. An earlier revision filtered released rows
  // out entirely, which made "released, no replacement yet" render as "No
  // sender configured" and left the presenter's `released` branch unreachable.
  // Unreachable code that tests exercise directly is worse than either fixing
  // it or deleting it, because the suite then proves a state production cannot
  // show.
  //
  // `released_evidence_check` guarantees `released_at IS NOT NULL` exactly when
  // the status is `released`, so "live" and "released_at IS NULL" are the same
  // set. Ordering by `released_at` DESC with NULLS FIRST therefore puts the live
  // row first when one exists, and otherwise the most recently released row —
  // which is precisely the precedence wanted, without a second round trip.
  const { data, error } = await client
    .from("studio_sms_senders")
    .select(OWNER_READABLE_SENDER_COLUMNS.join(", "))
    .eq("studio_id", studioId)
    .order("released_at", { ascending: false, nullsFirst: true })
    .limit(1)
    .maybeSingle();

  if (error) return { ok: false };
  return { ok: true, sender: (data as StudioSmsSenderState | null) ?? null };
}
