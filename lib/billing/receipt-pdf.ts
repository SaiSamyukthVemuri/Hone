import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { ReceiptDocument } from "@/lib/billing/receipt-document";
import {
  assertReceiptTextSupported,
  loadReceiptFontBytes,
  type ReceiptFontRole,
} from "@/lib/billing/receipt-fonts";

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
// FAITHFUL TEXT, OR NO DOCUMENT AT ALL
// ---------------------------------------------------------------------------
//
// Names are rendered exactly as they are stored. Nothing is folded, mapped, or
// substituted: an earlier cut turned unsupported characters into "?" so the
// renderer would not throw, which silently corrupted the client and studio
// names the receipt exists to identify.
//
// Coverage comes from four bundled, licensed faces (receipt-fonts.ts) and is
// checked BEFORE a single glyph is drawn. Anything outside it raises
// UnsupportedReceiptCharacterError, which the sender turns into the
// pre-provider preparation-failure path: no partial email, no corrupted PDF,
// and the payment untouched.
//
// ---------------------------------------------------------------------------
// LONG UNBROKEN TEXT MUST WRAP, NOT RUN OFF THE PAGE
// ---------------------------------------------------------------------------
//
// Wrapping used to split on whitespace only and accepted an over-wide first
// word unconditionally, so a single long token -- a long contact address, an
// unspaced studio name -- was drawn past the margin and CLIPPED at the page
// edge. Reproduced at 640pt of text in a 500pt column: the address ended
// mid-word and the rest was simply gone.
//
// A token that does not fit is now split by GRAPHEME CLUSTER and measured
// chunk by chunk. Clusters, not code units and not code points, because a
// combining accent must never be separated from the letter it sits on and a
// surrogate pair must never be halved. Nothing is scaled down: shrinking the
// amount to make it fit would trade a layout problem for a legibility one.
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

/**
 * Split into grapheme clusters, so a combining mark stays with its base letter
 * and a surrogate pair is never halved.
 */
export function graphemes(text: string): string[] {
  const Seg = (
    Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }
  ).Segmenter;
  if (Seg) {
    return [...new Seg("en", { granularity: "grapheme" }).segment(text)].map((s) => s.segment);
  }
  // Code points at minimum: still never halves a surrogate pair.
  return [...text];
}

/**
 * Break one over-wide token into chunks that each fit `maxWidth`.
 *
 * Always emits at least one cluster per chunk, so a column too narrow for even
 * a single glyph terminates instead of looping forever. That case cannot arise
 * at the receipt's geometry (the narrowest column is ~340pt against ~10pt
 * clusters) but an infinite loop is not an acceptable way to find out.
 */
export function splitOversizedToken(
  token: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const cluster of graphemes(token)) {
    const candidate = chunk + cluster;
    if (chunk && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      chunks.push(chunk);
      chunk = cluster;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/** Break text to fit `maxWidth`, measuring in the font that will draw it. */
export function wrapReceiptText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    // A token wider than the whole column can never fit beside anything, so
    // it is broken up first. Without this the `|| !line` fallback below drew
    // it anyway and the page clipped it.
    const pieces =
      font.widthOfTextAtSize(word, size) > maxWidth
        ? splitOversizedToken(word, font, size, maxWidth)
        : [word];
    for (const piece of pieces) {
      const candidate = line ? `${line} ${piece}` : piece;
      if (!line || font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        lines.push(line);
        line = piece;
      }
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
  for (const line of wrapReceiptText(text, font, size, CONTENT_WIDTH)) {
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
  // FAIL BEFORE DRAWING. Checked against the face that will actually draw each
  // part, so a name that is fine in the body but not in the monospace column
  // cannot slip through.
  assertReceiptTextSupported([
    { text: "Hone", role: "serifBold" },
    { text: doc.headline, role: "serifBold" },
    { text: doc.greeting, role: "sans" },
    { text: doc.lead, role: "sans" },
    { text: doc.taxDisclaimer, role: "sans" },
    { text: doc.supportLine, role: "sans" },
    { text: doc.platformNote ?? "", role: "sans" },
    { text: doc.footer, role: "sans" },
    { text: doc.contact?.line ?? "", role: "sans" },
    ...doc.detailRows.flatMap((r) => [
      { text: `${r.label}:`, role: "sansBold" as ReceiptFontRole },
      { text: r.value, role: (r.monospace ? "mono" : "sans") as ReceiptFontRole },
    ]),
    { text: doc.pdfTitle, role: "sans" },
    { text: doc.subject, role: "sans" },
  ]);

  const pdf = await PDFDocument.create();

  // Subset at embed time: only the glyphs THIS receipt uses are written into
  // it, so bundling 2.1MB of faces does not put 2.1MB in every attachment.
  pdf.registerFontkit(fontkit);
  const embed = (role: ReceiptFontRole) =>
    pdf.embedFont(loadReceiptFontBytes(role), { subset: true });
  const sans = await embed("sans");
  const sansBold = await embed("sansBold");
  const serifBold = await embed("serifBold");
  const mono = await embed("mono");

  pdf.setTitle(doc.pdfTitle);
  pdf.setSubject(doc.subject);
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
    ...doc.detailRows.map((r) => sansBold.widthOfTextAtSize(`${r.label}:`, 11)),
  );
  for (const row of doc.detailRows) {
    ensureRoom(pdf, cur, 20);
    const label = `${row.label}:`;
    cur.page.drawText(label, { x: MARGIN, y: cur.y, size: 11, font: sansBold, color: INK });
    const valueFont = row.monospace ? mono : sans;
    const valueX = MARGIN + labelWidth + 8;
    const valueLines = wrapReceiptText(
      row.value,
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
