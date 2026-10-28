import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Sam, 28 Oct: the limitation is stated in the product, next to the owner switch.
describe("legal-name access card states its limitation", () => {
  const src = readFileSync("app/(app)/settings/studio/LegalNameAccessForm.tsx", "utf8");
  it("carries the approved sentence and renders it", () => {
    expect(src).toContain("Name on file may itself be a legal name; this setting controls only the separate legal-name record.");
    expect(src).toMatch(/\{LIMITATION\}/);
  });
});
