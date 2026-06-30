import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import {
  validateTreatmentImageUpload,
  TREATMENT_IMAGE_MAX_BYTES,
} from "@/lib/images/treatment-images";
import { sanitizeTreatmentImage } from "@/lib/images/treatment-image-sanitize";

// PR #292. Treatment photo upload pre/post-buffer size hardening. The pipeline
// already validates file.size + MIME before arrayBuffer() and runs the Sharp
// sanitizer (real-format detect, 100 MP pixel limit, EXIF strip) on the bytes.
// PR #292 adds two defense-in-depth byte-length guards in the upload action,
// both reusing the single-source TREATMENT_IMAGE_MAX_BYTES:
//   (1) re-validate the ACTUAL buffered length (>0, <=15 MB) AFTER arrayBuffer()
//       and BEFORE the sanitizer (independent of the client-reported file.size);
//   (2) cap the SANITIZED OUTPUT length (<=15 MB) BEFORE the storage upload.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
const ACTIONS = read("app/(app)/clients/[id]/images/actions.ts");

// ---------------------------------------------------------------------------
// Behavioral: the validator the action re-applies to the buffered byte length.
// ---------------------------------------------------------------------------
describe("validateTreatmentImageUpload bounds the byte length (applied to buffered bytes)", () => {
  const CT = "image/jpeg";

  it("rejects an empty (zero-byte) length before any Sharp work", () => {
    const r = validateTreatmentImageUpload({ contentType: CT, sizeBytes: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Image file is empty.");
  });

  it("rejects a non-finite length", () => {
    const r = validateTreatmentImageUpload({ contentType: CT, sizeBytes: Number.NaN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Image file is empty.");
  });

  it("rejects a length one byte over the 15 MB cap", () => {
    const r = validateTreatmentImageUpload({
      contentType: CT,
      sizeBytes: TREATMENT_IMAGE_MAX_BYTES + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Image is larger than the 15 MB limit.");
  });

  it("accepts a length exactly at the cap", () => {
    const r = validateTreatmentImageUpload({
      contentType: CT,
      sizeBytes: TREATMENT_IMAGE_MAX_BYTES,
    });
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Behavioral (real Sharp): a valid small image still sanitizes AND its
// sanitized output is within the cap, so the new output guard never rejects a
// legitimate upload.
// ---------------------------------------------------------------------------
function solid(width = 8, height = 8) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } },
  });
}

describe("sanitized output of a valid image stays within the cap", () => {
  it("JPEG sanitizes and output byteLength <= TREATMENT_IMAGE_MAX_BYTES", async () => {
    const bytes = await solid().jpeg().toBuffer();
    const r = await sanitizeTreatmentImage({ bytes, declaredContentType: "image/jpeg" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.byteLength).toBeLessThanOrEqual(TREATMENT_IMAGE_MAX_BYTES);
  });

  it("PNG sanitizes and output byteLength <= TREATMENT_IMAGE_MAX_BYTES", async () => {
    const bytes = await solid().png().toBuffer();
    const r = await sanitizeTreatmentImage({ bytes, declaredContentType: "image/png" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.byteLength).toBeLessThanOrEqual(TREATMENT_IMAGE_MAX_BYTES);
  });

  it("WebP sanitizes and output byteLength <= TREATMENT_IMAGE_MAX_BYTES", async () => {
    const bytes = await solid().webp().toBuffer();
    const r = await sanitizeTreatmentImage({ bytes, declaredContentType: "image/webp" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.byteLength).toBeLessThanOrEqual(TREATMENT_IMAGE_MAX_BYTES);
  });

  it("empty bytes are rejected by the sanitizer too (post-buffer empty)", async () => {
    const r = await sanitizeTreatmentImage({
      bytes: Buffer.alloc(0),
      declaredContentType: "image/jpeg",
    });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source-grep: the upload action enforces the guards in the right ORDER.
// ---------------------------------------------------------------------------
describe("upload action: pre/post-buffer byte-length guards + ordering", () => {
  const idxFileSizeValidate = ACTIONS.indexOf("sizeBytes: file.size");
  const idxArrayBuffer = ACTIONS.indexOf("await file.arrayBuffer()");
  const idxBufferValidate = ACTIONS.indexOf("sizeBytes: inputBytes.byteLength");
  const idxSanitize = ACTIONS.indexOf("await sanitizeTreatmentImage({");
  const idxOutputCap = ACTIONS.indexOf(
    "sanitized.bytes.byteLength > TREATMENT_IMAGE_MAX_BYTES",
  );
  const idxUpload = ACTIONS.indexOf(".upload(storagePath, sanitized.bytes");

  it("imports the single-source max-bytes constant", () => {
    expect(ACTIONS).toMatch(/TREATMENT_IMAGE_MAX_BYTES/);
  });

  it("validates file.size BEFORE arrayBuffer()", () => {
    expect(idxFileSizeValidate).toBeGreaterThan(-1);
    expect(idxArrayBuffer).toBeGreaterThan(-1);
    expect(idxFileSizeValidate).toBeLessThan(idxArrayBuffer);
  });

  it("re-validates the buffered byteLength AFTER arrayBuffer() and BEFORE the sanitizer", () => {
    expect(idxBufferValidate).toBeGreaterThan(idxArrayBuffer);
    expect(idxBufferValidate).toBeLessThan(idxSanitize);
  });

  it("caps the SANITIZED output length BEFORE the storage upload", () => {
    expect(idxOutputCap).toBeGreaterThan(idxSanitize);
    expect(idxUpload).toBeGreaterThan(-1);
    expect(idxOutputCap).toBeLessThan(idxUpload);
  });

  it("uploads the SANITIZED bytes, never the original inputBytes", () => {
    expect(ACTIONS).toMatch(/\.upload\(storagePath, sanitized\.bytes/);
    expect(ACTIONS).not.toMatch(/\.upload\([^,]*,\s*inputBytes/);
  });

  it("regression: real instanceof File guard, no public URL, no withMetadata", () => {
    expect(ACTIONS).toMatch(/file instanceof File/);
    expect(ACTIONS).not.toMatch(/getPublicUrl/);
    expect(ACTIONS).not.toMatch(/withMetadata/);
  });
});
