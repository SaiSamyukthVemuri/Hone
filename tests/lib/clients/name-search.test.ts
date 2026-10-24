import { describe, expect, it } from "vitest";
import {
  foldForSearch,
  matchesClientSearch,
  nameCandidatePatterns,
  nameMatchesQuery,
  phoneCandidatePattern,
  searchTokens,
} from "@/lib/clients/name-search";

// HON-58 — one client-search rule. Every name below is SYNTHETIC.

const COMBINED = { name: "Jane (Janie) Smith", email: "jane.s@example.test", phone: "(555) 010-0001" };

describe("foldForSearch", () => {
  it("folds case, diacritics, punctuation and spacing", () => {
    expect(foldForSearch("  José  O'Brien-Smith ")).toBe("jose obrien smith");
    expect(foldForSearch("Jane (Janie) Smith")).toBe("jane janie smith");
    expect(foldForSearch("SMITH,   Jane")).toBe("smith jane");
    expect(foldForSearch("Zoë D’Arcy")).toBe("zoe darcy");
  });

  it("strips a mid-word accent instead of splitting the word on it", () => {
    expect(foldForSearch("Renée Côté")).toBe("renee cote");
    // Reordered words defeat the compact-substring fallback, so only a real
    // fold can match here.
    expect(nameMatchesQuery("Renée Côté", "cote renee")).toBe(true);
  });

  it("treats empty and null as no words", () => {
    expect(foldForSearch(null)).toBe("");
    expect(searchTokens("  ()  ")).toEqual([]);
  });
});

describe("a combined legal/preferred display string is found without its parentheses", () => {
  it.each([
    ["preferred name alone", "Janie"],
    ["preferred + surname", "janie smith"],
    ["legal given + surname", "jane smith"],
    ["surname alone", "smith"],
    ["surname-first with a comma", "Smith, Jane"],
    ["surname-first, preferred", "smith janie"],
    ["upper case and doubled spaces", "JANE   SMITH"],
    ["the exact display string still works", "Jane (Janie) Smith"],
    ["a word prefix", "jan smi"],
  ])("%s: %j", (_label, query) => {
    expect(matchesClientSearch(COMBINED, query)).toBe(true);
  });

  it("does not match an unrelated name", () => {
    expect(matchesClientSearch(COMBINED, "janet")).toBe(false);
    expect(matchesClientSearch(COMBINED, "smith john")).toBe(false);
  });
});

describe("punctuation, hyphens and diacritics", () => {
  it.each([
    ["O'Brien", "obrien"],
    ["O’Brien", "o'brien"],
    ["O'Brien", "o brien"],
    ["Mary-Kate Olsen", "mary kate"],
    ["Mary-Kate Olsen", "marykate"],
    ["Mary Kate Olsen", "mary-kate"],
    ["José Álvarez", "jose alvarez"],
    ["Jose Alvarez", "José"],
    ["  Jane  Smith ", "jane smith"],
  ])("%j is found by %j", (name, query) => {
    expect(nameMatchesQuery(name, query)).toBe(true);
  });
});

describe("the old raw-substring behaviour is preserved", () => {
  it("still finds an infix of a name", () => {
    expect(matchesClientSearch({ name: "Jane Smith" }, "mit")).toBe(true);
    expect(matchesClientSearch({ name: "Jane Smith" }, "e sm")).toBe(true);
  });

  it("still finds email and raw phone substrings", () => {
    expect(matchesClientSearch(COMBINED, "S@EXAMPLE")).toBe(true);
    expect(matchesClientSearch(COMBINED, "010-0001")).toBe(true);
  });

  it("matches everything on an empty query", () => {
    expect(matchesClientSearch({ name: "Anyone" }, "   ")).toBe(true);
  });
});

describe("phone digits", () => {
  it("matches a phone-shaped query by digits whatever the formatting", () => {
    expect(matchesClientSearch(COMBINED, "5550100001")).toBe(true);
    expect(matchesClientSearch(COMBINED, "555 010 0001")).toBe(true);
    expect(matchesClientSearch(COMBINED, "+1 (555) 010")).toBe(false); // the leading 1 is not stored
  });

  it("does not treat two digits as a phone query", () => {
    expect(phoneCandidatePattern("55")).toBeNull();
    expect(phoneCandidatePattern("jane 555")).toBeNull();
    expect(phoneCandidatePattern("(555) 010")).toBe("%5%5%5%0%1%0%");
  });
});

describe("server prefilter patterns", () => {
  it("is one AND-ed subsequence pattern per word, with accentable letters as _", () => {
    expect(nameCandidatePatterns("Smith, Jane")).toEqual(["%s%m%_%t%h%", "%j%_%_%_%"]);
    expect(nameCandidatePatterns("obrien")).toEqual(["%_%b%r%_%_%_%"]);
  });

  it("can never carry PostgREST syntax or an ILIKE escape from the query", () => {
    for (const hostile of ["a,b.c(d)", "x%y_z\\", "name.ilike.*", "o'brien;--"]) {
      for (const pattern of nameCandidatePatterns(hostile)) {
        expect(pattern).toMatch(/^%(?:[\p{L}\p{N}_]%)+$/u);
      }
    }
  });

  it("produces no pattern for a query with no letters or digits", () => {
    expect(nameCandidatePatterns(" (),. ")).toEqual([]);
  });
});
