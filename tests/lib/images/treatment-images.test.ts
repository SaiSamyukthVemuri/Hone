import { describe, expect, it } from "vitest";
import {
  TREATMENT_IMAGES_BUCKET,
  TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS,
  TREATMENT_IMAGE_MAX_BYTES,
  validateTreatmentImageUpload,
  validateTreatmentImagePath,
  sanitizeFilename,
  buildTreatmentImagePath,
} from "@/lib/images/treatment-images";

// PR #271. Pure validation + server-path helpers for secure treatment images.

describe("validateTreatmentImageUpload", () => {
  it("accepts jpeg/png/webp within the size limit (case-insensitive)", () => {
    for (const ct of ["image/jpeg", "image/png", "image/webp", "IMAGE/JPEG"]) {
      const r = validateTreatmentImageUpload({ contentType: ct, sizeBytes: 1024 });
      expect(r.ok).toBe(true);
    }
  });

  it("rejects SVG, PDF, gif, and other non-allowed types", () => {
    for (const ct of ["image/svg+xml", "application/pdf", "image/gif", "video/mp4", ""]) {
      const r = validateTreatmentImageUpload({ contentType: ct, sizeBytes: 1024 });
      expect(r.ok).toBe(false);
    }
  });

  it("rejects empty and oversize files", () => {
    expect(validateTreatmentImageUpload({ contentType: "image/png", sizeBytes: 0 }).ok).toBe(false);
    expect(
      validateTreatmentImageUpload({
        contentType: "image/png",
        sizeBytes: TREATMENT_IMAGE_MAX_BYTES + 1,
      }).ok,
    ).toBe(false);
    expect(
      validateTreatmentImageUpload({
        contentType: "image/png",
        sizeBytes: TREATMENT_IMAGE_MAX_BYTES,
      }).ok,
    ).toBe(true);
  });
});

describe("sanitizeFilename", () => {
  it("strips directory separators (keeps only the base name)", () => {
    expect(sanitizeFilename("../../etc/passwd.png")).toBe("passwd.png");
    expect(sanitizeFilename("a/b\\c.jpg")).toBe("c.jpg");
  });
  it("allowlists characters and falls back to a safe default", () => {
    expect(sanitizeFilename("héllo*world.png")).toMatch(/^[A-Za-z0-9._ -]+$/);
    expect(sanitizeFilename("")).toBe("image");
    expect(sanitizeFilename(null)).toBe("image");
    expect(sanitizeFilename("   ")).toBe("image");
  });
  it("caps length", () => {
    expect(sanitizeFilename("a".repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

describe("buildTreatmentImagePath", () => {
  it("builds a studio-prefixed, server-derived path with the right extension", () => {
    expect(
      buildTreatmentImagePath({
        studioId: "studio-1",
        clientId: "client-1",
        id: "img-1",
        contentType: "image/jpeg",
      }),
    ).toBe("studio-1/client-1/img-1.jpg");
    expect(
      buildTreatmentImagePath({
        studioId: "s",
        clientId: "c",
        id: "i",
        contentType: "image/webp",
      }),
    ).toBe("s/c/i.webp");
  });
  it("starts with the studio id (the storage RLS scoping segment)", () => {
    const path = buildTreatmentImagePath({
      studioId: "STUDIO",
      clientId: "CLIENT",
      id: "ID",
      contentType: "image/png",
    });
    expect(path.split("/")[0]).toBe("STUDIO");
  });
});

describe("validateTreatmentImagePath (PR #276 signer trust boundary)", () => {
  const S = "11111111-1111-1111-1111-111111111111";
  const C = "22222222-2222-2222-2222-222222222222";
  const good = {
    expectedStudioId: S,
    rowStudioId: S,
    rowClientId: C,
    storageBucket: "treatment-images",
    storagePath: `${S}/${C}/abc-123.jpg`,
  };

  it("accepts a well-formed same-studio/client path (jpg/png/webp)", () => {
    expect(validateTreatmentImagePath(good).ok).toBe(true);
    for (const ext of ["jpg", "jpeg", "png", "webp"]) {
      expect(
        validateTreatmentImagePath({ ...good, storagePath: `${S}/${C}/x.${ext}` }).ok,
      ).toBe(true);
    }
  });

  it("rejects a wrong bucket", () => {
    const r = validateTreatmentImagePath({ ...good, storageBucket: "public-bucket" });
    expect(r).toEqual({ ok: false, reason: "wrong_bucket" });
  });

  it("rejects a row studio that is not the caller's studio", () => {
    const r = validateTreatmentImagePath({ ...good, rowStudioId: C });
    expect(r).toEqual({ ok: false, reason: "studio_mismatch" });
  });

  it("rejects a path whose studio segment differs from the row studio", () => {
    const r = validateTreatmentImagePath({ ...good, storagePath: `${C}/${C}/x.jpg` });
    expect(r).toEqual({ ok: false, reason: "path_studio_mismatch" });
  });

  it("rejects a path whose client segment differs from the row client", () => {
    const r = validateTreatmentImagePath({ ...good, storagePath: `${S}/${S}/x.jpg` });
    expect(r).toEqual({ ok: false, reason: "path_client_mismatch" });
  });

  it("rejects raw and percent-encoded traversal", () => {
    expect(validateTreatmentImagePath({ ...good, storagePath: `${S}/${C}/../secret.jpg` }).ok).toBe(false);
    expect(validateTreatmentImagePath({ ...good, storagePath: `${S}/${C}/%2e%2e%2fsecret.jpg` }).ok).toBe(false);
    expect(validateTreatmentImagePath({ ...good, storagePath: `${S}/${C}/a%2fb.jpg` }).ok).toBe(false);
  });

  it("rejects extra-segment / wrong-segment-count / multi-slash paths", () => {
    expect(validateTreatmentImagePath({ ...good, storagePath: `${S}/${C}/sub/x.jpg` })).toEqual({ ok: false, reason: "segment_count" });
    expect(validateTreatmentImagePath({ ...good, storagePath: `${S}/${C}` })).toEqual({ ok: false, reason: "segment_count" });
    expect(validateTreatmentImagePath({ ...good, storagePath: "" }).ok).toBe(false);
  });

  it("rejects whitespace, backslashes, control chars, and a bad extension", () => {
    expect(validateTreatmentImagePath({ ...good, storagePath: `${S}/${C}/a b.jpg` })).toEqual({ ok: false, reason: "illegal_chars" });
    expect(validateTreatmentImagePath({ ...good, storagePath: `${S}\\${C}\\x.jpg` })).toEqual({ ok: false, reason: "illegal_chars" });
    expect(validateTreatmentImagePath({ ...good, storagePath: `${S}/${C}/x.svg` })).toEqual({ ok: false, reason: "bad_filename" });
    expect(validateTreatmentImagePath({ ...good, storagePath: `${S}/${C}/x` })).toEqual({ ok: false, reason: "bad_filename" });
  });

  it("a freshly built path validates against its own studio/client", () => {
    const path = buildTreatmentImagePath({
      studioId: S,
      clientId: C,
      id: "33333333-3333-3333-3333-333333333333",
      contentType: "image/png",
    });
    expect(
      validateTreatmentImagePath({
        expectedStudioId: S,
        rowStudioId: S,
        rowClientId: C,
        storageBucket: "treatment-images",
        storagePath: path,
      }).ok,
    ).toBe(true);
  });
});

describe("constants", () => {
  it("uses a single private bucket name + short signed-URL TTL", () => {
    expect(TREATMENT_IMAGES_BUCKET).toBe("treatment-images");
    expect(TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(300);
    expect(TREATMENT_IMAGE_MAX_BYTES).toBe(15 * 1024 * 1024);
  });
});
