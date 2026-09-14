import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import {
  buildReceiptDocument,
  type ReceiptFacts,
} from "@/lib/billing/receipt-document";
import {
  renderReceiptPdf,
  splitOversizedToken,
  graphemes,
} from "@/lib/billing/receipt-pdf";
import {
  UnsupportedReceiptCharacterError,
  findUnsupportedCharacters,
  receiptFontPath,
  RECEIPT_FONT_FILES,
} from "@/lib/billing/receipt-fonts";
import {
  extractPdfText,
  pdfPageCount,
  pdfTextRuns,
} from "./helpers/pdf-text";
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
    expect(await pdfPageCount(await renderReceiptPdf(buildReceiptDocument(CARD)))).toBe(1);
  });

  it("CARRIES ACTUAL TEXT — not an empty page with rules on it", async () => {
    // The exact defect seen during development. A PDF can be structurally
    // valid, correctly sized, and completely blank.
    const text = await extractPdfText(await renderReceiptPdf(buildReceiptDocument(CARD)));
    expect(text.length).toBeGreaterThan(300);
    expect(text).toContain("Hone");
    expect(text).toContain("Receipt");
  });
});

describe("the PDF and the email say the SAME things", () => {
  it("every money-bearing fact appears in the PDF bytes", async () => {
    const text = await extractPdfText(await renderReceiptPdf(buildReceiptDocument(CARD)));
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
    const pdfText = await extractPdfText(await renderReceiptPdf(buildReceiptDocument(CARD)));
    const amount = /\$\d+\.\d\d CAD/.exec(email.text)?.[0];
    const date = /\d{4}-\d\d-\d\d \d\d:\d\d UTC/.exec(email.text)?.[0];
    expect(amount).toBeTruthy();
    expect(date).toBeTruthy();
    expect(pdfText).toContain(amount!);
    expect(pdfText).toContain(date!);
  });

  it("carries the approved live copy verbatim, including the platform note", async () => {
    const text = await extractPdfText(await renderReceiptPdf(buildReceiptDocument(CARD)));
    expect(text).toContain("This receipt confirms that a card payment was processed by");
    expect(text).toContain("not a tax invoice unless");
    expect(text).toContain("not the treatment provider or merchant of record");
  });

  it("the live PDF shows NO Stripe ids, exactly like the live email", async () => {
    const text = await extractPdfText(await renderReceiptPdf(buildReceiptDocument(CARD)));
    expect(text).not.toContain("pi_live_1");
    expect(text).not.toContain("ch_live_1");
  });

  it("the TEST-mode PDF does show them, so the assertion above is not vacuous", async () => {
    const text = await extractPdfText(
      await renderReceiptPdf(buildReceiptDocument({ ...CARD, livemode: false })),
    );
    expect(text).toContain("pi_live_1");
    expect(text).toContain("ch_live_1");
  });

  it("writes no copy of its own", async () => {
    // Every sentence in the PDF must exist in the document. A PDF-only
    // sentence is unapproved copy however sensible it reads.
    const doc = buildReceiptDocument(CARD);
    const text = await extractPdfText(await renderReceiptPdf(doc));
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

// ===========================================================================
// FAITHFUL TEXT — the defect the "?" substitution created
// ===========================================================================
//
// The first cut sanitised anything outside WinAnsi to "?" so pdf-lib would not
// throw. That silently corrupted the two fields a receipt exists to identify.
// These tests assert the ACTUAL NAME SURVIVES EXTRACTION -- not merely that
// rendering completed, which the broken version also did.
// ===========================================================================

describe("names render faithfully, or the receipt is not produced", () => {
  const withNames = (studioName: string, clientName: string): ReceiptFacts => ({
    ...CARD,
    studioName,
    clientName,
  });

  const SUPPORTED: Array<[string, string, string]> = [
    ["latin-1 accents", "Café Beauté", "Zoë Ångström"],
    ["latin extended-A", "Kraków Fizjoterapia", "Łukasz Wiśniewski"],
    ["latin extended (Icelandic)", "Þórshöfn Sjúkraþjálfun", "Þóra Ólafsdóttir"],
    ["turkish dotted/dotless i", "İstanbul Fizyoterapi", "Gülşah Çağlar"],
    ["greek", "Ωμέγα Φυσιοθεραπεία", "Γιώργος Παπαδόπουλος"],
    ["cyrillic", "Омега Физиотерапия", "Дарья Ковалёва"],
    ["typographic punctuation", "O’Neill — Physio", "Zoë O’Neill"],
  ];

  it.each(SUPPORTED)("%s survives into the PDF verbatim", async (_label, studio, client) => {
    const text = await extractPdfText(
      await renderReceiptPdf(buildReceiptDocument(withNames(studio, client))),
    );
    // The exact strings, not a normalised or degraded form.
    expect(text).toContain(studio);
    expect(text).toContain(client);
    // And NO substitution was introduced. Counted against a pure-ASCII
    // control rather than banning "?" outright -- the approved copy really
    // does say "Questions? Contact ...", and an assertion that trips on the
    // receipt's own wording proves nothing about the names.
    const control = await extractPdfText(
      await renderReceiptPdf(buildReceiptDocument(withNames("Willow", "Dana"))),
    );
    const marks = (t: string) => (t.match(/\?/g) ?? []).length;
    expect(marks(text)).toBe(marks(control));
  });

  it("COMBINING marks render as the composed name, not as missing glyphs", async () => {
    // Decomposed input: base letter + U+0301/U+0308. The bundled faces carry
    // the combining block, so these must survive rather than fail coverage.
    const decomposed = "Zoë Café";
    const text = await extractPdfText(
      await renderReceiptPdf(buildReceiptDocument(withNames("Café Beauté", decomposed))),
    );
    expect(text.normalize("NFC")).toContain(decomposed.normalize("NFC"));
    const control = await extractPdfText(
      await renderReceiptPdf(buildReceiptDocument(withNames("Willow", "Dana"))),
    );
    expect((text.match(/\?/g) ?? []).length).toBe((control.match(/\?/g) ?? []).length);
  });

  it("REFUSES rather than corrupts when a character is outside coverage", async () => {
    // CJK and emoji are a declared boundary. The old code drew "??" here.
    for (const name of ["東京スタジオ", "Dana 🎉", "नमस्ते क्लिनिक"]) {
      await expect(
        renderReceiptPdf(buildReceiptDocument(withNames(name, "Dana"))),
      ).rejects.toBeInstanceOf(UnsupportedReceiptCharacterError);
    }
  });

  it("the refusal names the offending characters and claims no email was sent", async () => {
    let err: unknown;
    try {
      await renderReceiptPdf(buildReceiptDocument(withNames("東京", "Dana")));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnsupportedReceiptCharacterError);
    const typed = err as UnsupportedReceiptCharacterError;
    expect(typed.characters).toEqual(["東", "京"]);
    expect(typed.message).toContain("U+6771");
    expect(typed.message).toContain("no email was sent");
  });

  it("ANTI-VACUITY: coverage detection distinguishes supported from not", () => {
    expect(findUnsupportedCharacters("Café Beauté — Ωμέγα Дарья", "sans")).toEqual([]);
    expect(findUnsupportedCharacters("東京", "sans")).toEqual(["東", "京"]);
    // Deduplicated, and whitespace is never reported.
    expect(findUnsupportedCharacters("東 東 京", "sans")).toEqual(["東", "京"]);
  });

  it("nothing in the renderer rewrites text any more", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "lib/billing/receipt-pdf.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).not.toContain("toWinAnsiSafe");
    expect(code).not.toContain('"?"');
    expect(code).not.toMatch(/\.normalize\(/);
    // No standard-14 fallback left to silently re-introduce the boundary.
    expect(code).not.toContain("StandardFonts");
  });
});

// ===========================================================================
// LONG-TOKEN LAYOUT — Codex P2 at receipt-pdf.ts:96
// ===========================================================================
//
// wrap() split on whitespace only and accepted an over-wide first word
// unconditionally, so one long token was drawn past the margin and CLIPPED by
// the page. Measured, not eyeballed: every drawn run must end inside the right
// margin.
// ===========================================================================

describe("long unbroken text wraps instead of running off the page", () => {
  const PAGE_WIDTH = 612;
  const MARGIN = 56;

  const LONG: Array<[string, Partial<ReceiptFacts>]> = [
    [
      "long contact address",
      {
        studioContactEmail:
          "reception.appointments.billing.and.accounts.department@willow-physiotherapy-and-rehabilitation-centre-of-greater-toronto.example",
      },
    ],
    [
      "unspaced studio name",
      { studioName: "WillowPhysiotherapyAndRehabilitationCentreOfGreaterTorontoIncorporated" },
    ],
    [
      "unspaced client name",
      { clientName: "Bartholomew-Fitzgerald-Montgomery-Wellington-Highwater-Carrington" },
    ],
    [
      "long stripe ids in the monospace column",
      {
        livemode: false,
        settlement: {
          kind: "card" as const,
          last4: "4242",
          stripePaymentIntentId: `pi_test_${"A1b2C3d4E5f6".repeat(6)}`,
          stripeChargeId: `ch_test_${"Z9y8X7w6V5u4".repeat(6)}`,
        },
      },
    ],
  ];

  it.each(LONG)("%s: every drawn run stays inside the margins", async (_label, over) => {
    const bytes = await renderReceiptPdf(buildReceiptDocument({ ...CARD, ...over }));
    const runs = await pdfTextRuns(bytes);
    expect(runs.length).toBeGreaterThan(5);
    for (const run of runs) {
      expect(run.x).toBeGreaterThanOrEqual(MARGIN - 1);
      // The defect: a run whose right edge lands beyond the page.
      expect(run.x + run.width).toBeLessThanOrEqual(PAGE_WIDTH - MARGIN + 1);
    }
  });

  it.each(LONG)("%s: no text is LOST — every character survives", async (_label, over) => {
    // Wrapping must break the token, never truncate it. The old code drew the
    // token once and let the page clip the remainder.
    const facts = { ...CARD, ...over } as ReceiptFacts;
    const doc = buildReceiptDocument(facts);
    const text = await extractPdfText(await renderReceiptPdf(doc));
    // Compare ignoring the line breaks wrapping introduces.
    const flat = text.replace(/\s+/g, "");
    for (const row of doc.detailRows) {
      expect(flat).toContain(row.value.replace(/\s+/g, ""));
    }
    if (doc.contact) {
      expect(flat).toContain(doc.contact.email.replace(/\s+/g, ""));
    }
  });

  it("CLUSTERS by grapheme — a combining mark is never a unit of its own", () => {
    // The contract the splitter depends on, asserted directly. Going through
    // the splitter alone is not enough: a combining mark has ~zero advance
    // width, so a width-driven break almost never lands right before one, and
    // a code-unit splitter passes by luck rather than by correctness.
    expect(graphemes("Ae\u0301")).toEqual(["A", "e\u0301"]);
    expect(graphemes("o\u0308o\u0308")).toEqual(["o\u0308", "o\u0308"]);
    // Multiple stacked marks stay with their base.
    expect(graphemes("a\u0301\u0308")).toEqual(["a\u0301\u0308"]);
    // A surrogate pair is one unit, never two halves.
    expect(graphemes("A\u{1D400}")).toEqual(["A", "\u{1D400}"]);
    // ANTI-VACUITY: plain text still splits one character at a time.
    expect(graphemes("abc")).toEqual(["a", "b", "c"]);
  });

  it("splits by GRAPHEME, so a combining mark is never orphaned", async () => {
    // Asserted on the SPLITTER, not on extracted runs: pdf.js merges adjacent
    // runs and normalises, so an orphaned accent is invisible downstream. The
    // defect lives here, so the assertion lives here.
    const { PDFDocument } = await import("pdf-lib");
    const fontkitMod = (await import("@pdf-lib/fontkit")).default;
    const { loadReceiptFontBytes } = await import("@/lib/billing/receipt-fonts");
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkitMod);
    const font = await pdf.embedFont(loadReceiptFontBytes("sans"), { subset: true });

    // DECOMPOSED on purpose: base letter + U+0301 / U+0308. A precomposed "é"
    // is ONE code point, so a code-unit splitter would never separate it and
    // this test would pass against the very bug it exists to catch.
    const token = "Ae\u0301o\u0308".repeat(40);
    expect(token).toContain("\u0301");

    const chunks = splitOversizedToken(token, font, 11, 340);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // No chunk may BEGIN with a combining mark -- that is an orphaned accent.
      expect(/^[\u0300-\u036F]/.test(chunk)).toBe(false);
      // Every chunk fits the column it was measured against.
      expect(font.widthOfTextAtSize(chunk, 11)).toBeLessThanOrEqual(340);
    }
    // Nothing is lost or duplicated.
    expect(chunks.join("")).toBe(token);
  });

  it("splitting never halves a surrogate pair", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const fontkitMod = (await import("@pdf-lib/fontkit")).default;
    const { loadReceiptFontBytes } = await import("@/lib/billing/receipt-fonts");
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkitMod);
    const font = await pdf.embedFont(loadReceiptFontBytes("sans"), { subset: true });
    // Astral characters never reach the renderer (coverage refuses them), but
    // the splitter must still be correct on its own terms.
    const token = "A\u{1D400}".repeat(40);
    for (const chunk of splitOversizedToken(token, font, 11, 340)) {
      expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(chunk)).toBe(false);
    }
  });

  it("does not shrink important text away to make it fit", async () => {
    // A tempting alternative fix is to scale the font down. The amount must
    // stay at full size and stay findable.
    const bytes = await renderReceiptPdf(
      buildReceiptDocument({
        ...CARD,
        studioName: "WillowPhysiotherapyAndRehabilitationCentreOfGreaterTorontoIncorporated",
      }),
    );
    expect(await extractPdfText(bytes)).toContain("$125.00 CAD");
  });

  it("stays within one page for every long case", async () => {
    for (const [, over] of LONG) {
      expect(await pdfPageCount(await renderReceiptPdf(buildReceiptDocument({ ...CARD, ...over })))).toBe(1);
    }
  });
});

// ===========================================================================
// THE BUNDLED FONT ASSETS
// ===========================================================================

describe("the fonts are bundled, licensed, and reach the deployment", () => {
  it("all four faces exist on disk and are real TrueType files", async () => {
    const { readFileSync, statSync } = await import("node:fs");
    for (const role of ["sans", "sansBold", "mono", "serifBold"] as const) {
      const p = receiptFontPath(role);
      expect(statSync(p).size).toBeGreaterThan(100_000);
      // TrueType magic: 0x00010000, or "true"/"ttcf".
      const head = readFileSync(p).subarray(0, 4);
      expect(
        head.equals(Buffer.from([0, 1, 0, 0])) ||
          head.toString("latin1") === "true" ||
          head.toString("latin1") === "ttcf",
      ).toBe(true);
    }
  });

  it("the licence ships beside them", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const licence = readFileSync(join(process.cwd(), "lib/billing/fonts/LICENSE.txt"), "utf8");
    expect(licence).toContain("Bitstream Vera");
    expect(licence).toContain("Permission is hereby granted");
  });

  it("next.config FORCE-INCLUDES the fonts in the serverless trace", async () => {
    // Next traces server deps statically and cannot see a readFileSync path,
    // so without this the fonts are missing in production while every local
    // test passes. This is the only guard that would catch that.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const cfg = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
    expect(cfg).toContain("outputFileTracingIncludes");
    expect(cfg).toContain("./lib/billing/fonts/**");
  });

  it("no font is fetched at runtime and no external renderer is used", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const f of ["lib/billing/receipt-pdf.ts", "lib/billing/receipt-fonts.ts"]) {
      const code = readFileSync(join(process.cwd(), f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bfetch\(/);
      expect(code).not.toMatch(/https?:\/\//);
      expect(code).not.toMatch(/puppeteer|playwright|chromium/i);
    }
  });

  it("the file map covers exactly the four roles the renderer uses", () => {
    expect(Object.keys(RECEIPT_FONT_FILES).sort()).toEqual([
      "mono",
      "sans",
      "sansBold",
      "serifBold",
    ]);
  });

  it("SUBSETTING keeps the attachment small despite 2.1MB of bundled faces", async () => {
    // Every used glyph is embedded, so size grows with alphabet, not with the
    // font files. A receipt must stay far under any mail provider's cap.
    const ascii = await renderReceiptPdf(buildReceiptDocument(CARD));
    const greek = await renderReceiptPdf(
      buildReceiptDocument({ ...CARD, studioName: "Ωμέγα Φυσιοθεραπεία", clientName: "Дарья" }),
    );
    expect(ascii.byteLength).toBeLessThan(200_000);
    expect(greek.byteLength).toBeLessThan(200_000);
    // Sanity: the whole 2.1MB of faces is emphatically NOT being embedded.
    expect(ascii.byteLength).toBeLessThan(2_100_000 / 4);
  });
});
