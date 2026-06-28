import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

// PR #277. Wiring pins for treatment-image content validation + EXIF stripping.
// The sanitizer behavior is unit-tested in tests/lib/images/treatment-image-
// sanitize.test.ts; this pins that the upload action actually USES the sanitized
// output (bytes/type/size) and that no public-URL / raw-path exposure crept in.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
function grep(pattern: string, paths: string): string {
  return execSync(
    `grep -rln '${pattern}' ${paths} --include='*.ts' --include='*.tsx' 2>/dev/null || true`,
    { cwd: process.cwd() },
  )
    .toString()
    .trim();
}

const ACTIONS = read("app/(app)/clients/[id]/images/actions.ts");
const SANITIZE = read("lib/images/treatment-image-sanitize.ts");

describe("upload action uses the sanitized output", () => {
  it("calls sanitizeTreatmentImage with the decoded bytes + declared type", () => {
    expect(ACTIONS).toMatch(/import \{ sanitizeTreatmentImage \} from "@\/lib\/images\/treatment-image-sanitize"/);
    expect(ACTIONS).toMatch(/sanitizeTreatmentImage\(\{[\s\S]*declaredContentType: valid\.contentType/);
  });
  it("rejects an invalid image BEFORE any storage upload", () => {
    expect(ACTIONS).toMatch(/if \(!sanitized\.ok\) return \{ ok: false, error: sanitized\.error \}/);
    // the sanitize gate precedes the storage upload call
    const gate = ACTIONS.indexOf("sanitizeTreatmentImage(");
    const upload = ACTIONS.indexOf(".upload(");
    expect(gate).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(gate);
  });
  it("uploads the SANITIZED bytes + sanitized content type (not the raw file)", () => {
    expect(ACTIONS).toMatch(/\.upload\(storagePath, sanitized\.bytes, \{\s*contentType: sanitized\.contentType/);
    // the raw browser file is no longer uploaded directly
    expect(ACTIONS).not.toMatch(/\.upload\(storagePath, body,/);
  });
  it("builds the path + stores metadata from the sanitized output", () => {
    expect(ACTIONS).toMatch(/contentType: sanitized\.contentType,/); // path build
    expect(ACTIONS).toMatch(/content_type: sanitized\.contentType,/); // metadata
    expect(ACTIONS).toMatch(/size_bytes: sanitized\.bytes\.length,/); // sanitized size
  });
  it("preserves the PR #276 orphan-cleanup behavior", () => {
    expect(ACTIONS).toMatch(/treatment_image_orphan_cleanup_failed/);
  });
});

describe("sanitizer is server-side, format-restricted, metadata-stripping", () => {
  it("is a server-only sharp module", () => {
    expect(SANITIZE).toMatch(/import "server-only"/);
    expect(SANITIZE).toMatch(/import sharp from "sharp"/);
  });
  it("strips metadata (re-encode WITHOUT withMetadata) and auto-orients", () => {
    expect(SANITIZE).not.toMatch(/withMetadata/);
    expect(SANITIZE).toMatch(/\.rotate\(\)/);
  });
  it("guards against decompression bombs (limitInputPixels)", () => {
    expect(SANITIZE).toMatch(/limitInputPixels/);
  });
  it("only outputs jpeg/png/webp and requires detected == declared", () => {
    expect(SANITIZE).toMatch(/jpeg:\s*"image\/jpeg"/);
    expect(SANITIZE).toMatch(/png:\s*"image\/png"/);
    expect(SANITIZE).toMatch(/webp:\s*"image\/webp"/);
    expect(SANITIZE).toMatch(/detectedType !== input\.declaredContentType/);
  });
  it("never logs bytes / uses a single generic error", () => {
    expect(SANITIZE).not.toMatch(/console\./);
    expect(SANITIZE).toMatch(/Upload a valid JPEG, PNG, or WebP image\./);
  });
});

describe("no public exposure (unchanged from PR #271–#276)", () => {
  it("no getPublicUrl / publicUrl in app/lib", () => {
    expect(grep("getPublicUrl", "app lib components")).toBe("");
    expect(grep("publicUrl", "app lib components")).toBe("");
  });
  it("signed URLs are not persisted; no raw path rendered in the manager", () => {
    expect(ACTIONS).not.toMatch(/signed_url|preview_url|public_url/);
    const manager = read("app/(app)/clients/[id]/images/TreatmentImagesManager.tsx");
    expect(manager).not.toMatch(/storage_path|storage_bucket/);
  });
  it("adds no OCR/AI/annotation/comparison", () => {
    for (const src of [ACTIONS, SANITIZE]) {
      expect(src).not.toMatch(/tesseract|\bOCR\b|annotat|sketch|side-by-side/i);
    }
  });
});
