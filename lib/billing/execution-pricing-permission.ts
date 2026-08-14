import {
  loadFailureMessage,
  type AuthoritativeAmountLoad,
} from "@/lib/billing/authoritative-session-payment";
import { unresolvedAmountMessage } from "@/lib/billing/session-payment-amount";

// FREE-01 / review 3777447035. THE execution permission rule, in one place.
//
// Three review rounds narrowed the same semantic question: "what happens when
// the current price disagrees with the stored attempt?", and each round closed
// one more branch by hand: first `free`, then the unresolved-context paths. The
// remaining hole was structural rather than a missing branch: execution asked
// "is it free?" and treated every other answer as permission. `missing_service`,
// `missing_price` and `ambiguous_custom_pricing` are all `ok: true`, so all
// three still authorized a charge at the stale prepared amount.
//
// So the rule stops being a sequence of refusals and becomes ONE exhaustive
// decision: permission is granted ONLY by a currently authoritative,
// currently chargeable price. Everything else (every present kind and every
// kind added later) is a refusal.
//
// The `switch` below is deliberately exhaustive over SessionPaymentAmountResult
// with NO `default` arm. That is the anti-regression property that a chain of
// `if` refusals could never have: adding a new pricing kind to the union makes
// this file fail to compile, so a new kind cannot silently inherit permission
// to charge. Fail-closed is enforced by the type system, not by remembering.
//
// SCOPE. This is a PERMISSION check, never an amount source. It answers "is
// this session still in a currently authoritative chargeable state?" and
// nothing else. The already-prepared attempt remains the sole execution
// amount: this module deliberately does not read, return, compare or expose
// `amountCents`, so no caller can accidentally use it to reprice.

export type ExecutionPricingPermission =
  | { allow: true }
  | { allow: false; error: string };

// Used when the pricing context could not even be looked up: the attempt row
// did not read, or it carries no trusted session id. Deliberately vague to the
// practitioner (it exposes nothing about another tenant's data) and explicitly
// retryable, because the safe answer to "I cannot tell" is "not now".
export const PRICING_UNCONFIRMED_ERROR =
  "The current price for this session could not be confirmed, so this charge was not run. Please try again.";

/**
 * Decide whether an ALREADY-PREPARED attempt may be executed, given the
 * CURRENT authoritative pricing for its session.
 *
 * Pass `null` when the pricing context could not be established at all (the
 * attempt row failed to read, or carried no trusted session id).
 *
 * resolved                  -> MAY execute, at the prepared amount
 * free                      -> block, with "no payment required" copy
 * missing_service           -> block
 * missing_price             -> block
 * ambiguous_custom_pricing  -> block
 * load/context failure      -> block
 * no pricing context at all -> block
 */
export function decideExecutionPricingPermission(
  load: AuthoritativeAmountLoad | null,
): ExecutionPricingPermission {
  if (load === null) {
    return { allow: false, error: PRICING_UNCONFIRMED_ERROR };
  }
  if (!load.ok) {
    return { allow: false, error: loadFailureMessage(load.failure) };
  }

  const result = load.result;
  switch (result.kind) {
    // The ONLY path to permission.
    case "resolved":
      return { allow: true };

    // A currently free visit must never be charged, whatever was prepared.
    case "free":
      return {
        allow: false,
        error: `${result.serviceName} is free. No payment is required, so this charge was not run.`,
      };

    // Pricing that cannot currently be established is NOT permission. These
    // are `ok: true` results, which is exactly why they used to fall through.
    case "missing_service":
    case "missing_price":
    case "ambiguous_custom_pricing":
      return { allow: false, error: unresolvedAmountMessage(result) };
  }
}
