import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #272. "Treatment Photos" gallery UI polish — navigation + upload card +
// gallery list + empty state. UI/nav only: no storage / signed-URL / RLS /
// validation change, no annotation/drawing/OCR/AI, no public/client exposure.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const MANAGER = read(
  "app/(app)/clients/[id]/images/TreatmentImagesManager.tsx",
);
const PAGE = read("app/(app)/clients/[id]/images/page.tsx");
const TAB_BAR = read("components/profile-tab-bar.tsx");

describe("navigation", () => {
  it("the client tab bar surfaces a 'Treatment Photos' link to the images route", () => {
    expect(TAB_BAR).toMatch(/Treatment Photos/);
    expect(TAB_BAR).toMatch(/\$\{pathname\}\/images/);
  });
});

describe("page heading + private wording", () => {
  it("heading is 'Treatment Photos' with private-storage wording", () => {
    expect(PAGE).toMatch(/Treatment Photos/);
    expect(PAGE).toMatch(/Stored privately/);
    expect(PAGE).toMatch(/Visible to practitioners in this studio/);
  });
});

describe("styled upload UI", () => {
  it("uses a styled 'Choose image' control + 'Attach image' button", () => {
    expect(MANAGER).toMatch(/Choose image/);
    expect(MANAGER).toMatch(/Attach image/);
  });
  it("keeps the accessible native file input with the image MIME allowlist", () => {
    expect(MANAGER).toMatch(/type="file"/);
    expect(MANAGER).toMatch(/accept="image\/jpeg,image\/png,image\/webp"/);
    // Native inputs retain keyboard access and cover the visible targets.
    expect(MANAGER).toContain('className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-wait"');
  });
  it("shows the selected count and disables Attach until files are chosen", () => {
    expect(MANAGER).toMatch(/\{selectedFiles\.length\} image/);
    expect(MANAGER).toMatch(/selected/);
    // UI-01J: the two reasons Attach is unavailable are now expressed
    // separately — `disabled` for "no files chosen", `pending` for "upload in
    // flight" — and the Button primitive folds them back together as
    // `disabled={disabled || pending}` while adding aria-busy. Both halves are
    // still asserted, and the composition is asserted against the primitive.
    expect(MANAGER).toMatch(/disabled=\{selectedFiles\.length === 0\}/);
    expect(MANAGER).toMatch(/pending=\{uploading\}/);
    const BUTTON = readFileSync(
      join(process.cwd(), "components/ui/button.tsx"),
      "utf8",
    );
    expect(BUTTON).toMatch(/disabled=\{disabled \|\| pending\}/);
  });
});

describe("gallery + empty state", () => {
  it("renders a gallery grid with View + Archive actions", () => {
    expect(MANAGER).toMatch(/grid/);
    expect(MANAGER).toMatch(/images\.map/);
    // PR #273 replaced the new-tab "View" with an in-app "View larger" preview.
    expect(MANAGER).toMatch(/View larger/);
    expect(MANAGER).toMatch(/>\s*Archive\s*</);
  });
  it("renders the empty state when there are no photos", () => {
    expect(MANAGER).toMatch(/No treatment photos yet/);
    expect(MANAGER).toMatch(
      /Attach a photo to keep visual treatment references with this client\./,
    );
  });
});

describe("UI-only: no storage/security change, no annotation/OCR/AI, no exposure", () => {
  it("the manager only calls the existing server actions (no storage internals)", () => {
    expect(MANAGER).toMatch(/uploadTreatmentImageAction/);
    expect(MANAGER).toMatch(/getTreatmentImageSignedUrlAction/);
    expect(MANAGER).toMatch(/archiveTreatmentImageAction/);
    // No storage API calls in the client component (calls go through actions).
    // (Narrow to call shapes so the explanatory comment mentioning "bucket" /
    // "signed URL" doesn't trip this.)
    expect(MANAGER).not.toMatch(/createAdminClient|storage\.from\(|getPublicUrl|\.createSignedUrl\(|\.upload\(/);
  });
  it("the manager adds no annotation/drawing/canvas/OCR/AI/Jane", () => {
    expect(MANAGER).not.toMatch(/<canvas|getContext\(|toDataURL|tesseract|createWorker|\bOCR\b/i);
    expect(MANAGER).not.toMatch(/annotat|sketch|drawing/i);
    expect(MANAGER).not.toMatch(/jane\.app|\/thumbs\//i);
  });
});


describe("phone photo acquisition", () => {
  it("offers separate camera and multi-image library inputs through the same upload path", () => {
    expect(MANAGER).toContain("Take photo");
    expect(MANAGER).toMatch(/aria-label="Take a treatment photo"[\s\S]*?capture="environment"[\s\S]*?onChange=\{onPick\}/);
    expect(MANAGER).toMatch(/aria-label="Choose treatment images"[\s\S]*?multiple[\s\S]*?onChange=\{onPick\}/);
    expect(MANAGER).toMatch(/focus-within:outline-2/);
    expect(MANAGER).toMatch(/disabled=\{uploading\}/);
  });
});
