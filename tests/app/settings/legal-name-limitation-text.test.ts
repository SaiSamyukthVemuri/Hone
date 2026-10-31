import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Sam, 28 Oct: the limitation is stated in the product, next to the owner switch.
describe("legal-name access card states its limitation", () => {
  const src = readFileSync("app/(app)/settings/studio/LegalNameAccessForm.tsx", "utf8");
  it("carries the approved sentence and renders it", () => {
    expect(src).toContain("Name on file may itself be a legal name; this setting controls only the separate legal-name record.");
    expect(src).toMatch(/\{LIMITATION\}/);
  });

  // Privacy PEER-0258-0266-SQL C6 / G3 / G4: OFF must not read as "the desk cannot
  // see any legal name", and ON must say it is every client.
  it("does not claim that off hides legal names in general, and says on reaches every client", () => {
    expect(src).not.toMatch(/When off, legal names are not sent/);
    expect(src).toMatch(/When off, the separate legal-name record is not sent/);
    expect(src).toMatch(/legal name of every client in the studio/);
  });
});
