// PAY-CCY-01 (#824). THE PREPARED ATTEMPT OWNS THE MONEY FACTS.
//
// A payment_charge_attempts row fixes, when it is prepared, exactly what is to
// be charged: an integer number of minor units (`amount_cents`) and a lower-case
// ISO 4217 currency (`currency`). Everything after that records a PROVIDER
// object onto the row: the synchronous charge, the reconcile re-read, the
// refund, and the three webhook reconcilers. Until this module none of them
// asked whether the provider's object was about the same money. The charge was
// created from the row, so in the ordinary flow it always was. But "always was"
// is an assumption about the provider, and the moment a studio can charge in a
// second currency it stops being a safe one: a webhook, a stale PaymentIntent
// id or a reused idempotency key that names different money would have been
// recorded as this attempt's success, refund or failure.
//
// So every writer asks one question first: do the provider's amount and
// currency equal the prepared ones, exactly? A different amount, a different
// currency, or a value the provider did not state at all is a MISMATCH. The
// writer then records nothing from that object and raises a critical alert,
// because a provider object that disagrees with the prepared facts is either
// not this attempt's charge or not a charge Hone can describe truthfully.
//
// Nothing here converts, rounds or defaults. There is no FX and no "close
// enough": 10000 cad and 10000 usd are different money, and so are 10000 and
// 10001 of the same currency.
//
// Pure and framework-free, so it is unit-tested directly.

/** The facts a prepared attempt row holds. Read from the row, never a form. */
export type PreparedMoney = {
  amountCents: unknown;
  currency: unknown;
};

/** The facts a Stripe PaymentIntent, Charge or Refund states. */
export type ProviderMoney = {
  amount: unknown;
  currency: unknown;
};

export type ProviderMoneyMismatch =
  // The provider stated a different integer amount.
  | "amount_mismatch"
  // The provider stated a different currency.
  | "currency_mismatch"
  // The provider stated no usable integer amount.
  | "amount_unreadable"
  // The provider stated no usable currency code.
  | "currency_unreadable"
  // The ROW itself is not usable. Columns are NOT NULL, so this is defensive:
  // a row that cannot say what it prepared cannot vouch for anything.
  | "prepared_unreadable";

export type ProviderMoneyVerdict =
  | { ok: true }
  | { ok: false; mismatches: ProviderMoneyMismatch[] };

// Three lower-case letters. Stripe states currencies this way and the ledger's
// CHECK stores them this way; anything else is not a code this path can trust.
const CURRENCY_CODE = /^[a-z]{3}$/;

function normalizeCurrency(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Case is the ONLY normalisation. Stripe already answers in lower case, so
  // this changes nothing in practice; it exists so that an upper-case spelling
  // of the SAME code is not reported as different money. A different code is
  // still different money.
  const code = raw.trim().toLowerCase();
  return CURRENCY_CODE.test(code) ? code : null;
}

function normalizeAmount(raw: unknown): number | null {
  return typeof raw === "number" && Number.isSafeInteger(raw) ? raw : null;
}

/**
 * Compare a provider object's money to the prepared attempt's.
 *
 * Every applicable mismatch is reported, not just the first, so an alert can
 * name all of them.
 */
export function compareProviderMoney(
  prepared: PreparedMoney,
  provider: ProviderMoney,
): ProviderMoneyVerdict {
  const preparedAmount = normalizeAmount(prepared.amountCents);
  const preparedCurrency = normalizeCurrency(prepared.currency);
  if (preparedAmount === null || preparedCurrency === null) {
    return { ok: false, mismatches: ["prepared_unreadable"] };
  }

  const mismatches: ProviderMoneyMismatch[] = [];
  const providerAmount = normalizeAmount(provider.amount);
  const providerCurrency = normalizeCurrency(provider.currency);

  if (providerAmount === null) {
    mismatches.push("amount_unreadable");
  } else if (providerAmount !== preparedAmount) {
    mismatches.push("amount_mismatch");
  }
  if (providerCurrency === null) {
    mismatches.push("currency_unreadable");
  } else if (providerCurrency !== preparedCurrency) {
    mismatches.push("currency_mismatch");
  }

  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
}

/**
 * The safe, flat alert payload for a mismatch: the reasons plus both sides'
 * amount and currency, coerced to number | string | null so a provider object
 * can never smuggle a nested payload into an ops alert. No identity, card or
 * client data is involved.
 */
export function providerMoneyMismatchDetails(
  prepared: PreparedMoney,
  provider: ProviderMoney,
  mismatches: ProviderMoneyMismatch[],
): Record<string, unknown> {
  const flat = (v: unknown): number | string | null =>
    typeof v === "number" ? v : typeof v === "string" ? v.slice(0, 16) : null;
  return {
    money_mismatches: mismatches,
    prepared_amount_cents: flat(prepared.amountCents),
    prepared_currency: flat(prepared.currency),
    provider_amount: flat(provider.amount),
    provider_currency: flat(provider.currency),
  };
}
