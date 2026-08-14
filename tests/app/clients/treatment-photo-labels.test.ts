import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { treatmentPhotoScopeLabel } from "@/app/(app)/clients/[id]/images/photo-context";

// PR #304: treatment photo UX cleanup (Chloe pilot feedback). The gallery
// stops showing the raw .jpg filename and titles a photo with its SESSION date
// (upload-date fallback); the "Block photo" card label is unified with the
// upload selector's "Treatment area photo". Render-only, no sanitizer /
// storage / signed-URL / archive / schema change.

const root = path.resolve(__dirname, "../../../");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\{\/\*/.test(l))
    .join("\n");

const MANAGER = read("app/(app)/clients/[id]/images/TreatmentImagesManager.tsx");
const MANAGER_CODE = codeOnly(MANAGER);
const PAGE = read("app/(app)/clients/[id]/images/page.tsx");
const CONTEXT = read("app/(app)/clients/[id]/images/photo-context.ts");

describe("scope label is unified (no more 'Block photo')", () => {
  it("treatmentPhotoScopeLabel returns 'Treatment area photo' for a block", () => {
    expect(
      treatmentPhotoScopeLabel({ sessionId: "s1", sessionBlockId: "b1" }),
    ).toBe("Treatment area photo");
  });
  it("the 'Block photo' label is gone from the context helper", () => {
    // Strip // comments so the explanatory note (which mentions the old label)
    // doesn't trip the negative grep on the actual code.
    expect(codeOnly(CONTEXT)).not.toMatch(/"Block photo"/);
    expect(CONTEXT).toMatch(/"Treatment area photo"/);
  });
  it("card + upload selector use the SAME 'Treatment area photo' label", () => {
    // Selector option (upload form) and the scope label now agree.
    expect(MANAGER).toMatch(/\["block", "Treatment area photo"\]/);
  });
});

describe("gallery no longer shows the raw filename", () => {
  it("does not render img.filename / modal.filename as a title or alt", () => {
    // The Row no longer carries a `filename` field at all.
    expect(MANAGER_CODE).not.toMatch(/img\.filename/);
    expect(MANAGER_CODE).not.toMatch(/modal\.filename/);
    // Row type drops filename in favor of the session date.
    expect(MANAGER).not.toMatch(/\n\s*filename: string \| null;/);
    expect(MANAGER).toMatch(/sessionDate: string \| null;/);
  });

  it("titles a session-attached photo with its session date", () => {
    // Both the card and the modal render "Session {sessionDateLabel(...)}".
    const matches = MANAGER.match(/Session \{sessionDateLabel\((?:img|modal)\.sessionDate\)\}/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to the upload date when there is no session", () => {
    // The `img.sessionDate ? ... : Uploaded` fallback branch exists.
    expect(MANAGER).toMatch(/img\.sessionDate \?/);
    expect(MANAGER).toMatch(/modal\.sessionDate \?/);
    expect(MANAGER).toMatch(/Uploaded <FormattedDateTime iso=\{img\.createdAt\}/);
  });

  it("image alt text is a human label, not the filename", () => {
    expect(MANAGER).toMatch(/alt="Treatment photo"/);
    expect(MANAGER).not.toMatch(/alt=\{img\.filename/);
    expect(MANAGER).not.toMatch(/alt=\{modal\.filename/);
  });
});

describe("session date comes from a read-only embed (no schema change)", () => {
  it("the image query embeds sessions ( started_at ) and maps sessionDate", () => {
    expect(PAGE).toMatch(/sessions \( started_at \)/);
    expect(PAGE).toMatch(/sessionDate: session\?\.started_at \?\? null/);
  });
});

describe("scope guard: no sanitizer / storage / signed-url / archive / schema change", () => {
  it("does not touch the sanitizer, storage path building, signing, or archive", () => {
    for (const src of [MANAGER, PAGE, CONTEXT]) {
      expect(src).not.toMatch(/sanitizeFilename|createSignedUrl\(.*ttl|storage_path\s*=/);
    }
    // No migration / schema keyword introduced.
    for (const src of [MANAGER, PAGE, CONTEXT]) {
      expect(src).not.toMatch(/alter table|create table |add column/i);
    }
  });
});
