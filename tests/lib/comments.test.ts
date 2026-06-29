import { describe, expect, it } from "vitest";
import {
  appendComment,
  isCommentSelected,
  toggleComment,
} from "@/lib/comments";

// PR #279 (Chloe mobile feedback): observation chips are now TOGGLES. A chip can
// be added AND removed, manually typed text is preserved, and the helpers report
// selection so the chip can show pressed.

describe("toggleComment (item 7: tap to add, tap again to remove)", () => {
  it("adds a chip to an empty string", () => {
    expect(toggleComment("", "Slight edema")).toBe("Slight edema");
  });
  it("appends a chip to existing tokens", () => {
    expect(toggleComment("Coarse hair", "Slight edema")).toBe(
      "Coarse hair, Slight edema",
    );
  });
  it("removes a chip that is already present (the bug Chloe hit)", () => {
    expect(toggleComment("Coarse hair, Slight edema", "Slight edema")).toBe(
      "Coarse hair",
    );
    expect(toggleComment("Slight edema", "Slight edema")).toBe("");
  });
  it("removes case-insensitively and from the middle", () => {
    expect(toggleComment("Coarse hair, slight EDEMA, Erythema", "Slight edema")).toBe(
      "Coarse hair, Erythema",
    );
  });
  it("preserves manually typed free text when toggling chips", () => {
    const typed = "client flinched on first insertion";
    expect(toggleComment(typed, "Erythema")).toBe(`${typed}, Erythema`);
    expect(toggleComment(`${typed}, Erythema`, "Erythema")).toBe(typed);
  });
});

describe("isCommentSelected reports chip presence (drives pressed state)", () => {
  it("is true only when the token is present", () => {
    expect(isCommentSelected("Coarse hair, Slight edema", "Slight edema")).toBe(true);
    expect(isCommentSelected("Coarse hair", "Slight edema")).toBe(false);
    expect(isCommentSelected("", "Slight edema")).toBe(false);
  });
  it("matches case-insensitively, ignoring surrounding spaces", () => {
    expect(isCommentSelected("coarse hair ,  SLIGHT edema", "Slight edema")).toBe(true);
  });
});

// appendComment is retained for any other callers; confirm it is unchanged.
describe("appendComment still works (back-to-back dedupe)", () => {
  it("appends and absorbs accidental double-taps", () => {
    expect(appendComment("", "A")).toBe("A");
    expect(appendComment("A", "B")).toBe("A, B");
    expect(appendComment("A, B", "B")).toBe("A, B");
  });
});
