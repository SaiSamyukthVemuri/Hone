import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import {
  buildReceiptDocument,
  type ReceiptFacts,
} from "@/lib/billing/receipt-document";
import { renderReceiptPdf, toWinAnsiSafe } from "@/lib/billing/receipt-pdf";
import { buildPaymentReceiptEmail } from "@/lib/email/templates/payment-receipt";

// ===========================================================================
// PAY-RECEIPT-PDF — assertions on the ACTUAL BYTES
// ===========================================================================
//
// Nothing here trusts the renderer's return value. Every assertion inflates
// the PDF's content streams and reads the text-showing operators, because the
// failure this suite exists to catch is a PDF that is produced, attached and
// delivered while being blank or wrong. During development this happened for
// real: an early rasteriser produced a page with rules and NO text, and only
// looking at it revealed that the bytes were fine and the VIEWER was broken.
// Bytes and eyes catch different defects, so this lane used both.
// ===========================================================================

/**
 * Text actually drawn in the PDF, recovered from its content streams.
 *
 * pdf-lib writes hex strings (`<48696...> Tj`); literal `(...)` strings are
 * handled too so the helper does not silently return nothing if that changes.
 */
function extractPdfText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  let decoded = "";
  let i = 0;
  for (;;) {
    const s = buf.indexOf("stream", i);
    if (s < 0) break;
    const e = buf.indexOf("endstream", s);
    if (e < 0) break;
    let a = s + "stream".length;
    if (buf[a] === 0x0d) a += 1;
    if (buf[a] === 0x0a) a += 1;
    try {
      decoded += inflateSync(buf.subarray(a, e)).toString("latin1");
    } catch {
      // Not a Flate stream (fonts, metadata); skip it.
    }
    i = e + "endstream".length;
  }
  const parts: string[] = [];
  for (const m of decoded.matchAll(/<([0-9A-Fa-f\s]*)>\s*Tj/g)) {
    parts.push(Buffer.from(m[1]!.replace(/\s/g, ""), "hex").toString("latin1"));
  }
  for (const m of decoded.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)) {
    parts.push(m[1]!.replace(/\\([()\\])/g, "$1"));
  }
  return parts.join("\n");
}

const CARD: ReceiptFacts = {
  studioName: "Willow Physiotherapy",
  studioContactEmail: "hello@willowphysio.test",
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
};

describe("the PDF is a real, single-page, readable document", () => {
  it("starts with a PDF header and ends with the trailer", async () => {
    const bytes = await renderReceiptPdf(buildReceiptDocument(CARD));
    const buf = Buffer.from(bytes);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buf.toString("latin1")).toContain("%%EOF");
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it("is exactly one page", async () => {
    const buf = Buffer.from(await renderReceiptPdf(buildReceiptDocument(CARD)));
    expect((buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? [])).toHaveLength(1);
  });

  it("CARRIES ACTUAL TEXT — not an empty page with rules on it", async () => {
    // The exact defect seen during development. A PDF can be structurally
    // valid, correctly sized, and completely blank.
    const text = extractPdfText(await renderReceiptPdf(buildReceiptDocument(CARD)));
    expect(text.length).toBeGreaterThan(300);
    expect(text).toContain("Hone");
    expect(text).toContain("Receipt");
  });
});

describe("the PDF and the email say the SAME things", () => {
  it("every money-bearing fact appears in the PDF bytes", async () => {
    const text = extractPdfText(await renderReceiptPdf(buildReceiptDocument(CARD)));
    // The facts that make a receipt a receipt.
    expect(text).toContain("$125.00 CAD");
    expect(text).toContain("2026-03-04 15:09 UTC");
    expect(text).toContain("Card ending in 4242");
    expect(text).toContain("Session payment");
    expect(text).toContain("Willow Physiotherapy");
  });

  it("the amount and date in the PDF are byte-for-byte the email's", async () => {
    // "Identical data" proven against the OTHER rendering, not against a
    // literal. A PDF that rounded differently would pass a literal check that
    // happened to be written to match it.
    const email = buildPaymentReceiptEmail({
      studioName: CARD.studioName, studioContactEmail: CARD.studioContactEmail,
      clientName: CARD.clientName, chargeReasonLabel: CARD.reasonLabel,
      amountCents: CARD.amountCents, currencyCode: CARD.currencyCode,
      chargedAt: CARD.paidAt, stripePaymentIntentId: "pi_live_1",
      stripeChargeId: "ch_live_1", last4: "4242", livemode: true,
    });
    const pdfText = extractPdfText(await renderReceiptPdf(buildReceiptDocument(CARD)));
    const amount = /\$\d+\.\d\d CAD/.exec(email.text)?.[0];
    const date = /\d{4}-\d\d-\d\d \d\d:\d\d UTC/.exec(email.text)?.[0];
    expect(amount).toBeTruthy();
    expect(date).toBeTruthy();
    expect(pdfText).toContain(amount!);
    expect(pdfText).toContain(date!);
  });

  it("carries the approved live copy verbatim, including the platform note", async () => {
    const text = extractPdfText(await renderReceiptPdf(buildReceiptDocument(CARD)));
    expect(text).toContain("This receipt confirms that a card payment was processed by");
    expect(text).toContain("not a tax invoice unless");
    expect(text).toContain("not the treatment provider or merchant of record");
  });

  it("the live PDF shows NO Stripe ids, exactly like the live email", async () => {
    const text = extractPdfText(await renderReceiptPdf(buildReceiptDocument(CARD)));
    expect(text).not.toContain("pi_live_1");
    expect(text).not.toContain("ch_live_1");
  });

  it("the TEST-mode PDF does show them, so the assertion above is not vacuous", async () => {
    const text = extractPdfText(
      await renderReceiptPdf(buildReceiptDocument({ ...CARD, livemode: false })),
    );
    expect(text).toContain("pi_live_1");
    expect(text).toContain("ch_live_1");
  });

  it("writes no copy of its own", async () => {
    // Every sentence in the PDF must exist in the document. A PDF-only
    // sentence is unapproved copy however sensible it reads.
    const doc = buildReceiptDocument(CARD);
    const text = extractPdfText(await renderReceiptPdf(doc));
    const allowed = [
      "Hone", doc.headline, doc.greeting, doc.lead, doc.taxDisclaimer,
      doc.supportLine, doc.platformNote ?? "", doc.footer,
      doc.contact?.line ?? "",
      ...doc.detailRows.flatMap((r) => [`${r.label}:`, r.value]),
    ].join(" ");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      expect(allowed).toContain(trimmed);
    }
  });
});

describe("the same receipt renders the same bytes", () => {
  it("is deterministic across calls", async () => {
    // pdf-lib stamps a clock-based creation date by default, which would make
    // every render differ and make byte assertions impossible.
    const a = await renderReceiptPdf(buildReceiptDocument(CARD));
    const b = await renderReceiptPdf(buildReceiptDocument(CARD));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("the metadata dates are PINNED TO THE PAYMENT, not to the clock", async () => {
    // Two renders inside the same millisecond are byte-identical even with a
    // clock-based date, so the assertion above cannot see this on its own --
    // it passed against a deliberately reintroduced `new Date()`. This reads
    // the stamped value and requires it to be the receipt's own instant.
    const buf = Buffer.from(await renderReceiptPdf(buildReceiptDocument(CARD)));
    const latin = buf.toString("latin1");
    // CARD.paidAt is 2026-03-04T15:09:00Z.
    expect(latin).toContain("CreationDate (D:20260304150900Z)");
    expect(latin).toContain("ModDate (D:20260304150900Z)");

    // And it MOVES with the receipt, so it is not a hard-coded constant.
    const other = Buffer.from(
      await renderReceiptPdf(
        buildReceiptDocument({ ...CARD, paidAt: new Date("2025-11-20T08:01:02Z") }),
      ),
    ).toString("latin1");
    expect(other).toContain("CreationDate (D:20251120080102Z)");
  });

  it("ANTI-VACUITY: a different receipt renders different bytes", async () => {
    const a = await renderReceiptPdf(buildReceiptDocument(CARD));
    const b = await renderReceiptPdf(
      buildReceiptDocument({ ...CARD, amountCents: 12501 }),
    );
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("the filename is deterministic and carries no client identity", () => {
    const doc = buildReceiptDocument(CARD);
    expect(doc.pdfFileName).toBe("receipt-2026-03-04.pdf");
    expect(doc.pdfFileName.toLowerCase()).not.toContain("dana");
  });
});

describe("hostile text degrades instead of blocking the receipt", () => {
  it("folds typography and preserves Latin-1 accents", () => {
    expect(toWinAnsiSafe("Café Beauté")).toBe("Café Beauté");
    expect(toWinAnsiSafe("a\u2014b")).toBe("a-b");
    expect(toWinAnsiSafe("\u201Cq\u201D")).toBe('"q"');
    expect(toWinAnsiSafe("a\u2026")).toBe("a...");
  });

  it("replaces genuinely unencodable characters rather than throwing", () => {
    // The standard PDF fonts encode WinAnsi only; pdf-lib THROWS on anything
    // else. A studio with a CJK name must still get a receipt.
    expect(toWinAnsiSafe("東京 🎉")).toBe("?? ?");
    // One "?" per CHARACTER, not per UTF-16 code unit: an emoji is a surrogate
    // pair and would otherwise read as "??".
    expect(toWinAnsiSafe("🎉")).toBe("?");
    expect(toWinAnsiSafe("東京")).toBe("??");
  });

  it("renders a CJK/emoji studio name without throwing, money intact", async () => {
    const bytes = await renderReceiptPdf(
      buildReceiptDocument({ ...CARD, studioName: "Café Beauté — 東京 🎉 Studio" }),
    );
    const text = extractPdfText(bytes);
    expect(text).toContain("Café Beauté - ?? ? Studio");
    // The parts that carry meaning are ASCII by construction and survive.
    expect(text).toContain("$125.00 CAD");
    expect(text).toContain("Card ending in 4242");
  });

  it("a very long studio name still fits one page", async () => {
    const bytes = await renderReceiptPdf(
      buildReceiptDocument({
        ...CARD,
        studioName:
          "The Very Long Named Physiotherapy & Rehabilitation Centre of Greater Toronto",
      }),
    );
    expect((Buffer.from(bytes).toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? [])).toHaveLength(1);
    expect(extractPdfText(bytes)).toContain("$125.00 CAD");
  });
});
