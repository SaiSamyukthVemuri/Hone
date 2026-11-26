import { createHash } from "node:crypto";
import { escapeHtml } from "@/lib/email/markdown-lite";
import type { createBillingStripeClient } from "./billing-client";
import { hostedInvoiceUrl } from "./hosted-invoice-url";
import { planForPriceId, PLANS, type SubscriptionEnv } from "./plans";

export type Notice = {
  id: string;
  lease: string;
  kind: "receipt" | "warning" | "paused";
  invoice_id: string;
  customer_id: string;
  subscription_id: string;
  recipient: string;
  timezone: string | null;
  deadline: string | null;
};
type Invoice = Awaited<
  ReturnType<ReturnType<typeof createBillingStripeClient>["readNoticeInvoice"]>
>;
type Mail = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
};

function date(value: Date, zone: string, clock = false) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(clock
      ? ({ hour: "numeric", minute: "2-digit", timeZoneName: "short" } as const)
      : {}),
  }).format(value);
}

export function subscriptionEmail(
  notice: Notice,
  invoice: Invoice,
  env: SubscriptionEnv,
  billingUrl: string,
  from: string,
): Mail | null {
  if (
    invoice.live ||
    notice.invoice_id !== invoice.id ||
    invoice.customer !== notice.customer_id ||
    invoice.subscription !== notice.subscription_id
  )
    throw new Error("Unexpected billing invoice");
  const zone = notice.timezone || "UTC";
  const money = (cents: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: invoice.currency.toUpperCase(),
      currencyDisplay: "code",
    }).format(cents / 100);
  const hosted = hostedInvoiceUrl(invoice.hostedUrl);
  let subject: string;
  let intro: string;
  let action: string;
  let details: string[];
  if (notice.kind === "receipt") {
    if (invoice.status !== "paid" || invoice.amountPaid <= 0 || !invoice.paidAt)
      throw new Error("Paid invoice unavailable");
    const plan = planForPriceId(invoice.price ?? "", env);
    if (!plan || !invoice.period || !invoice.number)
      throw new Error("Invoice details unavailable");
    subject = "Your Hone subscription receipt";
    intro =
      "We received your payment of " +
      money(invoice.amountPaid) +
      " for Hone " +
      PLANS[plan].label +
      ".";
    details = [
      "Invoice " + invoice.number,
      "Paid on " + date(new Date(invoice.paidAt * 1000), zone),
      "Billing period: " +
        date(new Date(invoice.period.start * 1000), zone) +
        " – " +
        date(new Date(invoice.period.end * 1000), zone),
      "Subtotal: " + money(invoice.subtotal),
      "Tax: " + money(invoice.tax),
      "Total: " + money(invoice.total),
      "Amount paid: " + money(invoice.amountPaid),
    ];
    action = hosted
      ? "View receipt and download PDFs"
      : "View billing and invoices";
  } else {
    // Payment can win at Stripe before its webhook reaches Hone.
    if (invoice.status === "paid" || invoice.status === "void") return null;
    if (
      !["open", "uncollectible"].includes(invoice.status ?? "") ||
      !notice.deadline
    )
      throw new Error("Unpaid invoice unavailable");
    const deadline = date(new Date(notice.deadline), zone, true);
    if (notice.kind === "warning") {
      subject = "Your Hone subscription payment failed";
      intro =
        "We couldn’t collect your monthly subscription payment. Your seven-day grace period ends on " +
        deadline +
        ".";
      details = [
        "You can keep using Hone until then. Pay the outstanding balance before the deadline to keep new bookings and chart entries available.",
      ];
    } else {
      subject = "New bookings and chart entries are paused in Hone";
      intro =
        "Your seven-day grace period ended on " +
        deadline +
        " with an unpaid subscription invoice.";
      details = [
        "You can still view your records and manage billing. Pay your outstanding subscription invoices to resume new bookings and chart entries in the same studio.",
      ];
    }
    details.push(
      "Outstanding on this invoice: " + money(invoice.amountRemaining),
    );
    action = hosted ? "Pay invoice" : "Manage billing and invoices";
  }
  const target = hosted ?? billingUrl;
  const lines = [intro, ...details];
  const text = [
    subject,
    "",
    ...lines,
    "",
    action + ": " + target,
    "Billing settings: " + billingUrl,
  ].join("\n");
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#fafaf7;color:#161615;font-family:Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #e5e2da;border-radius:12px">
<tr><td style="padding:28px">
<strong style="font-size:20px">Hone</strong>
<h1 style="margin:28px 0 12px;font-size:24px;line-height:1.25">${escapeHtml(subject)}</h1>
<p style="line-height:1.5">${escapeHtml(intro)}</p>
<div style="padding:8px 0;border-top:1px solid #e5e2da;border-bottom:1px solid #e5e2da">
${details.map((line) => '<p style="margin:8px 0;line-height:1.5">' + escapeHtml(line) + "</p>").join("")}
</div>
<p style="margin:24px 0 16px"><a style="display:inline-block;padding:12px 16px;border-radius:6px;background:#181816;color:white;text-decoration:none;font-weight:bold" href="${escapeHtml(target)}">${action}</a></p>
<a style="color:#454542" href="${escapeHtml(billingUrl)}">Billing settings</a>
<p style="margin:24px 0 0;color:#62625f;font-size:12px">Sandbox billing email. No real payment was taken.</p>
</td></tr></table></td></tr></table></body></html>`;
  return {
    from,
    to: notice.recipient,
    subject: "[Test] " + subject,
    html,
    text: text + "\n\nSandbox billing email. No real payment was taken.",
  };
}

export async function deliverSubscriptionNotice(
  notice: Notice,
  input: {
    readInvoice: (id: string) => Promise<Invoice>;
    authorize: (hash: string) => Promise<boolean>;
    finish: () => Promise<boolean>;
    send: (
      mail: Mail,
      key: string,
    ) => Promise<{ data?: { id?: string } | null; error: unknown }>;
    env: SubscriptionEnv;
    billingUrl: string;
    from: string;
  },
) {
  const mail = subscriptionEmail(
    notice,
    await input.readInvoice(notice.invoice_id),
    input.env,
    input.billingUrl,
    input.from,
  );
  if (!mail) return "skipped";
  const hash = createHash("sha256").update(JSON.stringify(mail)).digest("hex");
  if (!(await input.authorize(hash))) return "skipped";
  const result = await input.send(mail, "hone-subscription/" + notice.id);
  if (result.error || !result.data?.id || !(await input.finish()))
    throw new Error("Billing mail unconfirmed");
  return "accepted";
}
