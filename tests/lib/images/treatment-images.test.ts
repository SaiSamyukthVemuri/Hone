import { describe, expect, it } from "vitest";
import {
  TREATMENT_IMAGES_BUCKET,
  TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS,
  TREATMENT_IMAGE_MAX_BYTES,
  validateTreatmentImageUpload,
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

describe("constants", () => {
  it("uses a single private bucket name + short signed-URL TTL", () => {
    expect(TREATMENT_IMAGES_BUCKET).toBe("treatment-images");
    expect(TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(300);
    expect(TREATMENT_IMAGE_MAX_BYTES).toBe(15 * 1024 * 1024);
  });
});
