// PAY-CCY-03 (#824). Owner-facing refusals thrown by lib/stripe/account.ts and
// surfaced verbatim by app/(app)/settings/payments/actions.ts, which lists them
// in SAFE_USER_FACING_MESSAGES. Kept in their own module so a test that mocks
// the account helpers does not have to restate them.

export const ACCOUNT_COUNTRY_MISMATCH_ERROR =
  "This studio's Stripe account is registered in a different country than the studio's payment settings. Contact Hone support; the account will not be replaced automatically.";

export const PAYMENT_COUNTRY_UNVERIFIED_ERROR =
  "Hone could not confirm this studio's payment country. Try again in a moment.";
