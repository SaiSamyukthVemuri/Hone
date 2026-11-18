import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #272. "Treatment Photos" gallery manager: no storage internals in the
// client component, no annotation/drawing/OCR/AI.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const MANAGER = read(
  "app/(app)/clients/[id]/images/TreatmentImagesManager.tsx",
);

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
