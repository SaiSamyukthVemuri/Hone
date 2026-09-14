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
