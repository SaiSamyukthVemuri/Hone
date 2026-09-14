import {
  EXTERNALLY_COLLECTED_METHODS,
  SETTLEMENT_BADGE_LABEL,
} from "@/lib/billing/settlement-types";

// ===========================================================================
// PAY-RECEIPT-PDF — the canonical receipt, rendered three ways
// ===========================================================================
//
// One structure in, three renderings out: HTML, plain text, and PDF. Before
// this module the receipt's FACTS and its WORDING were both computed inside
// the email template, so a PDF would have had to either re-derive them (two
// sources of truth for money) or re-state them (two sources of truth for
// copy). Either is the defect this module exists to prevent: a PDF whose
// amount, date or method disagrees with the email it is attached to.
//
// ---------------------------------------------------------------------------
// THE WORDING IS APPROVED. DO NOT PARAPHRASE IT.
// ---------------------------------------------------------------------------
//
// The live-mode copy below is LAWYER-APPROVED (2026-07-04) and the approval
// record is explicit that "the actual strings in the code are the source of
// truth" (docs/16_LIVE_PAYMENTS_READINESS.md §17.14). Copy sign-off is
// COMPLETE; what remains outstanding for live rollout is the env flip itself
// (Willow's live Connect onboarding + the §17.14 go/no-go), which is a
// SEPARATE authorization and not a copy question.
//
// Consequence for the PDF: it renders the SAME approved strings, from the
// same structure. It does not get its own voice, its own disclaimer, or its
// own summary of the payment. A PDF that says something the approved email
// does not say is unapproved copy, however reasonable it sounds.
//
// ---------------------------------------------------------------------------
// SETTLEMENT IS A DISCRIMINANT, NOT A STRIPE FACT
// ---------------------------------------------------------------------------
//
// A receipt is a record of a PAYMENT, not of a processor. Today only `card`
// is ever constructed; `external` exists so the shape admits cash, e-transfer
// and other-external money without a second receipt model later.
//
// NOTHING WIRES `external` YET, BY DESIGN. Its client-facing copy is NOT
// covered by the 2026-07-04 approval — that approval is specifically about a
// CARD payment ("This receipt confirms that a card payment was processed
// by..."). `buildReceiptDocument` therefore REFUSES to build a live external
// receipt: the shape can be modelled and tested, but unapproved live copy
// cannot be produced even by mistake.
//
// Note also the vocabulary rule this repo already enforces in
// settlement-types.ts: no label says a bare "Paid", because that word is
// reserved for money Hone actually verified. An external receipt inherits
// that constraint.
// ===========================================================================

/** The three settlement methods that mean money was collected, just not by Hone. */
export type ExternallyCollectedMethod =
  (typeof EXTERNALLY_COLLECTED_METHODS)[number];

/**
 * How the money arrived.
 *
 * `card` carries Stripe identity because a card receipt in TEST mode prints
 * the PaymentIntent/Charge ids. The LIVE branch deliberately prints neither —
 * the approved live receipt shows the card last-4 instead.
 */
export type ReceiptSettlement =
  | {
      kind: "card";
      last4: string | null;
      stripePaymentIntentId: string;
      stripeChargeId: string | null;
    }
  | { kind: "external"; method: ExternallyCollectedMethod };

/** Everything a receipt is about. Settlement-agnostic by construction. */
export type ReceiptFacts = {
  studioName: string;
  studioContactEmail: string | null;
  clientName: string;
  reasonLabel: string;
  amountCents: number;
  /** ISO currency code; uppercased for display. */
  currencyCode: string;
  /** When the money was taken. Named for the payment, not for Stripe. */
  paidAt: Date;
  livemode: boolean;
  settlement: ReceiptSettlement;
};

/** One label/value line in the receipt's detail block. */
export type ReceiptDetailRow = {
  label: string;
  value: string;
  /** Stripe ids render monospace in HTML and in the PDF. */
  monospace: boolean;
};

/**
 * The receipt, resolved. Every string a reader will see is already decided
 * here; a renderer chooses typography and escaping, never words.
 */
export type ReceiptDocument = {
  subject: string;
  headline: string;
  greeting: string;
  lead: string;
  detailRows: ReceiptDetailRow[];
  /**
   * The studio contact invitation, carried as PARTS as well as a finished
   * line. HTML linkifies the address; text and PDF print `line`. Both come
   * from this one place, so the sentence cannot drift between renderings.
   */
  contact: { studioName: string; email: string; line: string } | null;
  taxDisclaimer: string;
  supportLine: string;
  platformNote: string | null;
  footer: string;
  /**
   * The studio's display name, carried EXPLICITLY.
   *
   * The PDF leads with it, so it needs the identity as a first-class field
   * rather than reaching into `detailRows` to find the row labelled "Studio"
   * and reading its value. That would couple the document's branding to the
   * order and labelling of a presentation array -- reorder the rows, rename a
   * label, and the receipt silently loses its identity or prints the wrong
   * one. This is the same value the "Studio" row shows, resolved once here.
   */
  studioDisplayName: string;
  /**
   * The PDF's own heading, beneath the studio name.
   *
   * Distinct from `headline`, which the EMAIL uses and which still reads
   * "Receipt" / "Receipt from X.". The PDF is a document a client keeps and
   * may file, so it says what it is in plain words.
   */
  pdfHeading: string;
  /**
   * The PDF's footer attribution.
   *
   * Deliberately NOT `footer` ("<studio> via Hone"), which stays the email's.
   * On the PDF the studio is the identity and Hone is the platform underneath
   * it, so the attribution is subordinate and reads that way.
   */
  pdfFooter: string;
  /**
   * The instant the receipt is ABOUT. Carried so the PDF can pin its metadata
   * timestamps to the payment instead of the clock, which is what makes the
   * same receipt render the same bytes every time.
   */
  issuedAt: Date;
  /** PDF document metadata title. */
  pdfTitle: string;
  /** Attachment filename. Deterministic, and carries no client identity. */
  pdfFileName: string;
};

// --- Copy. Moved here verbatim from the email template. ---------------------
// These strings are pinned by tests/lib/email/payment-receipt.test.ts (via the
// rendered email) and by this module's own suite. Changing one is a copy
// change and needs the sign-off route, not a refactor.

const TEST_MODE_BODY_DISCLAIMER =
  "This is a Stripe test-mode receipt. No live card was charged.";
const NO_TAX_BODY_DISCLAIMER =
  "No tax calculation is included on this receipt.";
const REFUND_AVAILABLE_BODY_DISCLAIMER =
  "If this test payment needs to be refunded, the practitioner can issue a test-mode refund in Hone.";

/** LAWYER-APPROVED 2026-07-04. See the header before touching any of these. */
const LIVE_BODY_LEAD = (studio: string) =>
  `This receipt confirms that a card payment was processed by ${studio}.`;
const LIVE_TAX_DISCLAIMER = (studio: string) =>
  `This receipt confirms payment only. It is not a tax invoice unless ${studio} separately states that tax is included or provides a separate tax invoice.`;
const LIVE_SUPPORT_BODY_LINE = (studio: string) =>
  `For questions about this payment, refund eligibility, cancellation fees, no-show fees, or services provided, please contact ${studio} directly.`;
const LIVE_PLATFORM_NOTE =
  "Hone is the software platform used by the studio and is not the treatment provider or merchant of record.";

/**
 * Plain "$X.XX CAD". Deliberately not Intl.NumberFormat: the receipt surface
 * is English-only today and the format must be deterministic across the email,
 * the PDF and the source-grep tests that pin them.
 */
export function formatReceiptAmount(cents: number, currencyCode: string): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)} ${currencyCode.toUpperCase()}`;
}

/**
 * YYYY-MM-DD HH:MM UTC. Absolute on purpose: a receipt is a record that must
 * read the same wherever it is opened, and the PDF may be opened years later
 * in another timezone.
 */
export function formatReceiptTimestamp(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
}

/** YYYY-MM-DD, for the attachment filename. */
function isoDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Thrown when a live receipt is requested for copy that has no approval. */
export class UnapprovedReceiptCopyError extends Error {
  constructor(method: string) {
    super(
      `No approved live receipt copy exists for settlement method "${method}". ` +
        "The 2026-07-04 sign-off covers CARD payments only.",
    );
    this.name = "UnapprovedReceiptCopyError";
  }
}

export function buildReceiptDocument(facts: ReceiptFacts): ReceiptDocument {
  const livemode = facts.livemode === true;

  // A live receipt for a settlement method with no approved copy is refused
  // structurally. See the header: modelling the shape must not create a way to
  // send unapproved client-facing wording.
  if (livemode && facts.settlement.kind === "external") {
    throw new UnapprovedReceiptCopyError(facts.settlement.method);
  }

  const studio = facts.studioName.trim() || "your studio";
  const client = facts.clientName.trim() || "there";
  const amount = formatReceiptAmount(facts.amountCents, facts.currencyCode);
  const reason = facts.reasonLabel.trim() || "Payment";
  const when = formatReceiptTimestamp(facts.paidAt);
  const contact = facts.studioContactEmail?.trim() || null;

  const detailRows: ReceiptDetailRow[] = [];
  if (livemode) {
    // Approved live detail block: no Stripe ids, card last-4 instead.
    const paymentMethod =
      facts.settlement.kind === "card"
        ? facts.settlement.last4
          ? `Card ending in ${facts.settlement.last4}`
          : // Never blocks a receipt over a missing display detail, and never
            // a full card number.
            "Card on file"
        : SETTLEMENT_BADGE_LABEL[facts.settlement.method];
    detailRows.push(
      { label: "Studio", value: studio, monospace: false },
      { label: "Amount", value: amount, monospace: false },
      { label: "Reason", value: reason, monospace: false },
      { label: "Date", value: when, monospace: false },
      { label: "Payment method", value: paymentMethod, monospace: false },
    );
  } else {
    detailRows.push(
      { label: "Studio", value: studio, monospace: false },
      { label: "Reason", value: reason, monospace: false },
      { label: "Amount", value: amount, monospace: false },
      { label: "Charged", value: when, monospace: false },
    );
    if (facts.settlement.kind === "card") {
      detailRows.push({
        label: "PaymentIntent",
        value: facts.settlement.stripePaymentIntentId,
        monospace: true,
      });
      if (facts.settlement.stripeChargeId) {
        detailRows.push({
          label: "Charge",
          value: facts.settlement.stripeChargeId,
          monospace: true,
        });
      }
    } else {
      detailRows.push({
        label: "Payment method",
        value: SETTLEMENT_BADGE_LABEL[facts.settlement.method],
        monospace: false,
      });
    }
  }

  return {
    subject: livemode
      ? `Receipt from ${studio}: ${reason} ${amount}`
      : `TEST MODE receipt from ${studio}: ${reason} ${amount}`,
    headline: livemode ? "Receipt" : `Receipt from ${studio}.`,
    greeting: `Hi ${client},`,
    lead: livemode ? LIVE_BODY_LEAD(studio) : TEST_MODE_BODY_DISCLAIMER,
    detailRows,
    contact: contact
      ? {
          studioName: studio,
          email: contact,
          line: `Questions? Contact ${studio} at ${contact}.`,
        }
      : null,
    taxDisclaimer: livemode
      ? LIVE_TAX_DISCLAIMER(studio)
      : NO_TAX_BODY_DISCLAIMER,
    supportLine: livemode
      ? LIVE_SUPPORT_BODY_LINE(studio)
      : REFUND_AVAILABLE_BODY_DISCLAIMER,
    platformNote: livemode ? LIVE_PLATFORM_NOTE : null,
    footer: `${studio} via Hone`,
    studioDisplayName: studio,
    pdfHeading: "Payment Receipt",
    pdfFooter: "Powered by Hone",
    issuedAt: facts.paidAt,
    pdfTitle: livemode ? "Receipt" : "TEST MODE receipt",
    // No client name in the filename: it shows in mail clients, download
    // folders and provider logs.
    pdfFileName: `receipt-${isoDate(facts.paidAt)}.pdf`,
  };
}
