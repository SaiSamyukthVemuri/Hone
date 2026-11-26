import type Stripe from "stripe";
import { hostedInvoiceUrl, invoicePdfUrl } from "./hosted-invoice-url";

export type InvoiceRow = {
  id: string;
  date: number;
  total: number;
  currency: string;
  status: "paid" | "open" | "uncollectible" | "void";
  pdf: string | null;
  hosted: string | null;
  payable: boolean;
};

export type InvoicePage = { rows: InvoiceRow[]; next: string | null };

function ref(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : value?.id;
}

export async function readBillingProfile(stripe: Stripe, customerId: string, subscriptionId: string) {
  const [customer, sub] = await Promise.all([
    stripe.customers.retrieve(customerId, { expand: ["invoice_settings.default_payment_method", "tax_ids"] }),
    stripe.subscriptions.retrieve(subscriptionId, { expand: ["default_payment_method"] }),
  ]);
  if (customer.deleted || customer.livemode || customer.id !== customerId ||
      sub.livemode || sub.id !== subscriptionId || ref(sub.customer) !== customerId) {
    throw new Error("Unexpected billing profile");
  }
  const method = sub.default_payment_method ?? (sub.default_source ? null : customer.invoice_settings.default_payment_method);
  const hasMethod = Boolean(method || sub.default_source || customer.default_source);
  let card = null;
  if (method && typeof method !== "string") {
    if (method.livemode || ref(method.customer) !== customerId) throw new Error("Unexpected billing method");
    if (method.type === "card" && method.card) {
      const { brand, last4, exp_month, exp_year } = method.card;
      card = { brand, last4, expires: String(exp_month).padStart(2, "0") + "/" + exp_year };
    }
  }
  const item = sub.items.data[0];
  const end = sub.cancel_at ?? (sub.cancel_at_period_end ? item?.current_period_end : null);
  const renews = sub.status === "active" && sub.collection_method === "charge_automatically" &&
    !sub.pause_collection && !end && !sub.cancel_at_period_end && sub.items.data.length === 1
    ? item?.current_period_end : null;
  const taxIds = customer.tax_ids?.data.map(tax => {
    if (ref(tax.customer) !== customerId || tax.livemode) throw new Error("Unexpected tax ID");
    return { type: tax.type.toUpperCase().replaceAll("_", " "), last4: tax.value.slice(-4) };
  });
  return { card, hasMethod, ends: end ?? null, renews: renews ?? null, taxIds: taxIds ?? null };
}

export async function readBillingInvoices(stripe: Stripe, customer: string, subscription: string, after?: string): Promise<InvoicePage> {
  const list = await stripe.invoices.list({ customer, subscription, limit: 6, ...(after && { starting_after: after }) });
  const rows: InvoiceRow[] = [];
  for (const invoice of list.data) {
    if (invoice.livemode || ref(invoice.customer) !== customer || ref(invoice.parent?.subscription_details?.subscription) !== subscription) {
      throw new Error("Unexpected billing invoice");
    }
    if (!invoice.status || invoice.status === "draft") continue;
    rows.push({
      id: invoice.id, date: invoice.effective_at ?? invoice.created, total: invoice.total,
      currency: invoice.currency, status: invoice.status, pdf: invoicePdfUrl(invoice.invoice_pdf ?? null),
      hosted: hostedInvoiceUrl(invoice.hosted_invoice_url ?? null),
      payable: (invoice.status === "open" || invoice.status === "uncollectible") && invoice.amount_remaining > 0,
    });
  }
  return { rows, next: list.has_more ? list.data.at(-1)?.id ?? null : null };
}
