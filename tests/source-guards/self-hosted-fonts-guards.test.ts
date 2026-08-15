import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { NAME_ID, readWoff2NameTable } from "./woff2-name-table";

// SOURCE GUARDS - self-hosted Inter + Fraunces.
//
// `next build` used to fetch Inter and Fraunces from fonts.googleapis.com at
// BUILD time. When that host was unreachable the build failed outright, so
// deterministic commits went red for reasons that had nothing to do with the
// commit. The fonts are now self-hosted through `next/font/local`.
//
// The failure this file exists to catch is a REGRESSION: someone adds a
// `next/font/google` import back (it is the path of least resistance - one line,
// no binary to vendor) and the build silently becomes network-dependent again.
// Nothing else in the suite would notice, because a machine WITH network access
// builds and renders identically either way. That is exactly why this has to be
// a static contract rather than a behavioural test.
//
// The second thing pinned here is the FACE CONTRACT: which weights and styles
// each surface declares. Those are easy to "tidy" into a variable weight range,
// which looks equivalent and is not - see the assertions below.
//
// WHY THE TYPESCRIPT PARSER AND NOT A REGEX. Source text legitimately NAMES
// `next/font/google` in comments - this file does, app/_fonts/*.ts do, and
// lib/security/headers.ts does - so the scan has to ignore comments. A
// line-oriented comment filter is not good enough, and its failure mode is
// silent: `import { Inter } from /* why */ "next/font/google"` survives a
// `from\s*"..."` regex, and a line STARTING with a block comment gets discarded
// whole, taking a real import on that same line with it. Both forms restore the
// build-time network dependency while leaving a hand-rolled guard green. So
// imports come from ts.preProcessFile, and the host scan runs over
// scanner-stripped text that keeps string literals intact.

const ROOT = path.resolve(__dirname, "../..");

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".git",
  "playwright-report",
  "test-results",
  "coverage",
]);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRECTORIES.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry))) {
      acc.push(full);
    }
  }
  return acc;
}

/** Every module specifier the file imports or re-exports, comments ignored. */
function moduleSpecifiers(src: string): string[] {
  return ts.preProcessFile(src, true, true).importedFiles.map((f) => f.fileName);
}

/** Source text with comments removed and string literals preserved. */
function codeOnly(src: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ true,
    ts.LanguageVariant.JSX,
    src,
  );
  let out = "";
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    out += scanner.getTokenText() + " ";
    token = scanner.scan();
  }
  return out;
}

const GOOGLE_FONT_HOST = /fonts\.(googleapis|gstatic)\.com/;

// The OFL notices must reach the browser, not just the checkout, so they live
// under public/ (served verbatim by Next at /fonts/LICENSE-*.txt) rather than
// beside the binaries in app/_fonts.
const LICENSE_DIR = path.join("public", "fonts");

// The only files allowed to name the Google Fonts hosts in CODE. Both do it to
// assert the hosts are ABSENT, which is the same property this file protects; a
// guard that could not tell "asserts absence" from "reintroduces it" would
// punish the tests defending it. Everything else in the repository is scanned,
// including build-path files such as next.config.ts and scripts/*.mjs, because
// `npm run build` executes those too - a fetch added there would recreate the
// network-dependent build just as effectively as an import in app/.
const MAY_NAME_GOOGLE_FONT_HOSTS = new Set([
  path.join("tests", "lib", "security", "headers.test.ts"),
  path.join("tests", "source-guards", "self-hosted-fonts-guards.test.ts"),
]);

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const APP_FONTS_PATH = "app/_fonts/app-fonts.ts";
const MARKETING_FONTS_PATH = "app/_fonts/marketing-fonts.ts";
const APP_FONTS = read(APP_FONTS_PATH);
const MARKETING_FONTS = read(MARKETING_FONTS_PATH);
const LAYOUT = read("app/layout.tsx");
const MARKETING_ENTRY = read("app/_components/marketing/fonts.ts");

const ALL_SOURCE = sourceFiles(ROOT).map((file) => {
  const text = readFileSync(file, "utf8");
  return {
    rel: path.relative(ROOT, file),
    specifiers: moduleSpecifiers(text),
    code: codeOnly(text),
  };
});

describe("the comment handling this guard depends on", () => {
  // If these break, every "is absent" assertion below can pass vacuously.
  it("sees an import hidden behind an inline block comment", () => {
    expect(
      moduleSpecifiers('import { Inter } from /* why */ "next/font/google";'),
    ).toContain("next/font/google");
  });

  it("sees an import on a line that STARTS with a block comment", () => {
    expect(
      moduleSpecifiers('/* lead */ import { Inter } from "next/font/google";'),
    ).toContain("next/font/google");
  });

  it("sees a require() and a re-export, not just a bare import", () => {
    expect(moduleSpecifiers('require("next/font/google");')).toContain(
      "next/font/google",
    );
    expect(
      moduleSpecifiers('export { Inter } from "next/font/google";'),
    ).toContain("next/font/google");
  });

  it("does NOT count a genuinely commented-out import", () => {
    expect(
      moduleSpecifiers('// import { Inter } from "next/font/google";'),
    ).toEqual([]);
    expect(
      moduleSpecifiers('/* import { Inter } from "next/font/google"; */'),
    ).toEqual([]);
  });

  it("keeps a host inside a string but drops one inside a comment", () => {
    // The naive fix - deleting from `//` to end of line - would eat the host
    // out of "https://fonts.gstatic.com" and hide a real reference.
    expect(codeOnly('const u = "https://fonts.gstatic.com/x";')).toMatch(
      GOOGLE_FONT_HOST,
    );
    expect(codeOnly("// we never call https://fonts.gstatic.com now")).not.toMatch(
      GOOGLE_FONT_HOST,
    );
  });
});

describe("the build never depends on Google Fonts", () => {
  it("no source file imports next/font/google", () => {
    const offenders = ALL_SOURCE.filter(({ specifiers }) =>
      specifiers.includes("next/font/google"),
    ).map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it("no source file references the Google Fonts hosts", () => {
    const offenders = ALL_SOURCE.filter(
      ({ rel, code }) =>
        !MAY_NAME_GOOGLE_FONT_HOSTS.has(rel) && GOOGLE_FONT_HOST.test(code),
    ).map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it("guards against a scan that silently walks nothing", () => {
    // A walker that returned [] would make every assertion above pass
    // vacuously. Pin that it really reached the application source AND the
    // build-path files, which are the ones a narrower scan would have missed.
    const paths = ALL_SOURCE.map(({ rel }) => rel);
    expect(ALL_SOURCE.length).toBeGreaterThan(500);
    expect(paths).toContain("app/layout.tsx");
    expect(paths).toContain(APP_FONTS_PATH);
    expect(paths).toContain("next.config.ts");
    expect(paths).toContain(path.join("scripts", "check-production-env-gates.mjs"));
  });
});

describe("the faces are loaded from local files", () => {
  it("both font modules use next/font/local", () => {
    expect(moduleSpecifiers(APP_FONTS)).toContain("next/font/local");
    expect(moduleSpecifiers(MARKETING_FONTS)).toContain("next/font/local");
  });

  it("every referenced .woff2 exists in the repository", () => {
    const referenced = new Set<string>();
    for (const src of [APP_FONTS, MARKETING_FONTS]) {
      for (const m of src.matchAll(/path:\s*"\.\/([^"]+\.woff2)"/g)) {
        referenced.add(m[1]);
      }
    }
    // A renamed or dropped binary is a build failure, not a visual bug, so it
    // is worth catching here rather than in a browser lane.
    expect(referenced.size).toBeGreaterThan(0);
    const missing = [...referenced].filter(
      (file) => !existsSync(path.join(ROOT, "app/_fonts", file)),
    );
    expect(missing).toEqual([]);
  });

  it("serves the full OFL notice from the DEPLOYED artifact", () => {
    // OFL 1.1 clause 2 allows redistribution only if "each copy contains the
    // above copyright notice and this license".
    //
    // A notice sitting in the source tree does not satisfy that for the copies
    // a BROWSER receives. next/font/local emits only the .woff2 into
    // .next/static/media and copies no sibling text file, and the served
    // subsets carry the copyright (name ID 0) and a licence URL (name ID 14)
    // but NOT the licence body - Google's subsetting strips name ID 13. A URL
    // is a pointer to the licence, not the licence.
    //
    // So the notices live in public/, which Next serves verbatim, making them
    // reachable at /fonts/LICENSE-*.txt in the deployed app.
    for (const [file, holder] of [
      ["LICENSE-Inter.txt", "The Inter Project Authors"],
      ["LICENSE-Fraunces.txt", "The Fraunces Project Authors"],
    ]) {
      const full = path.join(ROOT, LICENSE_DIR, file);
      expect(existsSync(full), `${file} must be under ${LICENSE_DIR}`).toBe(true);
      const text = readFileSync(full, "utf8");
      expect(text).toContain(holder);
      // Pin that it is the real licence body, not a stub naming the licence.
      expect(text).toContain("SIL OPEN FONT LICENSE Version 1.1");
      expect(text).toContain(
        "contains the above copyright notice and this license",
      );
      // The clauses that make it a usable licence rather than an excerpt.
      expect(text).toContain("PERMISSION");
      expect(text).toContain("TERMINATION");
      expect(text).toContain("DISCLAIMER");
      expect(text.length).toBeGreaterThan(3500);
    }
  });

  it("the auth middleware does not intercept the served notices", () => {
    // Putting the notices under public/ is NOT sufficient on its own. The
    // Supabase session middleware matches every path that is not explicitly
    // excluded, and it redirects unauthenticated requests to /login. Before the
    // `fonts/` exclusion, GET /fonts/LICENSE-Inter.txt answered 307 -> /login,
    // so the licence was not reachable in the deployed app at all. Files being
    // present in public/ says nothing about them being served.
    const middleware = read("middleware.ts");
    const matcher = middleware.match(/matcher:\s*\[\s*"([^"]+)"/)?.[1];
    expect(matcher, "could not read the middleware matcher").toBeTruthy();
    const pattern = new RegExp(`^${matcher!.replace(/\\\\/g, "\\")}$`);

    for (const licencePath of [
      "/fonts/LICENSE-Inter.txt",
      "/fonts/LICENSE-Fraunces.txt",
    ]) {
      expect(
        pattern.test(licencePath),
        `${licencePath} must NOT be matched by the auth middleware`,
      ).toBe(false);
    }
    // ...and the exclusion must not have swallowed the authenticated app.
    for (const appPath of ["/dashboard", "/settings/data", "/calendar"]) {
      expect(
        pattern.test(appPath),
        `${appPath} MUST still run through the auth middleware`,
      ).toBe(true);
    }
  });

  it("no APP ROUTE may live under /fonts, or it would skip auth", () => {
    // The middleware exemption is a path PREFIX, not a file list. Today
    // /fonts/* resolves only to the static notices under public/fonts and
    // anything else 404s. But if someone later adds app/fonts/<x>/page.tsx or
    // route.ts, that route would answer on an exempted path and silently never
    // run updateSession - an authenticated surface with no auth, introduced by
    // a file addition nowhere near this middleware config.
    //
    // Nothing lives there now, so pin that rather than leave it incidental.
    const appFontsDir = path.join(ROOT, "app", "fonts");
    expect(
      existsSync(appFontsDir),
      "app/fonts/ must not exist: routes there would bypass the auth middleware " +
        "via the `fonts/` exemption in middleware.ts. Serve static font assets " +
        "from public/fonts/ instead.",
    ).toBe(false);
  });

  it("keeps exactly ONE copy of each notice, so they cannot drift", () => {
    // The obvious way to satisfy both "next to the fonts" and "served to the
    // browser" is to keep two copies. Two copies of a licence is how one of
    // them silently stops matching upstream.
    const strays = readdirSync(path.join(ROOT, "app/_fonts")).filter((f) =>
      /LICENSE|OFL/i.test(f),
    );
    expect(strays).toEqual([]);
  });

  it("every SERVED binary carries its own copyright and OFL pointer", () => {
    // The .txt notices stay in the repository - Next emits only the fonts into
    // .next/static/media, so a sibling file is not what makes the BROWSER copy
    // compliant. OFL 1.1 clause 2 accepts the notice "in the appropriate
    // machine-readable metadata fields within text or binary files", and these
    // subsets carry it: name ID 0 (copyright) and name ID 14 (licence URL).
    //
    // Google's subsetting strips name ID 13 (the full licence body), which is
    // why LICENSE-Inter.txt / LICENSE-Fraunces.txt exist alongside them. If a
    // future re-vendor produced binaries stripped of name ID 0 as well, the
    // served copy would carry no notice at all and nothing else would notice.
    const fonts = readdirSync(path.join(ROOT, "app/_fonts")).filter((f) =>
      f.endsWith(".woff2"),
    );
    expect(fonts.length).toBeGreaterThan(0);
    for (const file of fonts) {
      const names = readWoff2NameTable(path.join(ROOT, "app/_fonts", file));
      const family = file.startsWith("inter") ? "Inter" : "Fraunces";
      const holder =
        family === "Inter"
          ? "The Inter Project Authors"
          : "The Fraunces Project Authors";
      expect(names[NAME_ID.copyright], `${file} name ID 0`).toContain(holder);
      expect(names[NAME_ID.licenseInfoUrl], `${file} name ID 14`).toMatch(
        /openfontlicense\.org|scripts\.sil\.org\/OFL/,
      );
      expect(names[NAME_ID.family], `${file} name ID 1`).toBe(family);
    }
  });

  it("the vendored files are real WOFF2 binaries, not placeholders", () => {
    const fonts = readdirSync(path.join(ROOT, "app/_fonts")).filter((f) =>
      f.endsWith(".woff2"),
    );
    expect(fonts.length).toBeGreaterThan(0);
    for (const file of fonts) {
      const buf = readFileSync(path.join(ROOT, "app/_fonts", file));
      // wOF2 magic. Catches an LFS pointer or a truncated download landing
      // here and rendering the whole surface in a fallback face.
      expect(buf.subarray(0, 4).toString("ascii")).toBe("wOF2");
    }
  });
});

describe("the CSS variable contract is unchanged", () => {
  it("still exposes --font-inter, --font-fraunces and --font-marketing-sans", () => {
    expect(APP_FONTS).toMatch(/variable:\s*"--font-inter"/);
    expect(APP_FONTS).toMatch(/variable:\s*"--font-fraunces"/);
    expect(MARKETING_FONTS).toMatch(/variable:\s*"--font-marketing-sans"/);
  });

  it("the root layout applies both variables to <html>", () => {
    expect(moduleSpecifiers(LAYOUT)).toContain("./_fonts/app-fonts");
    expect(codeOnly(LAYOUT)).toMatch(/fraunces\s*\.\s*variable/);
    expect(codeOnly(LAYOUT)).toMatch(/inter\s*\.\s*variable/);
  });

  it("the marketing surface still gets its face from the marketing entry point", () => {
    expect(moduleSpecifiers(MARKETING_ENTRY)).toContain(
      "@/app/_fonts/marketing-fonts",
    );
    expect(MARKETING_ENTRY).toMatch(/export \{ marketingSans \}/);
  });
});

describe("the declared faces match what production rendered", () => {
  // Weights are declared one per `src` entry rather than as a variable range.
  // A range is the tempting simplification and it is NOT equivalent: the root
  // layout deliberately loads Inter 400/500 only, so an authenticated-app
  // element asking for 700 matches the 500 face and the browser SYNTHESISES
  // bold. Declaring "400 700" would start rendering a true 700 there.
  function weightsFor(src: string, file: string): string[] {
    const found = new Set<string>();
    const pattern = new RegExp(
      `path:\\s*"\\./${file.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}",\\s*weight:\\s*"([^"]+)"`,
      "g",
    );
    for (const m of src.matchAll(pattern)) found.add(m[1]);
    return [...found].sort();
  }

  it("root Inter declares 400 and 500 only", () => {
    expect(weightsFor(APP_FONTS, "inter-latin.woff2")).toEqual(["400", "500"]);
  });

  it("marketing Inter declares 400, 500, 600 and 700", () => {
    expect(weightsFor(MARKETING_FONTS, "inter-latin.woff2")).toEqual([
      "400",
      "500",
      "600",
      "700",
    ]);
  });

  it("Fraunces declares 400 and 700 in both normal and italic", () => {
    expect(weightsFor(APP_FONTS, "fraunces-latin.woff2")).toEqual(["400", "700"]);
    expect(weightsFor(APP_FONTS, "fraunces-italic-latin.woff2")).toEqual([
      "400",
      "700",
    ]);
    expect(APP_FONTS).toMatch(
      /"\.\/fraunces-italic-latin\.woff2", weight: "400", style: "italic"/,
    );
  });

  it("no face is declared as a variable weight RANGE", () => {
    // "400 700" rather than "400" - the space is the tell.
    expect(codeOnly(APP_FONTS)).not.toMatch(/weight:\s*"\d+\s+\d+"/);
    expect(codeOnly(MARKETING_FONTS)).not.toMatch(/weight:\s*"\d+\s+\d+"/);
  });

  it("keeps display:swap on every face", () => {
    const calls = (APP_FONTS + MARKETING_FONTS).match(/localFont\(\{/g) ?? [];
    const swaps = (APP_FONTS + MARKETING_FONTS).match(/display:\s*"swap"/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(swaps.length).toBe(calls.length);
  });
});

describe("the marketing faces stay out of the authenticated app", () => {
  it("app-fonts.ts does not declare Inter 600 or 700", () => {
    // Merging the two modules would put real 600/700 on every authenticated
    // route, where bold is currently synthesised from the 500 face.
    const interWeights = new Set<string>();
    for (const m of APP_FONTS.matchAll(
      /path:\s*"\.\/inter-[^"]+\.woff2",\s*weight:\s*"([^"]+)"/g,
    )) {
      interWeights.add(m[1]);
    }
    expect([...interWeights].sort()).toEqual(["400", "500"]);
  });

  it("the root layout does not import the marketing font module", () => {
    expect(moduleSpecifiers(LAYOUT).join(" ")).not.toMatch(/marketing-fonts/);
    expect(moduleSpecifiers(APP_FONTS).join(" ")).not.toMatch(/marketing-fonts/);
  });
});
