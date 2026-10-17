import Stripe from "stripe";

// HON-11 #1. Which Stripe errors PROVE that Stripe did not move money?
//
// Every error the SDK throws is a `Stripe.errors.StripeError`, including the
// two that mean "we do not know what happened": `StripeConnectionError` (the
// request may have reached Stripe and been processed before the connection
// dropped, and the SDK's own retries were exhausted) and `StripeAPIError` (a
// 5xx, or any status the SDK could not map; Stripe may have processed it). The
// charge and refund runners used to send EVERY StripeError down the terminal
// `failed` branch. For a charge that re-offered Prepare, and a new attempt is a
// new idempotency key, so a retry could charge the client a second time; for a
// refund it said "refund failed" when the money may have gone back.
//
// So this is an ALLOW-LIST of definitive refusals, and everything else is an
// unknown outcome. Fail-safe: a subtype added by a future SDK, or one Stripe
// never documents for these calls, lands in manual review, never in `failed`.
//
// Definitive (Stripe answered, and the answer was no):
//   CardError (402)           the card was declined / needs authentication
//   InvalidRequestError (400/404) the request was rejected as malformed
//   AuthenticationError (401) the platform key was refused
//   PermissionError (403)     the key may not act on this account
//   RateLimitError (429)      rejected before processing
//   IdempotencyError          the key was refused for a mismatched replay
export function isDefinitiveStripeRefusal(err: unknown): boolean {
  return (
    err instanceof Stripe.errors.StripeCardError ||
    err instanceof Stripe.errors.StripeInvalidRequestError ||
    err instanceof Stripe.errors.StripeAuthenticationError ||
    err instanceof Stripe.errors.StripePermissionError ||
    err instanceof Stripe.errors.StripeRateLimitError ||
    err instanceof Stripe.errors.StripeIdempotencyError
  );
}
