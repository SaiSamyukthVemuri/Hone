import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { clientDisplayName } from "@/lib/clients/identity";

// HON-58: staff headings show the name the client goes by. The client images, intake, assisted-intake and session pages used to
// select and render the STORED name. Each now reads preferred_name through the shared fallback (a database without the column still
// renders, with the stored name) and renders clientDisplayName(...). Synthetic names only.

const read = (p: string) => readFileSync(p, "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

const READ_PAGES = [
  "app/(app)/clients/[id]/images/page.tsx",
  "app/(app)/clients/[id]/intake/page.tsx",
  "app/(app)/clients/[id]/intake/assist/page.tsx",
];

describe("pages that read the client themselves", () => {
  for (const f of READ_PAGES) {
    it(`${f}: reads preferred_name through the fallback and renders the display name, never the stored name`, () => {
      const src = code(read(f));
      expect(src).toContain("await readWithPreferredName((includePreferred) =>");
      expect(src).toContain("${preferredNameColumn(includePreferred)}name");
      expect(src).toContain("clientDisplayName(client)");
      expect(src, "no raw stored-name render").not.toMatch(/\bclient\??\.name\b/);
    });
  }
});

describe("pages that get the client from getClientById (select *, so preferred_name is in the row)", () => {
  it("session start: both headings use the display name", () => {
    const src = code(read("app/(app)/clients/[id]/sessions/new/page.tsx"));
    expect(src).toContain("clientDisplayName(data.client)");
    expect(src).not.toMatch(/\bdata\.client\.name\b/);
  });
  it("session chart: the heading and the first-name wording use the display name; only the postcare PREVIEW keeps the stored name", () => {
    const src = code(read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx"));
    expect(src).toContain("const clientShownName = clientDisplayName(clientData.client)");
    expect(src).toContain("← {clientShownName}");
    const raw = src.match(/\bclientData\.client\.name\b/g) ?? [];
    expect(raw.length, "exactly one stored-name read remains: the postcare preview").toBe(1);
    expect(src).toMatch(/clientName=\{clientData\.client\.name\}/);
  });
});

describe("the helper these pages rely on, with synthetic names", () => {
  it("prefers the preferred name, falls back to the stored one, and never shows the legal name", () => {
    expect(clientDisplayName({ name: "Stored Sentinel", preferred_name: "Fern" })).toBe("Fern");
    expect(clientDisplayName({ name: "Stored Sentinel", preferred_name: "   " })).toBe("Stored Sentinel");
    expect(clientDisplayName({ name: "Stored Sentinel", legal_given_name: "Legal", legal_family_name: "Sentinel" })).toBe("Stored Sentinel");
  });
});
