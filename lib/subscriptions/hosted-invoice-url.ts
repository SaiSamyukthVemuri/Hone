function stripeUrl(raw: string | null, origins: readonly string[]): string | null {
  if (!raw || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  return origins.includes(url.origin) && !url.username && !url.password ? url.href : null;
}

export function hostedInvoiceUrl(raw: string | null): string | null {
  return stripeUrl(raw, ["https://invoice.stripe.com"]);
}

export function invoicePdfUrl(raw: string | null): string | null {
  return stripeUrl(raw, ["https://pay.stripe.com", "https://invoice.stripe.com"]);
}
