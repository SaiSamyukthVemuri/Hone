import { readFileSync } from "node:fs";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";

// ===========================================================================
// PAY-RECEIPT-PDF — bundled fonts, and an honest coverage boundary
// ===========================================================================
//
// THE DEFECT THIS REPLACES. The first cut drew the receipt with the 14
// standard PDF fonts, which encode WinAnsi only, and sanitised anything else
// to "?" so pdf-lib would not throw. That silently CORRUPTED the two fields a
// receipt exists to identify -- the client's name and the studio's -- and it
// folded canonical text (curly quotes, dashes, ellipsis) on its way past. A
// receipt addressed to "Zo? O'Neill" from "Caf? Beaut?" is not a receipt, and
// nothing in the document told anyone it had happened.
//
// The rule now: RENDER FAITHFULLY, OR DO NOT RENDER. Text is never rewritten.
// If a character cannot be drawn, preparation FAILS and the caller takes the
// pre-provider failure path -- no partial email, no corrupted PDF, and the
// payment itself untouched.
//
// ---------------------------------------------------------------------------
// WHY BUNDLED FILES AND NOT SYSTEM FONTS
// ---------------------------------------------------------------------------
//
// A serverless runtime's font set is not a contract. Reading whatever the
// image happens to ship makes a receipt's appearance -- and, with a coverage
// check, whether it renders at all -- depend on a base image that can change
// under us. These four faces are committed, so the same input produces the
// same document on every runner.
//
// NO RUNTIME DOWNLOADS AND NO EXTERNAL RENDERING SERVICE. The files are read
// from disk; nothing is fetched. They are also force-included in the
// deployment trace (see `outputFileTracingIncludes` in next.config.ts), because
// Next.js cannot see a `readFileSync` path by static analysis and would
// otherwise leave them out of the serverless bundle.
//
// ---------------------------------------------------------------------------
// LICENCE
// ---------------------------------------------------------------------------
//
// DejaVu 2.37, under the Bitstream Vera licence, which permits redistribution
// including inside a derived work. The full text ships beside the fonts in
// LICENSE.txt. Subsetting at embed time means only the glyphs a given receipt
// actually uses are written into that receipt.
//
// ---------------------------------------------------------------------------
// SUPPORTED COVERAGE — say it, and enforce it
// ---------------------------------------------------------------------------
//
// DejaVu Sans carries ~6,250 glyphs. In the ranges that matter for a person's
// or a business's name it covers:
//
//   * Basic Latin, Latin-1 Supplement            (English, French, Spanish,
//                                                 German, Portuguese, ...)
//   * Latin Extended-A and Extended-B            (Polish, Czech, Turkish,
//                                                 Romanian, Vietnamese base
//                                                 letters, ...)
//   * Combining Diacritical Marks (U+0300-U+036F) so decomposed forms render
//     as correctly stacked accents rather than as missing glyphs
//   * Greek, Cyrillic
//   * General Punctuation and Currency Symbols   (curly quotes, en/em dash,
//                                                 ellipsis, EUR, GBP, ...)
//
// It does NOT cover CJK, Korean, most Indic scripts, or emoji. Those are a
// deliberate, DECLARED boundary rather than a silent substitution: covering
// them means bundling a CJK face, which is 16MB+ per weight against these four
// faces' 2.1MB combined. That is a real decision about deployment size and
// belongs to whoever needs it, not to this lane.
// ===========================================================================

/** The four faces the receipt draws with. */
export type ReceiptFontRole = "sans" | "sansBold" | "mono" | "serifBold";

export const RECEIPT_FONT_FILES: Readonly<Record<ReceiptFontRole, string>> = {
  sans: "DejaVuSans.ttf",
  sansBold: "DejaVuSans-Bold.ttf",
  mono: "DejaVuSansMono.ttf",
  serifBold: "DejaVuSerif-Bold.ttf",
};

export const RECEIPT_FONT_DIR = "lib/billing/fonts";

export function receiptFontPath(role: ReceiptFontRole): string {
  return join(process.cwd(), RECEIPT_FONT_DIR, RECEIPT_FONT_FILES[role]);
}

const byteCache = new Map<ReceiptFontRole, Buffer>();

/** Font bytes, read once per process. */
export function loadReceiptFontBytes(role: ReceiptFontRole): Buffer {
  const cached = byteCache.get(role);
  if (cached) return cached;
  const bytes = readFileSync(receiptFontPath(role));
  byteCache.set(role, bytes);
  return bytes;
}

type FontkitFont = { hasGlyphForCodePoint(codePoint: number): boolean };
const fontkitCache = new Map<ReceiptFontRole, FontkitFont>();

function fontkitFor(role: ReceiptFontRole): FontkitFont {
  const cached = fontkitCache.get(role);
  if (cached) return cached;
  const font = (
    fontkit as unknown as { create(b: Buffer): FontkitFont }
  ).create(loadReceiptFontBytes(role));
  fontkitCache.set(role, font);
  return font;
}

/** A receipt could not be drawn faithfully, so it was not drawn at all. */
export class UnsupportedReceiptCharacterError extends Error {
  readonly characters: string[];
  constructor(characters: string[]) {
    super(
      "The receipt contains characters the bundled fonts cannot render: " +
        characters
          .map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`)
          .join(", ") +
        ". No PDF was produced and no email was sent.",
    );
    this.name = "UnsupportedReceiptCharacterError";
    this.characters = characters;
  }
}

/**
 * Characters in `text` the given face cannot draw.
 *
 * Iterates by CODE POINT, so an astral character is examined once rather than
 * as two unpaired halves. Whitespace is skipped: it is laid out, never drawn.
 */
export function findUnsupportedCharacters(
  text: string,
  role: ReceiptFontRole,
): string[] {
  const font = fontkitFor(role);
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (font.hasGlyphForCodePoint(cp)) continue;
    if (seen.has(ch)) continue;
    seen.add(ch);
    missing.push(ch);
  }
  return missing;
}

/**
 * Refuse the whole receipt if ANY part of it cannot be drawn.
 *
 * Checked up front, before a single glyph is written, so a failure cannot
 * leave a half-rendered document behind.
 */
export function assertReceiptTextSupported(
  parts: ReadonlyArray<{ text: string; role: ReceiptFontRole }>,
): void {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    for (const ch of findUnsupportedCharacters(part.text, part.role)) {
      if (seen.has(ch)) continue;
      seen.add(ch);
      missing.push(ch);
    }
  }
  if (missing.length > 0) throw new UnsupportedReceiptCharacterError(missing);
}
