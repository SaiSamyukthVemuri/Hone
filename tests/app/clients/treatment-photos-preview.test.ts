import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

// PR #273. Inline Treatment Photos gallery previews — the page server-signs a
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
// The signer moved into sign-treatment-image.ts (shared with the re-mint route,
// Codex P1 4307807754); the signed-URL surface is both files together.
const ACTIONS =
  read("app/(app)/clients/[id]/images/actions.ts") + "\n" + read("app/(app)/clients/[id]/images/sign-treatment-image.ts");

describe("server-side preview signing (short-lived, ownership-checked)", () => {
  it("the page signs preview URLs with the service-role client after the studio-scoped load", () => {
    expect(PAGE).toMatch(/requirePractitionerWithStudio/);
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
      // No side-by-side comparison feature (deferred). ("export" is omitted —
      // it is the JS keyword, not an export feature.)
      expect(src).not.toMatch(/side-by-side|\bcomparison\b/i);
    });
  }
});


// 0232 (FETT photos, HON-43) EXTENDS this boundary rather than routing around
// it. Sam authorized before/after CAPTURE-STAGE LABELS (#825 6227921378:
// "before/after photos at every session for team review"; 0232 allocated in
// #825 6233952537 as "before/after capture stage on treatment_images"). The
// boundary above came from PR #273's scope list ("no side-by-side comparison",
// 2026-06-27), and a COMPARISON feature is still deferred. So the label
// control is scanned too: it may use the label vocabulary (the two values and
// their "Before"/"After" text), and nothing else in this family.
// 0232 (option A): the visit chart GROUPS photos by label in STACKED sections
// (Before, After, Other). That is grouping, not the deferred comparison: no
// paired side-by-side view, no slider, no compare. Scanned here so a later
// edit cannot turn the grouping into a comparison without meeting this guard.
describe("scope: the 0232 session grouping is stacked sections, never a comparison", () => {
  const SECTION = readFileSync(
    join(process.cwd(), "app/(app)/clients/[id]/sessions/[sessionId]/SessionPhotos.tsx"),
    "utf8",
  );
  const EXEC = SECTION.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  it("has no comparison UI in its code", () => {
    expect(EXEC).not.toMatch(/side-by-side|\bcompar(e|es|ed|ing|ison)\b|slider|<input[^>]*type="range"|<canvas/i);
    expect(EXEC).not.toMatch(/before\s*[\/-]\s*after/i);
    expect(EXEC).not.toMatch(/annotat|sketch|drawing|\bOCR\b/i);
  });

  it("its label vocabulary is exactly the three section headings", () => {
    expect(SECTION).toMatch(/\{ key: "before", heading: "Before" \},\s*\{ key: "after", heading: "After" \},\s*\{ key: null, heading: "Other" \},/);
    // Sections are stacked (column flex), not laid out as paired columns.
    expect(EXEC).not.toMatch(/grid-cols-2[^"]*">\s*\{GROUPS/);
  });
});

describe("scope: the 0232 capture-stage control is a LABEL, never a comparison", () => {
  const CONTROL = readFileSync(
    join(process.cwd(), "app/(app)/clients/[id]/images/CaptureStageControl.tsx"),
    "utf8",
  );

  it("adds no canvas/drawing/OCR/AI / Aesthetic Record, like the page and manager", () => {
    expect(CONTROL).not.toMatch(/<canvas|getContext\(|toDataURL|tesseract|createWorker|\bOCR\b/i);
    expect(CONTROL).not.toMatch(/annotat|sketch|drawing/i);
    expect(CONTROL).not.toMatch(/aestheticrecord|aesthetic.record|smartmatch/i);
  });

  it("has no comparison UI: no side-by-side, comparison, compare, slider or paired 'before/after' view", () => {
    expect(CONTROL).not.toMatch(/side-by-side|\bcompar(e|es|ed|ing|ison)\b|slider|<input[^>]*type="range"/i);
    // The paired form ("before/after", "before-after") names a comparison; a
    // label is one value at a time.
    expect(CONTROL).not.toMatch(/before\s*[\/-]\s*after/i);
  });

  it("its before/after vocabulary is exactly the two label values and their display text", () => {
    const words = CONTROL.match(/\b(before|after)\b/gi) ?? [];
    expect(words.length).toBeGreaterThan(0);
    // Only these forms: the stored values and the display labels.
    expect(CONTROL).toMatch(/const LABEL: Record<TreatmentImageCaptureStage, string> = \{ before: "Before", after: "After" \};/);
    expect(CONTROL).toMatch(/\(\["before", "after"\] as const\)/);
  });
});


describe("CLN-005 current-image preview wiring", () => {
  it("routes opens, closes, image failures and unmount through the request controller", () => {
    expect(MANAGER).toContain("createPhotoPreviewController");
    expect(MANAGER).toContain("preview?.imageId === modal?.id");
    expect(MANAGER).toContain("previewRequests.current?.open(img.id)");
    expect(MANAGER).toContain("previewRequests.current?.close()");
    expect(MANAGER).toContain("previewRequests.current?.dispose()");
    expect(MANAGER).toContain("previewRequests.current?.onImageError(modal.id, currentPreview?.generation ?? -1)");
    expect(MANAGER).not.toContain("setModalUrl(res.url)");
  });
});


describe("CLN-006 photo opener replaced by a label refresh", () => {
  it("uses the shipped settled-close fallback only for a detached opener", () => {
    expect(MANAGER).toContain("useReturnFocus<HTMLDivElement>(modal !== null)");
    expect(MANAGER).toContain("previewOpener.current && !previewOpener.current.isConnected");
    expect(MANAGER).toContain("returnToGallery()");
    expect(MANAGER).toContain("ref={galleryFocusRef}");
  });
});
