import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateTreatmentImageUpload } from "@/lib/images/treatment-images";

// Multi-file treatment-photo upload. The security-critical SERVER action is
// UNCHANGED — the UI calls it once per file, so every file is independently
// validated, EXIF-stripped, and studio/client/context scoped. vitest env is
// "node" (no DOM) → the UI loop is verified by source pins; the per-file
// validation is unit-tested against the reused validator.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const MGR = read("app/(app)/clients/[id]/images/TreatmentImagesManager.tsx");
const ACTION = read("app/(app)/clients/[id]/images/actions.ts");

describe("per-file validation (same rules on client + server)", () => {
  it("accepts jpeg/png/webp within the 15MB limit", () => {
    for (const ct of ["image/jpeg", "image/png", "image/webp"]) {
      expect(validateTreatmentImageUpload({ contentType: ct, sizeBytes: 1000 }).ok).toBe(true);
    }
  });
  it("rejects an unsupported type (per file)", () => {
    expect(validateTreatmentImageUpload({ contentType: "application/pdf", sizeBytes: 1000 }).ok).toBe(false);
    expect(validateTreatmentImageUpload({ contentType: "image/gif", sizeBytes: 1000 }).ok).toBe(false);
  });
  it("rejects an oversized (>15MB) or empty file (per file)", () => {
    expect(validateTreatmentImageUpload({ contentType: "image/jpeg", sizeBytes: 16 * 1024 * 1024 }).ok).toBe(false);
    expect(validateTreatmentImageUpload({ contentType: "image/jpeg", sizeBytes: 0 }).ok).toBe(false);
  });
});

describe("UI: multi-select + per-file processing (no all-or-nothing, no silent loss)", () => {
  it("the file input allows multiple", () => {
    expect(MGR).toMatch(/type="file"[\s\S]*?multiple/);
  });
  it("onPick reads ALL chosen files", () => {
    expect(MGR).toMatch(/setSelectedFiles\(Array\.from\(e\.target\.files \?\? \[\]\)\)/);
  });
  it("each file is validated per-file, then uploaded on its OWN action call (one file per call)", () => {
    expect(MGR).toMatch(/validateTreatmentImageUpload\(\{\s*contentType: file\.type,\s*sizeBytes: file\.size,/);
    expect(MGR).toMatch(/for \(let i = 0; i < files\.length; i\+\+\)/);
    expect(MGR).toMatch(/await uploadTreatmentImageAction\(fd\)/);
    expect(MGR).toMatch(/fd\.set\("file", file\)/);
  });
  it("an invalid file fails on its own and does NOT block the rest", () => {
    expect(MGR).toMatch(/update\(i, "failed", v\.error\);\s*\n\s*continue;/);
  });
  it("an upload error is caught per file (no silent loss); results stay visible", () => {
    expect(MGR).toMatch(/\} catch \{[\s\S]*?update\(i, "failed"/);
    expect(MGR).toMatch(/fileResults\.map/);
    expect(MGR).toMatch(/✓ Uploaded/);
    expect(MGR).toMatch(/✗ /);
  });
  it("the whole batch shares ONE validated context (client / session / area)", () => {
    expect(MGR).toMatch(/const context: Record<string, string> = \{ clientId \}/);
    expect(MGR).toMatch(/context\.sessionBlockId = ctxBlockId/);
  });
  it("a single-file selection still works via the same loop (loop of one)", () => {
    expect(MGR).toMatch(/selectedFiles\.length === 1 \? "" : "s"/);
    expect(MGR).toMatch(/selectedFiles\.length === 0/); // button disabled rule
  });
});

describe("security invariants preserved (server action UNCHANGED)", () => {
  it("the upload action still validates + EXIF-strips + studio/client scopes each file", () => {
    expect(ACTION).toMatch(/validateTreatmentImageUpload/);
    expect(ACTION).toMatch(/sanitizeTreatmentImage/);
    expect(ACTION).toMatch(/getCurrentPractitionerWithStudio/);
    expect(ACTION).toMatch(/buildTreatmentImagePath/); // studio/client scoped path
    expect(ACTION).toMatch(/treatment_images/);
    expect(ACTION).toMatch(/insert/);
  });
  it("the action is single-file (get, not getAll) — the UI loops it per file", () => {
    expect(ACTION).toMatch(/formData\.get\("file"\)/);
    expect(ACTION).not.toMatch(/formData\.getAll\("file"\)/);
  });
  it("no payment/email/SMS touched by the UI change", () => {
    expect(MGR).not.toMatch(/stripe|sendEmail|twilio|sendSms/i);
  });
});
