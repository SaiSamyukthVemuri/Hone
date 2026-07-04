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
//   * A test-mode disclaimer in both subject and body. The receipt
//     is sent only when the row's stripe_livemode = false, which
//     is structurally enforced by the
//     payment_charge_attempts_livemode_false_check CHECK (PR #171
//     migration 0073). The disclaimer in the body keeps that
//     posture visible to the client.
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
//   * No "tax receipt" or "official invoice" wording. The
//     subject is "Receipt" + the test-mode prefix.
//   * No refund policy. Refunds are deferred (docs/16 §5.5,
//     blocker for live payments); the body says so plainly.
//   * No live-payment claim. The disclaimer "Stripe test-mode
//     charge -- no live card was charged" appears in both the
//     subject and the body.
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
// A future live-mode receipt PR will adjust the disclaimer
// language but should reuse this shell so the visual look is
// uniform across the client email surface.

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

// Disclaimer copy. Pinned by tests in
// tests/lib/email/payment-receipt.test.ts so the truthful
// posture cannot drift. The disclaimer is the load-bearing piece
// that keeps the email honest while live mode is structurally
// disabled.
const TEST_MODE_BODY_DISCLAIMER =
  "This is a Stripe test-mode receipt. No live card was charged.";
const NO_TAX_BODY_DISCLAIMER =
  "No tax calculation is included on this receipt.";
// PR #181. Updated from the pre-PR-#178 wording. PR #178 shipped a
// test-mode manual refund path on payment_charge_attempts; the
// receipt body must reflect that capability honestly. The truthful
// posture stays test-mode-only: the disclaimer says the
// PRACTITIONER (not the client) can issue a refund, mirroring the
// Hone-only audience for the refund affordance, and stays scoped
// to "test payment" so the test-mode posture is not blurred.
const REFUND_AVAILABLE_BODY_DISCLAIMER =
  "If this test payment needs to be refunded, the practitioner can issue a test-mode refund in Hone.";

// Live-mode receipt copy — LAWYER-APPROVED (2026-07-04). It makes no
// tax-invoice claim, promises no refund, and states Hone is the software
// platform and not the treatment provider or merchant of record. Tests pin
// this exact wording + the absence of tax-invoice / merchant-of-record /
// refund-promise phrasing.
const LIVE_BODY_LEAD = (studio: string) =>
  `This receipt confirms that a card payment was processed by ${studio}.`;
const LIVE_TAX_DISCLAIMER = (studio: string) =>
  `This receipt confirms payment only. It is not a tax invoice unless ${studio} separately states that tax is included or provides a separate tax invoice.`;
const LIVE_SUPPORT_BODY_LINE = (studio: string) =>
  `For questions about this payment, refund eligibility, cancellation fees, no-show fees, or services provided, please contact ${studio} directly.`;
const LIVE_PLATFORM_NOTE =
  "Hone is the software platform used by the studio and is not the treatment provider or merchant of record.";

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
  const studio = input.studioName.trim() || "your studio";
  const client = input.clientName.trim() || "there";
  const amount = formatAmount(input.amountCents, input.currencyCode);
  const reason = input.chargeReasonLabel.trim() || "Payment";
  const charged = formatChargedAt(input.chargedAt);
  const piId = input.stripePaymentIntentId;
  const chargeId = input.stripeChargeId;
  const contact = input.studioContactEmail?.trim() || null;
  const livemode = input.livemode === true;
  const last4 = input.last4?.trim() || null;
  // Neutral fallback when the card last-4 is unavailable — never blocks the
  // receipt over a missing display detail. Never a full card number.
  const paymentMethod = last4 ? `Card ending in ${last4}` : "Card on file";

  // Mode-gated copy. TEST branch: unchanged test-mode wording. LIVE branch:
  // lawyer-approved wording (no tax-invoice claim, no refund promise, states
  // Hone is not the merchant of record).
  const leadDisclaimer = livemode
    ? LIVE_BODY_LEAD(studio)
    : TEST_MODE_BODY_DISCLAIMER;
  const taxDisclaimer = livemode
    ? LIVE_TAX_DISCLAIMER(studio)
    : NO_TAX_BODY_DISCLAIMER;
  const supportLine = livemode
    ? LIVE_SUPPORT_BODY_LINE(studio)
    : REFUND_AVAILABLE_BODY_DISCLAIMER;

  // Subject: TEST MODE prefix while in test mode; the live subject is the
  // lawyer-approved "Receipt from {studio}: {reason} {amount}".
  const subject = livemode
    ? `Receipt from ${studio}: ${reason} ${amount}`
    : `TEST MODE receipt from ${studio}: ${reason} ${amount}`;

  // Detail block differs by mode: the live receipt shows the payment method
  // (card last-4) and no Stripe ids; the test receipt keeps the PI/Charge ids.
  const detailLines = livemode
    ? [
        `Studio: ${studio}`,
        `Amount: ${amount}`,
        `Reason: ${reason}`,
        `Date: ${charged}`,
        `Payment method: ${paymentMethod}`,
      ]
    : [
        `Studio: ${studio}`,
        `Reason: ${reason}`,
        `Amount: ${amount}`,
        `Charged: ${charged}`,
        `PaymentIntent: ${piId}`,
        ...(chargeId ? [`Charge: ${chargeId}`] : []),
      ];

  const lines: string[] = [`Hi ${client},`, "", leadDisclaimer, "", ...detailLines];
  if (contact) {
    lines.push("", `Questions? Contact ${studio} at ${contact}.`);
  }
  lines.push("", taxDisclaimer, supportLine);
  if (livemode) {
    lines.push("", LIVE_PLATFORM_NOTE);
  }
  lines.push("", `${studio} via Hone`);
  const text = lines.join("\n") + "\n";

  const studioH = escapeHtml(studio);
  const clientH = escapeHtml(client);
  const reasonH = escapeHtml(reason);
  const amountH = escapeHtml(amount);
  const chargedH = escapeHtml(charged);
  const piIdH = escapeHtml(piId);
  const chargeIdH = chargeId ? escapeHtml(chargeId) : null;
  const contactH = contact ? escapeHtml(contact) : null;
  const headline = livemode ? "Receipt" : `Receipt from ${studioH}.`;
  const detailRowsHtml = livemode
    ? `<strong>Studio:</strong> ${studioH}<br/>
          <strong>Amount:</strong> ${amountH}<br/>
          <strong>Reason:</strong> ${reasonH}<br/>
          <strong>Date:</strong> ${chargedH}<br/>
          <strong>Payment method:</strong> ${escapeHtml(paymentMethod)}`
    : `<strong>Studio:</strong> ${studioH}<br/>
          <strong>Reason:</strong> ${reasonH}<br/>
          <strong>Amount:</strong> ${amountH}<br/>
          <strong>Charged:</strong> ${chargedH}<br/>
          <strong>PaymentIntent:</strong> <span style="font-family:monospace; word-break:break-all;">${piIdH}</span>
          ${chargeIdH ? `<br/><strong>Charge:</strong> <span style="font-family:monospace; word-break:break-all;">${chargeIdH}</span>` : ""}`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(subject)}</title></head>
<body style="margin:0; padding:0; background:#FAFAF7; color:#0A0A0A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF7; padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:24px; font-family:Georgia, serif; font-weight:700; font-size:18px; letter-spacing:-0.02em;">Hone</td></tr>
        <tr><td style="padding-bottom:16px; font-family:Georgia, serif; font-weight:700; font-size:28px; letter-spacing:-0.02em; line-height:1.15;">
          ${headline}
        </td></tr>
        <tr><td style="padding-bottom:16px; font-family:-apple-system, system-ui, sans-serif; font-size:16px; line-height:1.6;">
          Hi ${clientH},
        </td></tr>
        <tr><td style="padding-bottom:16px; font-family:-apple-system, system-ui, sans-serif; font-size:14px; line-height:1.6; color:#6B6B6B;">
          ${escapeHtml(leadDisclaimer)}
        </td></tr>
        <tr><td style="padding:16px 0; border-top:1px solid #E5E2DA; border-bottom:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:14px; line-height:1.8;">
          ${detailRowsHtml}
        </td></tr>
        ${
          contactH
            ? `<tr><td style="padding-top:20px; font-family:-apple-system, system-ui, sans-serif; font-size:14px; line-height:1.6;">
              Questions? Contact ${studioH} at <a href="mailto:${contactH}" style="color:#0A0A0A;">${contactH}</a>.
            </td></tr>`
            : ""
        }
        <tr><td style="padding-top:20px; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.6; color:#6B6B6B;">
          ${escapeHtml(taxDisclaimer)}
        </td></tr>
        <tr><td style="padding-top:8px; font-family:-apple-system, system-ui, sans-serif; font-size:13px; line-height:1.6; color:#6B6B6B;">
          ${escapeHtml(supportLine)}
        </td></tr>
        ${
          livemode
            ? `<tr><td style="padding-top:8px; font-family:-apple-system, system-ui, sans-serif; font-size:12px; line-height:1.6; color:#9A9A9A;">
          ${escapeHtml(LIVE_PLATFORM_NOTE)}
        </td></tr>`
            : ""
        }
        <tr><td style="padding-top:24px; border-top:1px solid #E5E2DA; font-family:-apple-system, system-ui, sans-serif; font-size:11px; letter-spacing:0.15em; text-transform:uppercase; color:#6B6B6B;">
          ${studioH} via Hone
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
