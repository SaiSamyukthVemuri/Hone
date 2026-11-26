export function hostedInvoiceUrl(raw: string | null): string | null {
  if (!raw || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  return url.origin === "https://invoice.stripe.com" && !url.username && !url.password
    ? url.href
    : null;
}
