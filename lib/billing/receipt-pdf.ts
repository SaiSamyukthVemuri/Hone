import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { ReceiptDocument } from "@/lib/billing/receipt-document";

// ===========================================================================
// PAY-RECEIPT-PDF — the receipt as a document the client can keep
// ===========================================================================
//
// GENERATED INSIDE HONE. No external invoice API, no rendering service, no
// headless browser. `pdf-lib` is pure JavaScript with no native binary and no
// network at render time, which matters because this runs on the tail of a
// COMMITTED card charge: a cold-start Chromium download would be a second way
// for a settled payment to be slow, and the whole point of the safety layer in
// PR #698 was to remove those.
//
// ---------------------------------------------------------------------------
// IT RENDERS THE DOCUMENT. IT DOES NOT WRITE COPY.
// ---------------------------------------------------------------------------
//
// Every string here comes from `ReceiptDocument`, which is the same structure
// the email renders. This file chooses typography, wrapping and page geometry
// and nothing else. A sentence that appears in the PDF but not in the email is
// unapproved copy (see receipt-document.ts on the 2026-07-04 sign-off), so the
// only literals below are field labels the document itself supplies and the
// "Hone" wordmark.
//
// ---------------------------------------------------------------------------
// DETERMINISM
// ---------------------------------------------------------------------------
//
// The same receipt must produce the same bytes. pdf-lib stamps a creation date
// from the clock by default, which would make the output differ on every call
// and make byte-level testing impossible. Both timestamps are therefore pinned
// to the receipt's own `paidAt`, and object streams are disabled so the layout
// is inspectable.
//
// ---------------------------------------------------------------------------
// ENCODING IS A REAL FAILURE MODE, NOT A THEORETICAL ONE
// ---------------------------------------------------------------------------
//
// The 14 standard PDF fonts encode WinAnsi only. A studio name carrying a
// character outside it — a CJK name, an emoji, a stray zero-width space —
// makes pdf-lib THROW. Left unhandled that would block the receipt for a real
// studio, so text is sanitised to a WinAnsi-safe form first: common
// typographic characters are folded to their ASCII equivalents and anything
// still unencodable becomes "?". A receipt with a degraded character is
// strictly better than no receipt, and the amount, date and method — the parts
// that carry meaning — are ASCII by construction.
// ===========================================================================

const PAGE_WIDTH = 612; // US Letter, 72dpi
const PAGE_HEIGHT = 792;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Matches the email shell so the two read as one communication.
const INK = rgb(0.039, 0.039, 0.039); // #0A0A0A
const MUTED = rgb(0.42, 0.42, 0.42); // #6B6B6B
const FAINT = rgb(0.604, 0.604, 0.604); // #9A9A9A
const RULE = rgb(0.898, 0.886, 0.855); // #E5E2DA

/** Typographic characters that have a faithful ASCII fold. */
const FOLD: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/[–—−]/g, "-"],
  [/…/g, "..."],
  [/ /g, " "],
  [/[​-‍﻿]/g, ""],
];

/**
 * WinAnsi-safe text. Never throws, never returns a character the standard
 * fonts cannot draw.
 *
 * Allowed: printable ASCII, and the Latin-1 supplement (U+00A0-U+00FF) which
 * WinAnsi encodes directly — so accented studio names survive intact.
 */
export function toWinAnsiSafe(input: string): string {
  let out = input;
  for (const [re, to] of FOLD) out = out.replace(re, to);
  // The `u` flag matters: without it an astral character (an emoji) is two
  // UTF-16 code units and becomes "??" rather than a single "?".
  return out.replace(/[^\x20-\x7E\u00A1-\u00FF]/gu, "?");
}

/** Break text to fit `maxWidth`, measuring in the font that will draw it. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

type Cursor = { page: PDFPage; y: number };

/** A receipt is one page by construction; this is the backstop, not the plan. */
function ensureRoom(pdf: PDFDocument, cur: Cursor, needed: number): void {
  if (cur.y - needed >= MARGIN) return;
  cur.page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  cur.y = PAGE_HEIGHT - MARGIN;
}

function drawParagraph(
  pdf: PDFDocument,
  cur: Cursor,
  text: string,
  font: PDFFont,
  size: number,
  color: ReturnType<typeof rgb>,
  leading: number,
): void {
  for (const line of wrap(toWinAnsiSafe(text), font, size, CONTENT_WIDTH)) {
    ensureRoom(pdf, cur, leading);
    cur.page.drawText(line, { x: MARGIN, y: cur.y, size, font, color });
    cur.y -= leading;
  }
}

/**
 * Render the canonical receipt as PDF bytes.
 *
 * Rejects rather than returning a partial document: the caller treats a
 * failure as "no receipt was prepared" and must not send a receipt email
 * without its attachment.
 */
export async function renderReceiptPdf(doc: ReceiptDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const sansBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  // The email shell uses a Georgia serif wordmark; Times is the standard-font
  // serif and the closest available without embedding a font file.
  const serifBold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);

  pdf.setTitle(toWinAnsiSafe(doc.pdfTitle));
  pdf.setSubject(toWinAnsiSafe(doc.subject));
  pdf.setProducer("Hone");
  pdf.setCreator("Hone");
  // Pinned to the receipt, not the clock. See the header on determinism.
  pdf.setCreationDate(doc.issuedAt);
  pdf.setModificationDate(doc.issuedAt);

  const cur: Cursor = {
    page: pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    y: PAGE_HEIGHT - MARGIN,
  };

  // Wordmark
  cur.page.drawText("Hone", { x: MARGIN, y: cur.y, size: 18, font: serifBold, color: INK });
  cur.y -= 40;

  // Headline
  drawParagraph(pdf, cur, doc.headline, serifBold, 26, INK, 32);
  cur.y -= 8;

  // Greeting + lead
  drawParagraph(pdf, cur, doc.greeting, sans, 12, INK, 20);
  cur.y -= 4;
  drawParagraph(pdf, cur, doc.lead, sans, 11, MUTED, 17);
  cur.y -= 14;

  // Detail block, ruled top and bottom like the email's table.
  ensureRoom(pdf, cur, 24);
  cur.page.drawLine({
    start: { x: MARGIN, y: cur.y },
    end: { x: PAGE_WIDTH - MARGIN, y: cur.y },
    thickness: 1,
    color: RULE,
  });
  cur.y -= 20;

  const labelWidth = Math.max(
    ...doc.detailRows.map((r) => sansBold.widthOfTextAtSize(`${toWinAnsiSafe(r.label)}:`, 11)),
  );
  for (const row of doc.detailRows) {
    ensureRoom(pdf, cur, 20);
    const label = `${toWinAnsiSafe(row.label)}:`;
    cur.page.drawText(label, { x: MARGIN, y: cur.y, size: 11, font: sansBold, color: INK });
    const valueFont = row.monospace ? mono : sans;
    const valueX = MARGIN + labelWidth + 8;
    const valueLines = wrap(
      toWinAnsiSafe(row.value),
      valueFont,
      11,
      CONTENT_WIDTH - (labelWidth + 8),
    );
    for (const [i, line] of valueLines.entries()) {
      if (i > 0) {
        cur.y -= 15;
        ensureRoom(pdf, cur, 15);
      }
      cur.page.drawText(line, { x: valueX, y: cur.y, size: 11, font: valueFont, color: INK });
    }
    cur.y -= 20;
  }

  ensureRoom(pdf, cur, 12);
  cur.page.drawLine({
    start: { x: MARGIN, y: cur.y + 6 },
    end: { x: PAGE_WIDTH - MARGIN, y: cur.y + 6 },
    thickness: 1,
    color: RULE,
  });
  cur.y -= 18;

  if (doc.contact) {
    drawParagraph(pdf, cur, doc.contact.line, sans, 11, INK, 17);
    cur.y -= 8;
  }

  drawParagraph(pdf, cur, doc.taxDisclaimer, sans, 10, MUTED, 15);
  cur.y -= 4;
  drawParagraph(pdf, cur, doc.supportLine, sans, 10, MUTED, 15);

  if (doc.platformNote) {
    cur.y -= 4;
    drawParagraph(pdf, cur, doc.platformNote, sans, 9, FAINT, 14);
  }

  cur.y -= 10;
  drawParagraph(pdf, cur, doc.footer, sans, 9, MUTED, 13);

  // Object streams off: the layout stays greppable, which is what lets the
  // tests assert on the ACTUAL bytes rather than on a render-time promise.
  return await pdf.save({ useObjectStreams: false });
}
