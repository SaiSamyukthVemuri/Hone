import "server-only";
import sharp from "sharp";
import {
  TREATMENT_IMAGE_ALLOWED_TYPES,
  type TreatmentImageContentType,
} from "./treatment-images";

// PR #277. Server-side content validation + metadata stripping for treatment
// image uploads. Runs in the Node runtime (sharp is a native lib). NEVER trusts
// the browser-declared MIME or the filename: it decodes the actual bytes, rejects
// anything that is not a genuine JPEG/PNG/WebP (incl. SVG/HEIC/PDF/HTML/video or
// corrupt data), and re-encodes WITHOUT metadata so EXIF/GPS/XMP/ICC are stripped
// before storage. Output preserves the input format (jpeg→jpeg, png→png,
// webp→webp). No I/O beyond in-memory decode; no secrets; no logging of bytes.

// sharp's detected format -> our canonical content type. Only these three are
// accepted; every other detected format (svg, heif, gif, tiff, pdf, …) is rejected.
const FORMAT_TO_TYPE: Record<string, TreatmentImageContentType> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

// Decompression-bomb guard: ~100 megapixels comfortably exceeds any real phone
// photo (a 50MP camera is 50M px) while rejecting pathological pixel bombs.
const MAX_INPUT_PIXELS = 100_000_000;

// Single generic message, never leak why (format, dimensions, decode error).
const GENERIC_ERROR = "Upload a valid JPEG, PNG, or WebP image.";

export type SanitizeResult =
  | { ok: true; bytes: Buffer; contentType: TreatmentImageContentType }
  | { ok: false; error: string };

// Validate + sanitize raw upload bytes. `declaredContentType` is the already
// allow-listed browser MIME (from validateTreatmentImageUpload); the detected
// content MUST match it, so a fake-MIME file (e.g. declared image/png with a PDF
// body) is rejected rather than silently re-typed.
export async function sanitizeTreatmentImage(input: {
  bytes: Buffer;
  declaredContentType: TreatmentImageContentType;
}): Promise<SanitizeResult> {
  if (!input.bytes || input.bytes.length === 0) {
    return { ok: false, error: GENERIC_ERROR };
  }

  // 1. Decode-detect the REAL format from the bytes (not the declared MIME).
  let detectedType: TreatmentImageContentType | undefined;
  try {
    const meta = await sharp(input.bytes, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: "error",
    }).metadata();
    detectedType = meta.format ? FORMAT_TO_TYPE[meta.format] : undefined;
  } catch {
    // Unsupported/undecodable/corrupt/over-limit bytes.
    return { ok: false, error: GENERIC_ERROR };
  }

  // 2. Must be a supported image AND match the declared MIME (no fake MIME).
  if (!detectedType || !TREATMENT_IMAGE_ALLOWED_TYPES.includes(detectedType)) {
    return { ok: false, error: GENERIC_ERROR };
  }
  if (detectedType !== input.declaredContentType) {
    return { ok: false, error: GENERIC_ERROR };
  }

  // 3. Re-encode in the SAME format. `.rotate()` (no args) bakes EXIF orientation
  // into the pixels and drops the tag; sharp drops ALL embedded metadata
  // (EXIF/GPS/XMP/ICC) on encode unless metadata is explicitly preserved (we
  // never preserve it), so the output is fully sanitized bytes.
  try {
    const base = sharp(input.bytes, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: "error",
    }).rotate();

    let bytes: Buffer;
    if (detectedType === "image/jpeg") {
      bytes = await base.jpeg({ quality: 90 }).toBuffer();
    } else if (detectedType === "image/png") {
      bytes = await base.png({ compressionLevel: 9 }).toBuffer();
    } else {
      bytes = await base.webp({ quality: 90 }).toBuffer();
    }

    if (!bytes || bytes.length === 0) {
      return { ok: false, error: GENERIC_ERROR };
    }
    return { ok: true, bytes, contentType: detectedType };
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
}
