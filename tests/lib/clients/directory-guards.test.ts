import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Privacy S2/S3 and R1: a SOURCE contract over the directory. The forbidden
// spellings below are the ones that would let a legal-name read, or a helper that
// matches one, reach the directory; every one has a control proving the scanner
// catches it.
const ROOT = process.cwd();
const DIRECTORY_FILES = [
  "lib/clients/directory-rules.ts",
  "lib/clients/directory-search.ts",
  "lib/clients/directory-query.ts",
  "lib/clients/directory-read.ts",
  "lib/clients/last-visit.ts",
  "app/(app)/clients/page.tsx",
  "app/(app)/clients/ClientsDirectory.tsx",
];

function stripComments(src: string): string {
  return src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

export const FORBIDDEN: Array<[string, RegExp]> = [
  ["legal_ column", /legal_/],
  ["legal identities table", /client_legal_identities/],
  ["readLegalName", /readLegalName/],
  ["LEGAL_IDENTITY_COLUMNS", /LEGAL_IDENTITY_COLUMNS/],
  ["matchesClientSearch", /matchesClientSearch/],
  ["nameMatchesQuery", /nameMatchesQuery/],
  ["sortByMatchRank", /sortByMatchRank/],
  ["SearchableClient", /SearchableClient/],
  ["legal-identity import", /from\s+["'][^"']*legal-identity["']/],
  ["wildcard select", /select\(\s*[`"']\s*\*/],
  ["address column", /\baddress\b/],
];

function violations(src: string): string[] {
  const code = stripComments(src);
  return FORBIDDEN.filter(([, re]) => re.test(code)).map(([n]) => n);
}

describe("the scanner catches every forbidden spelling (controls)", () => {
  const samples: Record<string, string> = {
    "legal_ column": 'const c = "legal_given_name";',
    "legal identities table": 'from("client_legal_identities")',
    readLegalName: "await readLegalName(x)",
    LEGAL_IDENTITY_COLUMNS: "select(LEGAL_IDENTITY_COLUMNS)",
    matchesClientSearch: 'import { matchesClientSearch } from "x";',
    nameMatchesQuery: "nameMatchesQuery(a, b)",
    sortByMatchRank: "sortByMatchRank(rows)",
    SearchableClient: "type T = SearchableClient;",
    "legal-identity import": 'import { a } from "@/lib/clients/legal-identity";',
    "wildcard select": 'supabase.from("clients").select("*")',
    "address column": 'select("id, address")',
  };
  for (const [name, code] of Object.entries(samples)) {
    it(`catches ${name}`, () => expect(violations(code)).toContain(name));
  }
  it("ignores a forbidden word inside a comment", () => {
    expect(violations("// never readLegalName here\n/* legal_ */ const a = 1;")).toEqual([]);
  });
});

describe("the directory source is clean", () => {
  for (const f of DIRECTORY_FILES) {
    it(`${f} has no legal read, no legal-aware matcher, no wildcard, no address`, () => {
      expect(violations(readFileSync(join(ROOT, f), "utf8"))).toEqual([]);
    });
  }
  it("matching imports only foldForSearch from name-search", () => {
    const code = stripComments(readFileSync(join(ROOT, "lib/clients/directory-search.ts"), "utf8"));
    const imports = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)];
    const fromNameSearch = imports.filter((m) => m[2].endsWith("name-search"));
    expect(fromNameSearch.map((m) => m[1].trim())).toEqual(["foldForSearch"]);
  });
  it("no per-row query: the read modules never query inside a loop over clients", () => {
    for (const f of ["lib/clients/directory-read.ts", "lib/clients/last-visit.ts"]) {
      const code = stripComments(readFileSync(join(ROOT, f), "utf8"));
      expect(code).not.toMatch(/\.(map|forEach)\([^)]*=>[^)]*\.from\(/);
      expect(code).not.toMatch(/for\s*\(\s*const\s+\w+\s+of\s+(ids|clients|clientIds)\b[^)]*\)\s*\{[^}]*\.from\(/);
    }
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

describe("R1: nothing outside tests imports the receptionist projection", () => {
  it("projectReceptionistRow and projectRowForRole are referenced only by their module", () => {
    const users = ["app", "lib", "components"]
      .flatMap((d) => walk(join(ROOT, d)))
      .filter((p) => !p.endsWith("lib/clients/directory-rules.ts"))
      .filter((p) => /projectReceptionistRow|projectRowForRole/.test(readFileSync(p, "utf8")));
    expect(users).toEqual([]);
  });
  it("control: the scanner would see a user", () => {
    expect(/projectReceptionistRow|projectRowForRole/.test("import { projectRowForRole } from 'x'")).toBe(true);
  });
});
