import { describe, expect, it } from "vitest";
import { matchesDirectoryQuery, normalizeDirectoryQuery, MAX_DIRECTORY_QUERY_LENGTH, directorySortKey } from "@/lib/clients/directory-search";
import { projectReceptionistRow, projectStaffRow, type DirectorySourceClient } from "@/lib/clients/directory-rules";

// Privacy S1, S5, S8: a search matches only what the row SHOWS.
const client = (over: Partial<DirectorySourceClient> & Record<string, unknown> = {}): DirectorySourceClient =>
  ({ id: "c1", name: "Jane Smith", preferred_name: "Janie", pronouns: "they/them",
     email: "jane.s@example.test", phone: "+1 (416) 555-0100", archived_at: null, ...over }) as DirectorySourceClient;

const staff = (c: DirectorySourceClient) => projectStaffRow(c);

describe("directory search matches the shown name, email and phone", () => {
  it("POSITIVE CONTROL: the displayed name, email and phone find the client", () => {
    const row = staff(client());
    expect(matchesDirectoryQuery(row, "janie")).toBe(true);
    expect(matchesDirectoryQuery(row, "JANI")).toBe(true);
    expect(matchesDirectoryQuery(row, "jane.s@")).toBe(true);
    expect(matchesDirectoryQuery(row, "416 555")).toBe(true);
    expect(matchesDirectoryQuery(row, "4165550100")).toBe(true);
    expect(matchesDirectoryQuery(row, "")).toBe(true);
  });

  it("does NOT match the stored name while a preferred name is displayed (OPS ruling, S1)", () => {
    const row = staff(client());
    expect(matchesDirectoryQuery(row, "smith")).toBe(false);
    expect(matchesDirectoryQuery(row, "jane smith")).toBe(false);
    // With no preferred name the stored name IS the display, so it is found.
    const plain = staff(client({ preferred_name: null }));
    expect(matchesDirectoryQuery(plain, "smith")).toBe(true);
    expect(matchesDirectoryQuery(plain, "smith jane")).toBe(true);
  });

  it("a legal-only term finds nothing for every role (S5): legal fields are never read, so they cannot match", () => {
    const withLegal = client({ legal_given_name: "Zyxwvut", legal_family_name: "Qrstuvw" });
    for (const row of [staff(withLegal), projectReceptionistRow(withLegal)]) {
      expect(matchesDirectoryQuery(row, "zyxwvut")).toBe(false);
      expect(matchesDirectoryQuery(row, "qrstuvw")).toBe(false);
      expect(matchesDirectoryQuery(row, "zyxwvut qrstuvw")).toBe(false);
      // Positive control on the same fixture.
      expect(matchesDirectoryQuery(row, "janie")).toBe(true);
    }
  });

  it("never matches across two fields or by pronouns, and a non-phone query never matches a phone", () => {
    const row = staff(client({ preferred_name: "Ann", name: "Zed", email: null }));
    expect(matchesDirectoryQuery(row, "annzed")).toBe(false);
    expect(matchesDirectoryQuery(row, "they")).toBe(false);
    expect(matchesDirectoryQuery(staff(client({ phone: "555-0100" })), "x555")).toBe(false);
    expect(matchesDirectoryQuery(staff(client({ phone: null })), "555 0100")).toBe(false);
  });

  it("folds case, accents and punctuation; words may come in any order; every word must match", () => {
    const row = staff(client({ preferred_name: "José O'Brien-Smith" }));
    expect(matchesDirectoryQuery(row, "jose")).toBe(true);
    expect(matchesDirectoryQuery(row, "smith obrien")).toBe(true);
    expect(matchesDirectoryQuery(row, "jose zzz")).toBe(false);
  });

  it("bounds the typed term", () => {
    expect(normalizeDirectoryQuery("  abc  ")).toBe("abc");
    expect(normalizeDirectoryQuery("x".repeat(500)).length).toBe(MAX_DIRECTORY_QUERY_LENGTH);
    expect(normalizeDirectoryQuery(undefined)).toBe("");
  });

  it("the sort key is the folded displayed name only", () => {
    expect(directorySortKey(staff(client()))).toBe("janie");
    expect(directorySortKey(staff(client({ preferred_name: null })))).toBe("jane smith");
  });
});
