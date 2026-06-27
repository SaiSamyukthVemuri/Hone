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
    // hidden-but-accessible (not the primary visible UI)
    expect(MANAGER).toMatch(/className="sr-only"/);
  });
  it("shows the selected filename and disables Attach until a file is chosen", () => {
    expect(MANAGER).toMatch(/Selected image:/);
    expect(MANAGER).toMatch(/disabled=\{pending \|\| !selectedName\}/);
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
