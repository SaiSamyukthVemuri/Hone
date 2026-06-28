import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

// PR #276. Source-grep wiring pins for the treatment-image storage trust
// boundary. Behavioral DB proof is in the db lane; the path-validator logic is
// unit-tested in tests/lib/images/treatment-images.test.ts. This file pins that
// the hardened helpers are actually WIRED into the signer / page / upload, and
// that no public-URL / raw-path / public-route exposure was introduced.

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
const PAGE = read("app/(app)/clients/[id]/images/page.tsx");
const LIB = read("lib/images/treatment-images.ts");

describe("signer validates the path before signing", () => {
  it("the signed-URL action calls validateTreatmentImagePath and selects client_id", () => {
    expect(ACTIONS).toMatch(/validateTreatmentImagePath/);
    expect(ACTIONS).toMatch(/select\("storage_bucket, storage_path, studio_id, client_id"\)/);
    // alerts + bails when the path is rejected (does not sign).
    expect(ACTIONS).toMatch(/treatment_image_sign_rejected_invalid_path/);
  });
  it("the page pre-signer validates each path before signing", () => {
    expect(PAGE).toMatch(/validateTreatmentImagePath/);
  });
  it("the validator binds bucket + path to studio + client", () => {
    expect(LIB).toMatch(/export function validateTreatmentImagePath/);
    expect(LIB).toMatch(/path_studio_mismatch/);
    expect(LIB).toMatch(/path_client_mismatch/);
    expect(LIB).toMatch(/wrong_bucket/);
  });
});

describe("upload orphan-cleanup is surfaced", () => {
  it("a failed cleanup after a failed metadata insert raises a critical alert", () => {
    expect(ACTIONS).toMatch(/treatment_image_orphan_cleanup_failed/);
    expect(ACTIONS).toMatch(/severity: rmErr \? "critical" : "warning"/);
  });
  it("path is still server-constructed (client never supplies it)", () => {
    expect(ACTIONS).toMatch(/buildTreatmentImagePath/);
  });
});

describe("no public exposure / no raw path / practitioner-only (unchanged)", () => {
  it("no getPublicUrl / publicUrl anywhere in app/lib", () => {
    expect(grep("getPublicUrl", "app lib components")).toBe("");
    expect(grep("publicUrl", "app lib components")).toBe("");
  });
  it("signed URLs are not persisted (no url column written)", () => {
    expect(ACTIONS).not.toMatch(/signed_url|preview_url|public_url/);
  });
  it("no public/token route imports the image feature", () => {
    const offenders = grep(
      "images/actions\\|TreatmentImagesManager\\|images/page",
      "app/book app/intake app/portal app/cancel app/reschedule app/manage",
    );
    expect(offenders).toBe("");
  });
  it("adds no annotation/drawing/OCR/AI/comparison", () => {
    for (const src of [ACTIONS, PAGE, LIB]) {
      expect(src).not.toMatch(/<canvas|getContext\(|toDataURL|tesseract|\bOCR\b/i);
      expect(src).not.toMatch(/annotat|sketch|side-by-side/i);
    }
  });
});
