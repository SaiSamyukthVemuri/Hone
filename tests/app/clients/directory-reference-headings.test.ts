import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// HON-58 reference fidelity (1 Nov): the visible headings, Intake in its own cell,
// explicit inline labels, and Privacy's subline ruling. Source contract: the browser
// journey (e2e/clients-directory-journey.spec.ts) proves the rendered result.
const SRC = readFileSync("app/(app)/clients/ClientsDirectory.tsx", "utf8");

describe("directory reference headings and labels", () => {
  it("renders Client, Last visit, Next appointment, Intake, Actions as visible headings", () => {
    for (const h of ["Client", "Last visit", "Next appointment", "Intake", "Actions"]) {
      expect(SRC).toContain(`>${h}</span>`);
    }
    expect(SRC).toContain('data-testid="directory-headings"');
  });
  it("gives Intake its own cell, separate from the next appointment", () => {
    expect(SRC).toMatch(/Next appointment: <\/span>\s*<NextCell[\s\S]*?<\/div>\s*<div[^>]*>\s*<span className=\{CELL_LABEL\}>Intake: <\/span>\s*<IntakePill/);
  });
  it("every cell carries its own label (visible on a phone, screen-reader-only beside the headings)", () => {
    expect(SRC).toContain('const CELL_LABEL = "text-neutral-500 md:sr-only"');
    for (const l of ["Last visit: ", "Next appointment: ", "Intake: ", "Archived: "]) expect(SRC).toContain(`${l}</span>`);
  });
  it("the intake status states what it is: the newest non-deleted form, reviewed by a practitioner", () => {
    expect(SRC).toContain("A practitioner has reviewed the newest intake form");
  });
  it("Insurance T-1: the meaning is visible text and aria-describedby, never a hover-only title", () => {
    expect(SRC).toContain("aria-describedby={meaningId(state)}");
    expect(SRC).toContain("<IntakeLegend />");
    expect(SRC).not.toMatch(/title=\{INTAKE_MEANING/);
  });
  it("Privacy ruling: subline is pronouns · email with Name on file leading; the phone has its own line", () => {
    expect(SRC).toContain("[row.nameOnFile ? NAME_ON_FILE_LABEL : null, row.pronouns, row.email]");
    expect(SRC).toContain("{row.phone && <div");
    expect(SRC).not.toMatch(/\[row\.pronouns, row\.email, row\.phone\]/);
  });
});
