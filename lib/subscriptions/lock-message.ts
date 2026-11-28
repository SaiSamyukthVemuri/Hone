// What staff may be told when billing stops new work. The database raises these two codes from the
// booking and session triggers; they are internal and are never shown. The owner reads the actual
// reason on the Billing page.
export const BILLING_LOCK_STAFF_MESSAGE = "Hone can't add new records right now. Please ask the studio owner.";

export function isBillingLockError(error: { message?: string | null } | null | undefined): boolean {
  const message = error?.message ?? "";
  return message.includes("subscription_payment_required") || message.includes("subscription_canceled");
}
