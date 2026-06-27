import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  treatmentPhotoScopeLabel,
  treatmentPhotoAreaLabel,
} from "@/app/(app)/clients/[id]/images/photo-context";

// PR #274. Treatment photo context tags — display-only, derived from EXISTING
// metadata (treatment_images.session_id/session_block_id) + the attached
// session block's structured area fields. No migration, no schema change, no
// raw IDs/paths in the UI.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("treatmentPhotoScopeLabel (most-specific scope wins)", () => {
  it("client-only → 'Client photo'", () => {
    expect(
      treatmentPhotoScopeLabel({ sessionId: null, sessionBlockId: null }),
    ).toBe("Client photo");
  });
  it("session attached → 'Session photo'", () => {
    expect(
      treatmentPhotoScopeLabel({ sessionId: "s1", sessionBlockId: null }),
    ).toBe("Session photo");
  });
  it("block attached → 'Block photo' (even with a session)", () => {
    expect(
      treatmentPhotoScopeLabel({ sessionId: "s1", sessionBlockId: "b1" }),
    ).toBe("Block photo");
    expect(
      treatmentPhotoScopeLabel({ sessionId: null, sessionBlockId: "b1" }),
    ).toBe("Block photo");
  });
});

describe("treatmentPhotoAreaLabel", () => {
  it("no attached block → no area tag (null)", () => {
    expect(treatmentPhotoAreaLabel(null, null)).toBeNull();
  });
  it("block attached but no area recorded → 'Area not recorded'", () => {
    expect(treatmentPhotoAreaLabel("b1", null)).toBe("Area not recorded");
    expect(
      treatmentPhotoAreaLabel("b1", {
        primary_area: "   ",
        side: null,
        custom_area_detail: null,
      }),
    ).toBe("Area not recorded");
  });
  it("block with a primary area → 'Treatment area: <area>'", () => {
    expect(
      treatmentPhotoAreaLabel("b1", {
        primary_area: "Chin",
        side: null,
        custom_area_detail: null,
      }),
    ).toBe("Treatment area: Chin");
  });
  it("includes side (display label) and custom detail; skips n/a side", () => {
    expect(
      treatmentPhotoAreaLabel("b1", {
        primary_area: "Underarms",
        side: "bilateral",
        custom_area_detail: null,
      }),
    ).toBe("Treatment area: Underarms · Both sides");
    expect(
      treatmentPhotoAreaLabel("b1", {
        primary_area: "Chin",
        side: "left",
        custom_area_detail: "under-chin",
      }),
    ).toBe("Treatment area: Chin · Left · under-chin");
    expect(
      treatmentPhotoAreaLabel("b1", {
        primary_area: "Lip",
        side: "n/a",
        custom_area_detail: null,
      }),
    ).toBe("Treatment area: Lip");
  });
});

describe("UI wiring: context tags rendered, no raw IDs/paths/URLs", () => {
  const PAGE = read("app/(app)/clients/[id]/images/page.tsx");
  const MANAGER = read(
    "app/(app)/clients/[id]/images/TreatmentImagesManager.tsx",
  );

  it("page computes labels server-side and embeds the session block area", () => {
    expect(PAGE).toMatch(/treatmentPhotoScopeLabel/);
    expect(PAGE).toMatch(/treatmentPhotoAreaLabel/);
    expect(PAGE).toMatch(/session_blocks \( primary_area, side, custom_area_detail \)/);
  });
  it("manager renders ContextTags on cards and in the modal", () => {
    expect(MANAGER).toMatch(/function ContextTags/);
    expect((MANAGER.match(/<ContextTags/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(MANAGER).toMatch(/scopeLabel/);
    expect(MANAGER).toMatch(/areaLabel/);
    expect(MANAGER).toMatch(/Clinical reference/);
  });
  it("manager never receives raw IDs / storage paths (labels only)", () => {
    expect(MANAGER).not.toMatch(/session_id|session_block_id/);
    expect(MANAGER).not.toMatch(/storage_path|storage_bucket/);
    // no bucket/signed-url text rendered as context
    expect(MANAGER).not.toMatch(/treatment-images|signedUrl/);
  });
});
