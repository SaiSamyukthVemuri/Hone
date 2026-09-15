import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildReceiptDocument,
  type ReceiptFacts,
} from "@/lib/billing/receipt-document";
import { renderReceiptPdf } from "@/lib/billing/receipt-pdf";
import { buildPaymentReceiptEmail } from "@/lib/email/templates/payment-receipt";
import { extractPdfText, pdfPageCount, pdfTextRuns } from "./helpers/pdf-text";

// ===========================================================================
// PAY-RECEIPT-PDF — the receipt belongs to the STUDIO, not to Hone
// ===========================================================================
//
// The PDF used to open with a fixed "Hone" wordmark and sign off "<studio> via
// Hone". That put the platform's name where the practice's belongs, on a
// document the client keeps, files, and may hand to an insurer. The required
// shape is:
//
//     <STUDIO DISPLAY NAME>
//     Payment Receipt
//
//     [existing canonical receipt content]
//
//     Powered by Hone
//
// The EMAIL is unchanged: it was approved as it stands, and this is a
// PDF-only presentation change.
// ===========================================================================

const facts = (over: Partial<ReceiptFacts> = {}): ReceiptFacts => ({
  studioName: "Willow Electrolysis",
  studioContactEmail: "hello@willowelectrolysis.test",
  clientName: "Dana Reed",
  reasonLabel: "Session payment",
  amountCents: 12500,
  currencyCode: "cad",
  paidAt: new Date("2026-03-04T15:09:00Z"),
  livemode: true,
  settlement: {
    kind: "card",
    last4: "4242",
    stripePaymentIntentId: "pi_live_1",
    stripeChargeId: "ch_live_1",
  },
  ...over,
});

/** Every studio these tests exercise. None of them is special-cased anywhere. */
const STUDIOS: Array<[string, string]> = [
  ["Willow Electrolysis fixture", "Willow Electrolysis"],
  ["a second, unrelated studio", "Northgate Laser & Skin Clinic"],
  ["a unicode studio name", "Café Beauté — Kraków Physiothérapie"],
  [
    "a long studio name",
    "The Very Long Named Physiotherapy & Rehabilitation Centre of Greater Toronto",
  ],
];

describe("the studio leads the document", () => {
  it.each(STUDIOS)("%s is the FIRST thing on the page", async (_label, studioName) => {
    const runs = await pdfTextRuns(
      await renderReceiptPdf(buildReceiptDocument(facts({ studioName }))),
    );
    // First drawn run is the studio, not a platform wordmark.
    expect(runs[0]!.str).not.toBe("Hone");
    expect(studioName.startsWith(runs[0]!.str.trim())).toBe(true);
  });

  it.each(STUDIOS)("%s renders verbatim in the PDF", async (_label, studioName) => {
    const text = await extractPdfText(
      await renderReceiptPdf(buildReceiptDocument(facts({ studioName }))),
    );
    // Compared with whitespace collapsed: a long name legitimately WRAPS onto
    // several lines, so extraction returns it broken by newlines. Asserting on
    // the unwrapped string would be asserting that the name is short.
    const flat = (t: string) => t.replace(/\s+/g, " ");
    expect(flat(text)).toContain(flat(studioName));
  });

  it.each(STUDIOS)("%s is the LARGEST text on the page", async (_label, studioName) => {
    // Primary visual identity is a size claim, not just an ordering claim.
    const runs = await pdfTextRuns(
      await renderReceiptPdf(buildReceiptDocument(facts({ studioName }))),
    );
    const biggest = Math.max(...runs.map((r) => r.size));
    expect(runs[0]!.size).toBe(biggest);
    // ...and strictly larger than the "Payment Receipt" line beneath it.
    const heading = runs.find((r) => r.str.includes("Payment Receipt"));
    expect(heading).toBeTruthy();
    expect(runs[0]!.size).toBeGreaterThan(heading!.size);
  });

  it("'Payment Receipt' sits directly beneath the studio name", async () => {
    const runs = await pdfTextRuns(await renderReceiptPdf(buildReceiptDocument(facts())));
    const headingIndex = runs.findIndex((r) => r.str.includes("Payment Receipt"));
    expect(headingIndex).toBeGreaterThan(0);
    // Nothing but the studio name precedes it.
    for (const before of runs.slice(0, headingIndex)) {
      expect("Willow Electrolysis".includes(before.str.trim())).toBe(true);
    }
    // And it is below the studio name on the page.
    expect(runs[headingIndex]!.y).toBeLessThan(runs[0]!.y);
  });
});

describe("Hone is subordinate attribution, not identity", () => {
  it("'Powered by Hone' is the footer, and it is the LAST run", async () => {
    const runs = await pdfTextRuns(await renderReceiptPdf(buildReceiptDocument(facts())));
    expect(runs.at(-1)!.str).toContain("Powered by Hone");
  });

  it("the footer is among the smallest text on the page", async () => {
    const runs = await pdfTextRuns(await renderReceiptPdf(buildReceiptDocument(facts())));
    const footer = runs.at(-1)!;
    const smallest = Math.min(...runs.map((r) => r.size));
    expect(footer.size).toBeLessThanOrEqual(smallest + 0.01);
    expect(footer.size).toBeLessThan(runs[0]!.size / 2);
  });

  it("the fixed 'Hone' wordmark is GONE from the top of the page", async () => {
    const runs = await pdfTextRuns(await renderReceiptPdf(buildReceiptDocument(facts())));
    // No run is the bare wordmark any more.
    expect(runs.filter((r) => r.str.trim() === "Hone")).toHaveLength(0);
  });

  it.each(STUDIOS)("%s: '<studio> via Hone' never appears in the PDF", async (_l, studioName) => {
    // That string is the EMAIL's sign-off and must not leak into the document.
    const text = await extractPdfText(
      await renderReceiptPdf(buildReceiptDocument(facts({ studioName }))),
    );
    expect(text).not.toContain(`${studioName} via Hone`);
    expect(text).not.toMatch(/ via Hone/);
  });

  it("Hone still appears exactly where it should, and nowhere else", async () => {
    const text = await extractPdfText(await renderReceiptPdf(buildReceiptDocument(facts())));
    const mentions = text.split("\n").filter((l) => l.includes("Hone"));
    // Two: the approved legal sentence, and the footer attribution.
    expect(mentions).toHaveLength(2);
    expect(mentions.some((m) => m.includes("not the treatment provider or merchant of record"))).toBe(true);
    expect(mentions.some((m) => m.includes("Powered by Hone"))).toBe(true);
  });
});

describe("the approved legal sentence is untouched", () => {
  it.each(STUDIOS)("%s: the merchant-of-record sentence is intact", async (_l, studioName) => {
    const text = await extractPdfText(
      await renderReceiptPdf(buildReceiptDocument(facts({ studioName }))),
    );
    expect(text).toContain(
      "Hone is the software platform used by the studio and is not the treatment provider or merchant of record.",
    );
  });

  it("the canonical receipt content still renders", async () => {
    const text = await extractPdfText(await renderReceiptPdf(buildReceiptDocument(facts())));
    for (const expected of [
      "$125.00 CAD",
      "2026-03-04 15:09 UTC",
      "Card ending in 4242",
      "Session payment",
      "not a tax invoice unless",
    ]) {
      expect(text).toContain(expected);
    }
  });
});

describe("identity comes from the document, not from presentation", () => {
  it("the renderer reads studioDisplayName and never mines detailRows for it", () => {
    const src = readFileSync(join(process.cwd(), "lib/billing/receipt-pdf.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).toContain("doc.studioDisplayName");
    // No fishing through the rows for a label.
    expect(code).not.toMatch(/detailRows\.(find|filter)/);
    expect(code).not.toMatch(/label === "Studio"/);
  });

  it("studioDisplayName tracks the fact, and survives the trim fallback", () => {
    expect(buildReceiptDocument(facts({ studioName: "Northgate" })).studioDisplayName).toBe("Northgate");
    expect(buildReceiptDocument(facts({ studioName: "  " })).studioDisplayName).toBe("your studio");
  });

  it("changing ONLY the studio name changes the heading", async () => {
    // Behavioural proof that the identity is wired, not coincidental.
    const a = await extractPdfText(await renderReceiptPdf(buildReceiptDocument(facts({ studioName: "Alpha Clinic" }))));
    const b = await extractPdfText(await renderReceiptPdf(buildReceiptDocument(facts({ studioName: "Beta Clinic" }))));
    expect(a).toContain("Alpha Clinic");
    expect(a).not.toContain("Beta Clinic");
    expect(b).toContain("Beta Clinic");
    expect(b).not.toContain("Alpha Clinic");
  });

  it("NO studio is hard-coded in the generic renderer or document", () => {
    // CODE only. receipt-document.ts mentions Willow once in a COMMENT, naming
    // the outstanding rollout gate (Willow's live Connect onboarding) -- that
    // is release documentation, not a studio baked into the renderer. A guard
    // that trips on prose would force the documentation to be deleted to stay
    // green, which is the wrong trade.
    for (const f of ["lib/billing/receipt-pdf.ts", "lib/billing/receipt-document.ts", "lib/billing/receipt-fonts.ts"]) {
      const code = readFileSync(join(process.cwd(), f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      expect(code).not.toMatch(/Willow/i);
      expect(code).not.toMatch(/Northgate/i);
      expect(code).not.toMatch(/Electrolysis/i);
      // And no studio-specific branching of any kind.
      expect(code).not.toMatch(/studioName\s*===/);
      expect(code).not.toMatch(/studioDisplayName\s*===/);
    }
  });

  it("every long or unicode studio still fits one page", async () => {
    for (const [, studioName] of STUDIOS) {
      expect(await pdfPageCount(await renderReceiptPdf(buildReceiptDocument(facts({ studioName }))))).toBe(1);
    }
  });
});

describe("the EMAIL is untouched by this PDF-only change", () => {
  const emailArgs = {
    studioName: "Willow Electrolysis",
    studioContactEmail: "hello@willowelectrolysis.test",
    clientName: "Dana Reed",
    chargeReasonLabel: "Session payment",
    amountCents: 12500,
    currencyCode: "cad",
    chargedAt: new Date("2026-03-04T15:09:00Z"),
    stripePaymentIntentId: "pi_live_1",
    stripeChargeId: "ch_live_1",
    last4: "4242",
    livemode: true,
  };

  it("carries NONE of the PDF-only branding strings", () => {
    // If a PDF string leaked into the email, the approved email changed.
    const email = buildPaymentReceiptEmail(emailArgs);
    for (const pdfOnly of ["Payment Receipt", "Powered by Hone"]) {
      expect(email.subject).not.toContain(pdfOnly);
      expect(email.text).not.toContain(pdfOnly);
      expect(email.html).not.toContain(pdfOnly);
    }
  });

  it("keeps its own sign-off and headline", () => {
    const email = buildPaymentReceiptEmail(emailArgs);
    expect(email.text).toContain("Willow Electrolysis via Hone");
    expect(email.subject).toBe("Receipt from Willow Electrolysis: Session payment $125.00 CAD");
  });

  it("the golden byte-identity fixture still governs the email", () => {
    // The dedicated suite asserts it; this pins that the fixture exists and is
    // the real one, so the guarantee cannot quietly stop being checked.
    const golden = JSON.parse(
      readFileSync(join(process.cwd(), "tests/lib/billing/__fixtures__/receipt-email-golden.json"), "utf8"),
    ) as Record<string, { subject: string }>;
    expect(Object.keys(golden)).toHaveLength(6);
    expect(golden.live_full!.subject).toBe("Receipt from Willow Physio: Session payment $125.00 CAD");
  });
});
