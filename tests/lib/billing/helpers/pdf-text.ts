import { inflateSync } from "node:zlib";

type PdfItem = { str: string; width?: number; transform: number[] };
type PdfPage = { getTextContent(): Promise<{ items: PdfItem[] }> };
type PdfDoc = { numPages: number; getPage(n: number): Promise<PdfPage> };

/**
 * Faithful text extraction from a rendered receipt PDF.
 *
 * The receipt embeds SUBSET fonts, so the content stream encodes glyph ids
 * rather than readable characters -- the "inflate and decode as latin1"
 * approach that worked against the standard-14 fonts now returns nothing
 * meaningful. pdf.js resolves each glyph back through the font's ToUnicode
 * CMap, which is what a real PDF viewer does.
 *
 * This is the only way to assert a client's name SURVIVES into the document,
 * rather than merely that rendering did not throw.
 */
async function load(bytes: Uint8Array | Buffer): Promise<PdfDoc> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument(o: { data: Uint8Array }): { promise: Promise<PdfDoc> };
  };
  return await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
}

export async function extractPdfText(bytes: Uint8Array | Buffer): Promise<string> {
  const doc = await load(bytes);
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const content = await (await doc.getPage(i)).getTextContent();
    out.push(content.items.map((it) => it.str).join("\n"));
  }
  return out.join("\n");
}

export async function pdfPageCount(bytes: Uint8Array | Buffer): Promise<number> {
  return (await load(bytes)).numPages;
}

/**
 * Every drawn run with its x-position and measured width, so a test can assert
 * nothing is drawn past the page margin instead of eyeballing a screenshot.
 */
export async function pdfTextRuns(
  bytes: Uint8Array | Buffer,
): Promise<Array<{ str: string; x: number; width: number }>> {
  const doc = await load(bytes);
  const runs: Array<{ str: string; x: number; width: number }> = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const content = await (await doc.getPage(i)).getTextContent();
    for (const it of content.items) {
      if (!it.str.trim()) continue;
      runs.push({ str: it.str, x: it.transform[4] ?? 0, width: it.width ?? 0 });
    }
  }
  return runs;
}

/**
 * The set of Unicode code points the PDF's ToUnicode CMaps map to.
 *
 * Needed because pdf.js NORMALISES whitespace during text extraction: a
 * U+00A0 drawn into the document comes back as U+0020, so
 * `extractPdfText` cannot tell a preserved non-breaking space from a rewritten
 * one. Verified directly: a receipt drawn with U+00A0 really does carry a
 * `<00A0>` entry in its CMap while extraction reports a plain space.
 *
 * This reads the CMap itself, which is the document's own record of what each
 * glyph means, and is therefore the layer where "the character survived" is
 * actually observable.
 */
export function pdfMappedCodePoints(bytes: Uint8Array | Buffer): Set<number> {
  const buf = Buffer.from(bytes);
  let cmaps = "";
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
      const decoded = inflateSync(buf.subarray(a, e)).toString("latin1");
      if (decoded.includes("beginbfchar") || decoded.includes("beginbfrange")) {
        cmaps += decoded;
      }
    } catch {
      /* not a Flate stream */
    }
    i = e + "endstream".length;
  }
  const out = new Set<number>();
  // bfchar: <src> <dst>
  for (const m of cmaps.matchAll(/<([0-9A-Fa-f]{4,})>\s*<([0-9A-Fa-f]{4,})>/g)) {
    const dst = m[2]!;
    for (let k = 0; k + 4 <= dst.length; k += 4) {
      out.add(parseInt(dst.slice(k, k + 4), 16));
    }
  }
  return out;
}
