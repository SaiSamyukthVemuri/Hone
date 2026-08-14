import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

// PR #273. Inline Treatment Photos gallery previews, the page server-signs a
// short-TTL preview URL per image (after the studio-scoped RLS load), the grid
// renders inline <img> previews, and clicking opens an in-app modal (no new tab
// as the primary path). Security model unchanged: private bucket, signed-URL
// only, short TTL, never public, never stored in the DB.

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

const PAGE = read("app/(app)/clients/[id]/images/page.tsx");
const MANAGER = read("app/(app)/clients/[id]/images/TreatmentImagesManager.tsx");
const ACTIONS = read("app/(app)/clients/[id]/images/actions.ts");

describe("server-side preview signing (short-lived, ownership-checked)", () => {
  it("the page signs preview URLs with the service-role client after the studio-scoped load", () => {
    expect(PAGE).toMatch(/getCurrentPractitionerWithStudio/);
    expect(PAGE).toMatch(/\.eq\("studio_id", studio\.id\)/);
    expect(PAGE).toMatch(/createAdminClient/);
    expect(PAGE).toMatch(/\.createSignedUrl\(/);
    expect(PAGE).toMatch(/TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS/);
  });
  it("does NOT expose raw storage paths to the client (only the signed URL)", () => {
    // page selects storage_path server-side to sign it, but passes previewUrl
    // (not storage_path) to the client component.
    expect(PAGE).toMatch(/previewUrl/);
    expect(MANAGER).not.toMatch(/storage_path/);
  });
});

describe("inline gallery previews + larger modal", () => {
  it("renders inline <img> previews from the signed preview URL", () => {
    expect(MANAGER).toMatch(/<img/);
    expect(MANAGER).toMatch(/previewUrl/);
  });
  it("has an in-app larger preview modal (dialog), not a new tab as the primary path", () => {
    expect(MANAGER).toMatch(/role="dialog"/);
    expect(MANAGER).toMatch(/aria-modal="true"/);
    expect(MANAGER).toMatch(/View larger/);
    expect(MANAGER).not.toMatch(/window\.open/);
  });
  it("the modal re-signs a fresh URL via the existing ownership-checked action", () => {
    expect(MANAGER).toMatch(/getTreatmentImageSignedUrlAction/);
  });
  it("falls back to 'Image not available' when a preview URL is missing/failed", () => {
    expect(MANAGER).toMatch(/Image not available/);
    expect(MANAGER).toMatch(/onError/);
  });
  it("keeps the empty state", () => {
    expect(MANAGER).toMatch(/No treatment photos yet/);
  });
});

describe("security model unchanged", () => {
  it("the signed-URL action still requires practitioner/studio access", () => {
    expect(ACTIONS).toMatch(/getCurrentPractitionerWithStudio/);
    expect(ACTIONS).toMatch(/\.eq\("studio_id", studio\.id\)/);
    expect(ACTIONS).toMatch(/createSignedUrl\(row\.storage_path/);
  });
  it("no getPublicUrl / publicUrl anywhere in app/lib", () => {
    expect(grep("getPublicUrl", "app lib components")).toBe("");
    expect(grep("publicUrl", "app lib components")).toBe("");
  });
  it("signed URLs are not persisted (no url column written to treatment_images)", () => {
    // the metadata insert/update never stores a signed/preview URL
    expect(ACTIONS).not.toMatch(/signed_url|preview_url|public_url/);
  });
  it("no public/token route imports the image feature", () => {
    const offenders = grep(
      "images/actions\\|TreatmentImagesManager\\|images/page",
      "app/book app/intake app/portal app/cancel app/reschedule app/manage",
    );
    expect(offenders).toBe("");
  });
});

describe("scope: no annotation/OCR/AI/AR assets/comparison/export", () => {
  for (const [label, src] of [
    ["page", PAGE],
    ["manager", MANAGER],
  ] as const) {
    it(`${label} adds no canvas/drawing/OCR/AI / Aesthetic Record / comparison / export`, () => {
      expect(src).not.toMatch(/<canvas|getContext\(|toDataURL|tesseract|createWorker|\bOCR\b/i);
      expect(src).not.toMatch(/annotat|sketch|drawing/i);
      expect(src).not.toMatch(/aestheticrecord|aesthetic.record|smartmatch|before.?\/?.?after/i);
      // No side-by-side comparison feature (deferred). ("export" is omitted,
      // it is the JS keyword, not an export feature.)
      expect(src).not.toMatch(/side-by-side|\bcomparison\b/i);
    });
  }
});
