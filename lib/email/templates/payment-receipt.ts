// Payment receipt email template (reason-agnostic).
//
// PR #175. Renders a Stripe TEST-MODE receipt for a succeeded row
// on public.payment_charge_attempts. The template is deliberately
// reason-agnostic: the caller passes a chargeReasonLabel string
// resolved from a small map in lib/billing/payment-receipt.ts so
// the same path works for session_payment today, and for
// late_cancellation_fee and no_show_fee when those reasons begin
// writing to the canonical ledger via a future PR.
//
// What this template DOES contain:
//   * Mode-branched on the ROW's stripe_livemode (PR #323): test rows
//     carry the test-mode disclaimer in subject and body; live rows use
//     the lawyer-approved live wording (2026-07-04). The sender passes
//     the attempt row's mode, never the runtime's.
//   * The studio name (from studios.name).
//   * The client's name (greeting only; the body never includes
//     other PII).
//   * The reason label (Session payment / Late cancellation fee /
//     No-show fee / fallback "Payment").
//   * The amount, currency code, and charged-at timestamp.
//   * The Stripe PaymentIntent id (always present for a
//     succeeded row by construction; required by the action
//     before the helper is called).
//   * The Stripe Charge id when the PaymentIntent's
//     latest_charge resolved (often present but not guaranteed
//     in edge cases; the template renders the line only when
//     non-null).
//   * The studio's contact email if available (per the postcare
//     pattern from PR #153 / docs/06 -- postcare_contact_email
//     wins, owner_email is the fallback; null omits the line).
//
// What this template does NOT contain:
//   * No tax calculation. The body explicitly says so to set
//     the right expectation; PR #169's docs/16 §12.8 captures
//     the v1 decision.
//   * No "tax receipt" or "official invoice" wording. The live body
//     carries the approved not-a-tax-invoice disclaimer; the test
//     subject carries the TEST MODE prefix.
//   * No refund policy. Refunds are deferred (docs/16 §5.5,
//     blocker for live payments); the body says so plainly.
//   * The test branch says plainly that no live card was charged;
//     the live branch never carries test wording.
//   * No client portal link, no auth token, no PII beyond the
//     greeting name. This is the same minimal-blast-radius
//     posture the portal magic-link email follows.
//
// Visual style. The template uses the same branded
// table-based shell as portal-magic-link.ts:
//   * #FAFAF7 page background, #0A0A0A ink
//   * Georgia-serif "Hone" wordmark + headline
//   * system sans-serif body
//   * "<studio> via Hone" uppercase caption footer
// Both mode branches reuse this shell so the visual look is uniform
// across the client email surface.

import {
  buildReceiptDocument,
  type ReceiptDocument,
  type ReceiptFacts,
} from "@/lib/billing/receipt-document";

export type PaymentReceiptEmailInput = {
  studioName: string;
  studioContactEmail: string | null;
  clientName: string;
  chargeReasonLabel: string;
  amountCents: number;
  // ISO currency code; today payment_charge_attempts.currency is
  // CHECK'd to 'cad' (migration 0073). The template uppercases
  // the code for display; if a future PR widens the currency
  // CHECK, this code does not need to change.
  currencyCode: string;
  chargedAt: Date;
  stripePaymentIntentId: string;
  stripeChargeId: string | null;
  // Card last-4 for the live receipt's "Payment method: Card ending in {last4}"
  // line (lawyer-approved copy). Display-only, fetched by the sender from the
  // card row scoped to (studio, client, payment method, livemode). Null when
  // unavailable → the receipt renders the neutral "Card on file" fallback.
  // Never contains a full card number or any other card data.
  last4?: string | null;
  // false (the default) renders the test-mode receipt; true renders the
  // lawyer-approved live-mode wording. The sender passes the row's real mode
  // (PR #323); a live receipt is only sent once live rows exist (post env flip).
  livemode?: boolean;
};

export type PaymentReceiptEmail = {
  subject: string;
  html: string;
  text: string;
};

// COPY AND FACTS NOW LIVE IN lib/billing/receipt-document.ts.
//
// PAY-RECEIPT-PDF: the receipt is attached to its own email as a PDF, and the
// PDF must say exactly what the email says. Leaving the wording here would
// have meant either re-deriving the facts for the PDF (two sources of truth
// for money) or re-stating the strings (two sources of truth for approved
// copy). `buildReceiptDocument` now owns both; this file owns HTML only.
//
// The live wording is LAWYER-APPROVED (2026-07-04) and pinned by the tests
// below through the rendered email, which is unchanged byte-for-byte.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Format amount as a plain "$X.XX CAD" string. We do not run
// through Intl.NumberFormat because the email surface is
// English-only today and the format must be deterministic for
// the source-grep tests. A future i18n PR can replace this.
function formatAmount(cents: number, currencyCode: string): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)} ${currencyCode.toUpperCase()}`;
}

function formatChargedAt(d: Date): string {
  // YYYY-MM-DD HH:MM UTC. Avoids local-timezone ambiguity in the
  // email body (the practitioner sees the row's charged_at in
  // their own browser timezone via FormattedDateTime in the
  // succeeded panel; the email is a record that needs to be
  // unambiguous regardless of where it is opened).
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
}

export function buildPaymentReceiptEmail(
  input: PaymentReceiptEmailInput,
): PaymentReceiptEmail {
  return renderReceiptEmail(buildReceiptDocument(toReceiptFacts(input)));
}

/**
 * Adapt the template's historical argument shape to the canonical facts.
 *
 * Kept so every existing caller and test is untouched by the refactor. New
 * callers should build `ReceiptFacts` directly.
 */
export function toReceiptFacts(input: PaymentReceiptEmailInput): ReceiptFacts {
  return {
    studioName: input.studioName,
    studioContactEmail: input.studioContactEmail,
    clientName: input.clientName,
    reasonLabel: input.chargeReasonLabel,
    amountCents: input.amountCents,
    currencyCode: input.currencyCode,
    paidAt: input.chargedAt,
    livemode: input.livemode === true,
    settlement: {
      kind: "card",
      last4: input.last4 ?? null,
      stripePaymentIntentId: input.stripePaymentIntentId,
      stripeChargeId: input.stripeChargeId,
    },
  };
}

/** Render the canonical document as the HTML + text email. Words come from the document. */
export function renderReceiptEmail(doc: ReceiptDocument): PaymentReceiptEmail {
  const subject = doc.subject;

  const lines: string[] = [
    doc.greeting,
    "",
    doc.lead,
    "",
    ...doc.detailRows.map((r) => `${r.label}: ${r.value}`),
  ];
  if (doc.contact) {
    lines.push("", doc.contact.line);
  }
  lines.push("", doc.taxDisclaimer, doc.supportLine);
  if (doc.platformNote) {
    lines.push("", doc.platformNote);
  }
  lines.push("", doc.footer);
  const text = lines.join("\n") + "\n";

  const contactH = doc.contact ? escapeHtml(doc.contact.email) : null;
  const detailRowsHtml = doc.detailRows
    .map((r) => {
      const value = r.monospace
        ? `<span style="font-family:monospace; word-break:break-all;">${escapeHtml(r.value)}</span>`
        : escapeHtml(r.value);
      return `<strong>${escapeHtml(r.label)}:</strong> ${value}`;
    })
    .join("<br/>\n          ");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(doc.subject)}</title></head>
<body style="margin:0; padding:0; background:#FAFAF7; color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7; padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em;">Hone</td></tr>
        <tr><td style="padding-bottom:16px; font-family:Georgia, serif; font-weight:700; font-size:28px; letter-spacing:-0.02em; line-height:1.15;">
          ${escapeHtml(doc.headline)}
        </td></tr>
        <tr><td style="padding-bottom:16px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          ${escapeHtml(doc.greeting)}
        </td></tr>
        <tr><td style="padding-bottom:16px; font-family:-apple-system, system-ui, sans-serif; font-size:14px; line-height:1.6; color:#6B6B6B;">
          ${escapeHtml(doc.lead)}
        </td></tr>
        <tr><td style="padding:16px 0; border-top:1px solid #E5E2DA; border-bottom:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:14px; line-height:1.8;">
          ${detailRowsHtml}
        </td></tr>
        ${
          contactH
            ? `<tr><td style="padding-top:20px; font-family:-apple-system, system-ui, sans-serif; font-size:14px; line-height:1.6;">
              Questions? Contact ${escapeHtml(doc.contact?.studioName ?? "")} at <a href="mailto:${contactH}" style="color:#0A0A0A;">${contactH}</a>.
            </td></tr>`
            : ""
        }
        <tr><td style="padding-top:20px; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.6; color:#6B6B6B;">
          ${escapeHtml(doc.taxDisclaimer)}
        </td></tr>
        <tr><td style="padding-top:8px; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.6; color:#6B6B6B;">
          ${escapeHtml(doc.supportLine)}
        </td></tr>
        ${
          doc.platformNote
            ? `<tr><td style="padding-top:8px; font-family:-apple-system, system-ui, sans-serif; font-size:12px; line-height:1.6; color:#9A9A9A;">
          ${escapeHtml(doc.platformNote)}
        </td></tr>`
            : ""
        }
        <tr><td style="padding-top:24px; border-top:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:11px; letter-spacing:0.15em; text-transform:uppercase; color:#6B6B6B;">
          ${escapeHtml(doc.footer)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text };
}

// Reason-label resolver shared by the email template caller and
// the practitioner UI. Returns a human-readable label for any of
// the three canonical charge reasons (PR #169) + a calm fallback
// so an unknown reason cannot render "undefined" anywhere.
const CHARGE_REASON_LABELS: Record<string, string> = {
  session_payment: "Session payment",
  late_cancellation_fee: "Late cancellation fee",
  no_show_fee: "No-show fee",
};

export function chargeReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "Payment";
  return CHARGE_REASON_LABELS[reason] ?? "Payment";
}
