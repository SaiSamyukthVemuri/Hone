import { describe, expect, it } from "vitest";
import {
  foldForSearch,
  hasNameQuery,
  matchesClientSearch,
  nameCandidatePatterns,
  nameMatchesQuery,
  NON_ASCII_NAME_REGEX,
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
  it("is one AND-ed subsequence pattern per word, from literal ASCII letters", () => {
    expect(nameCandidatePatterns("Smith, Jane")).toEqual(["%s%m%i%t%h%", "%j%a%n%e%"]);
    expect(nameCandidatePatterns("obrien")).toEqual(["%o%b%r%i%e%n%"]);
    // A diacritic in the QUERY folds away, so "José" still reaches ASCII names.
    expect(nameCandidatePatterns("José")).toEqual(["%j%o%s%e%"]);
  });

  it("has no ASCII pattern for a word no all-ASCII name can match", () => {
    // "ł" does not fold to "l"; only the non-ASCII read can find "Łucja".
    expect(nameCandidatePatterns("łucja")).toEqual([]);
    expect(hasNameQuery("łucja")).toBe(true);
    expect(hasNameQuery(" (),. ")).toBe(false);
  });

  it("the non-ASCII read admits every name whose fold is not character-for-character", () => {
    const re = new RegExp(NON_ASCII_NAME_REGEX, "u");
    for (const name of ["Šimon", "Žaneta", "Ǆemal", "Ｊａｎｅ", "O’Brien", "José"]) {
      expect(re.test(name), name).toBe(true);
    }
    for (const name of ["Jane Smith", "O'Brien", "Mary-Kate"]) expect(re.test(name), name).toBe(false);
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

// HON-58 names slice, current schema: country-code-insensitive phone matching and
// best-match-first ordering. Synthetic data only.
import { clientMatchRank, nationalDigits, sortByMatchRank } from "@/lib/clients/name-search";

describe("phone: the country code does not hide a number", () => {
  const stored = { name: "A", phone: "(416) 555-0100" };
  const storedIntl = { name: "B", phone: "+1 416 555 0100" };
  it("a query with the leading 1 finds a number stored without it, and the reverse", () => {
    expect(matchesClientSearch(stored, "+1 416 555 0100")).toBe(true);
    expect(matchesClientSearch(stored, "1-416-555-0100")).toBe(true);
    expect(matchesClientSearch(storedIntl, "416 555 0100")).toBe(true);
    expect(matchesClientSearch(storedIntl, "(416) 555-0100")).toBe(true);
  });
  it("a different number is still not found", () => {
    expect(matchesClientSearch(stored, "+1 416 555 0199")).toBe(false);
    expect(matchesClientSearch(storedIntl, "416 555 0199")).toBe(false);
  });
  it("only an 11-digit 1-prefixed string is reduced", () => {
    expect(nationalDigits("+1 (416) 555-0100")).toBe("4165550100");
    expect(nationalDigits("416-555-0100")).toBe("4165550100");
    expect(nationalDigits("+44 20 7946 0958")).toBe("442079460958");
  });
  it("the server prefilter admits what the matcher accepts, with or without the 1", () => {
    const re = (p: string) => new RegExp("^" + p.replace(/%/g, ".*") + "$");
    const pattern = re(phoneCandidatePattern("+1 416 555 0100")!);
    expect(pattern.test("4165550100")).toBe(true);
    expect(pattern.test("14165550100")).toBe(true);
  });
});

describe("ranking: the best match first", () => {
  const rows = [
    { id: "4", name: "Zed Janet", email: "x@e.test" },
    { id: "3", name: "Mary Janeway", email: null },
    { id: "2", name: "Jane Doe", email: null },
    { id: "1", name: "Jane", email: null },
    { id: "5", name: "Other", email: "jane@e.test" },
  ];
  it("exact, then starts-with, then word-start, then email", () => {
    const ranked = sortByMatchRank(rows, "jane").map((r) => r.id);
    expect(ranked).toEqual(["1", "2", "3", "4", "5"]);
    expect(clientMatchRank(rows[3], "jane")).toBe(0);
    expect(clientMatchRank(rows[2], "jane")).toBe(1);
    expect(clientMatchRank(rows[1], "jane")).toBe(2);
    expect(clientMatchRank(rows[4], "jane")).toBe(4);
  });
  it("the preferred name counts as the name", () => {
    expect(clientMatchRank({ name: "Janet Smith", preferred_name: "Jan" }, "jan")).toBe(0);
  });
  it("ties break by name then id, so the order is stable", () => {
    const tied = [{ id: "b", name: "Sam A" }, { id: "a", name: "Sam A" }, { id: "c", name: "Sam" }];
    expect(sortByMatchRank(tied, "sam").map((r) => r.id)).toEqual(["c", "a", "b"]);
  });
  it("does not mutate its input", () => {
    const copy = [...rows];
    sortByMatchRank(rows, "jane");
    expect(rows).toEqual(copy);
  });
});
