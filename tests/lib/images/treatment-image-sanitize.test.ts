import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { sanitizeTreatmentImage } from "@/lib/images/treatment-image-sanitize";

// PR #277. Server-side content validation + EXIF stripping. Fixtures are built
// with sharp at test time (no committed binaries); rejection cases use crafted
// non-image bytes. Runs in the node unit lane (sharp native; server-only stubbed).

function solid(width = 8, height = 8) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } },
  });
}

describe("sanitizeTreatmentImage — accepts genuine JPEG/PNG/WebP", () => {
  it("accepts a real JPEG and returns image/jpeg", async () => {
    const bytes = await solid().jpeg().toBuffer();
    const r = await sanitizeTreatmentImage({ bytes, declaredContentType: "image/jpeg" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.contentType).toBe("image/jpeg");
      expect((await sharp(r.bytes).metadata()).format).toBe("jpeg");
    }
  });
  it("accepts a real PNG and returns image/png", async () => {
    const bytes = await solid().png().toBuffer();
    const r = await sanitizeTreatmentImage({ bytes, declaredContentType: "image/png" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.contentType).toBe("image/png");
      expect((await sharp(r.bytes).metadata()).format).toBe("png");
    }
  });
  it("accepts a real WebP and returns image/webp", async () => {
    const bytes = await solid().webp().toBuffer();
    const r = await sanitizeTreatmentImage({ bytes, declaredContentType: "image/webp" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.contentType).toBe("image/webp");
      expect((await sharp(r.bytes).metadata()).format).toBe("webp");
    }
  });
});

describe("sanitizeTreatmentImage — rejects fakes / mismatches / corrupt", () => {
  it("rejects a PDF body declared as PNG", async () => {
    const bytes = Buffer.from("%PDF-1.4\n%fake pdf body\n");
    expect((await sanitizeTreatmentImage({ bytes, declaredContentType: "image/png" })).ok).toBe(false);
  });
  it("rejects an HTML body declared as JPEG", async () => {
    const bytes = Buffer.from("<!doctype html><html><body>hi</body></html>");
    expect((await sanitizeTreatmentImage({ bytes, declaredContentType: "image/jpeg" })).ok).toBe(false);
  });
  it("rejects an SVG even when declared as a raster image", async () => {
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
    expect((await sanitizeTreatmentImage({ bytes, declaredContentType: "image/png" })).ok).toBe(false);
  });
  it("rejects an empty file", async () => {
    expect((await sanitizeTreatmentImage({ bytes: Buffer.alloc(0), declaredContentType: "image/png" })).ok).toBe(false);
  });
  it("rejects corrupt/garbage bytes", async () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 37) % 256));
    expect((await sanitizeTreatmentImage({ bytes, declaredContentType: "image/png" })).ok).toBe(false);
  });
  it("rejects a genuine PNG whose declared MIME says JPEG (fake MIME)", async () => {
    const bytes = await solid().png().toBuffer();
    expect((await sanitizeTreatmentImage({ bytes, declaredContentType: "image/jpeg" })).ok).toBe(false);
  });
  it("rejects an unsupported HEIC/HEIF container", async () => {
    // Minimal ISO-BMFF ftyp box with the 'heic' major brand. sharp either
    // detects 'heif' (not in the allowlist) or throws — both reject.
    const bytes = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, // ....ftyp
      0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00, // heic....
      0x68, 0x65, 0x69, 0x63, 0x6d, 0x69, 0x66, 0x31, // heicmif1
    ]);
    expect((await sanitizeTreatmentImage({ bytes, declaredContentType: "image/jpeg" })).ok).toBe(false);
  });
});

describe("sanitizeTreatmentImage — strips metadata + deterministic output", () => {
  it("strips EXIF/GPS from a JPEG (input has EXIF, output has none)", async () => {
    const withExif = await solid()
      .withExif({ IFD0: { Copyright: "Hone test", Software: "exiftest" } })
      .jpeg()
      .toBuffer();
    // sanity: the input actually carries EXIF
    expect((await sharp(withExif).metadata()).exif).toBeInstanceOf(Buffer);
    const r = await sanitizeTreatmentImage({ bytes: withExif, declaredContentType: "image/jpeg" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const outMeta = await sharp(r.bytes).metadata();
      expect(outMeta.exif).toBeUndefined();
      expect(outMeta.format).toBe("jpeg");
    }
  });
  it("BAKES EXIF orientation into the pixels rather than relying on the tag", async () => {
    // libvips moved 8.17.3 -> 8.18.3 with sharp 0.35, and orientation handling
    // lives in libvips — so this is proven BEHAVIOURALLY, not by grepping for
    // `.rotate()`. A non-square image tagged Orientation=6 (rotate 90° CW) must
    // come back with its dimensions SWAPPED and no orientation tag left: that is
    // only possible if the rotation was applied to the pixels.
    // `withMetadata({ orientation })` is the API that actually writes the tag —
    // `withExif({ IFD0: { Orientation } })` does not (verified: sharp reads it
    // back as 1), which would have made this test pass vacuously.
    const tagged = await solid(12, 4)
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    // Sanity: the input really is 12x4 as stored, carrying an orientation tag.
    const inMeta = await sharp(tagged).metadata();
    expect(inMeta.width).toBe(12);
    expect(inMeta.height).toBe(4);
    expect(inMeta.orientation).toBe(6);

    const r = await sanitizeTreatmentImage({
      bytes: tagged,
      declaredContentType: "image/jpeg",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const outMeta = await sharp(r.bytes).metadata();
      // Rotated 90°: 12x4 becomes 4x12 in the actual pixel data.
      expect(outMeta.width).toBe(4);
      expect(outMeta.height).toBe(12);
      // ...and nothing is left for a viewer to re-apply.
      expect(outMeta.orientation).toBeUndefined();
      expect(outMeta.exif).toBeUndefined();
    }
  });

  it("output is re-encoded sanitized bytes, not the original buffer", async () => {
    const input = await solid().withExif({ IFD0: { Copyright: "x" } }).jpeg().toBuffer();
    const r = await sanitizeTreatmentImage({ bytes: input, declaredContentType: "image/jpeg" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.equals(input)).toBe(false);
  });
  it("output content type is deterministic per input format", async () => {
    const jpg = await solid().jpeg().toBuffer();
    const png = await solid().png().toBuffer();
    const webp = await solid().webp().toBuffer();
    const rj = await sanitizeTreatmentImage({ bytes: jpg, declaredContentType: "image/jpeg" });
    const rp = await sanitizeTreatmentImage({ bytes: png, declaredContentType: "image/png" });
    const rw = await sanitizeTreatmentImage({ bytes: webp, declaredContentType: "image/webp" });
    expect(rj.ok && rj.contentType).toBe("image/jpeg");
    expect(rp.ok && rp.contentType).toBe("image/png");
    expect(rw.ok && rw.contentType).toBe("image/webp");
  });
});
