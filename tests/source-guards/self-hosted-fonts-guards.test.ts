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

/**
 * Source text with comments removed and string literals DECODED.
 *
 * Decoded, not merely preserved: `"https://fonts.googleapis.com/css2"` is
 * a real request to the real host, but its source TOKEN spells the escape, so
 * a scan of raw token text sees a string that does not contain the hostname.
 * `getTokenValue()` returns the value the runtime actually gets, which is the
 * thing the invariant is about.
 */
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
    const isStringish =
      token === ts.SyntaxKind.StringLiteral ||
      token === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      token === ts.SyntaxKind.TemplateHead ||
      token === ts.SyntaxKind.TemplateMiddle ||
      token === ts.SyntaxKind.TemplateTail;
    out += (isStringish ? scanner.getTokenValue() : scanner.getTokenText()) + " ";
    token = scanner.scan();
  }
  return out;
}

/**
 * Percent-decoded view of the same text. `fonts.google%61pis.com` is normalised
 * by Node to the real host, so a scan that only sees the literal spelling
 * misses it.
 *
 * Decoded ESCAPE BY ESCAPE, not whole-file. `decodeURIComponent` on the whole
 * text throws on the first malformed sequence - and a bare `"100%"` or a `%`
 * modulo operator is malformed - which would abandon normalisation for the
 * entire file and let a real `%61` host in that same file through.
 */
function percentDecoded(text: string): string {
  return text.replace(/%[0-9A-Fa-f]{2}/g, (escape) => {
    try {
      return decodeURIComponent(escape);
    } catch {
      return escape;
    }
  });
}

/**
 * The same text with `+` concatenation collapsed, so a host split across
 * literals is still seen: `"https://fonts." + "googleapis.com/css2"` scans as
 * `fonts. + googleapis.com` and would otherwise pass.
 *
 * LIMIT, stated rather than implied: this catches literals joined by `+`. It
 * does NOT constant-fold variables, template substitutions, `String.fromCharCode`
 * or base64 - a static scan cannot, in general. That residue is covered at a
 * different level: the build is proven offline by blocking the hosts at
 * node:http/node:https, which denies a constructed URL just as readily as a
 * literal one. This guard is the cheap always-on half; the blocked build is the
 * half that does not care how the string was spelled.
 */
function concatenationCollapsed(text: string): string {
  return text.replace(/\s*\+\s*/g, "");
}

/**
 * EVERY string in middleware.ts's `matcher` array, read from the TypeScript AST.
 *
 * Next treats the entries as alternatives - middleware runs if ANY of them
 * matches - so reading only the first entry would let a later, broader entry
 * silently re-expose a path this guard claims is protected.
 *
 * AST, NOT A REGEX OVER THE SOURCE TEXT. A text scan cannot tell code from a
 * comment or from a different quote style, so a commented-out copy of the old
 * pattern sitting above an active single-quoted `'/fonts/:path*'` would feed
 * this guard the STALE pattern: every boundary assertion would grade the
 * commented matcher and pass, while Next applied the broad live one. Verified
 * against exactly that shape - the text regex returned the commented entry.
 *
 * Returns each literal's VALUE, so escaping is already resolved: the source
 * `"...\\.txt$"` yields `...\.txt$`, which is the regex Next actually compiles.
 */
function middlewareMatchers(): string[] {
  const source = ts.createSourceFile(
    "middleware.ts",
    read("middleware.ts"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === "matcher") ||
        (ts.isStringLiteral(node.name) && node.name.text === "matcher")) &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
          found.push(element.text);
        } else {
          // A computed or spread entry cannot be graded here; surface it rather
          // than silently ignoring an entry that Next will still apply.
          found.push(`<non-literal:${ts.SyntaxKind[element.kind]}>`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// CASE-INSENSITIVE on purpose. Hostnames are case-insensitive in DNS and Node
// normalises them, so `https://FONTS.GOOGLEAPIS.COM/css2` is a perfectly valid
// request that would restore the build-time dependency. A case-sensitive guard
// would stay green while it did. The offline block harness has always used the
// `i` flag; this guard did not, and that asymmetry is exactly the shape of hole
// worth closing - the harness would have refused the request while the guard
// reported the source clean.
const GOOGLE_FONT_HOST = /fonts\.(googleapis|gstatic)\.com/i;

/** `next/font/google` in any casing - module specifiers resolve case-insensitively
 *  on macOS/Windows filesystems, so the same reasoning applies. */
const NEXT_FONT_GOOGLE = /^next\/font\/google$/i;

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
  const code = codeOnly(text);
  return {
    rel: path.relative(ROOT, file),
    specifiers: moduleSpecifiers(text),
    code,
    // What the host scan actually reads: comments stripped, string escapes
    // decoded, percent-escapes decoded, and `+` concatenation collapsed so a
    // host split across literals is still seen.
    scanned:
      percentDecoded(code) + "\n" + concatenationCollapsed(percentDecoded(code)),
  };
});

// Build-time inputs that are NOT source files.
//
// `package.json` defines `npm run build` itself. `vercel.json` can define a
// `buildCommand`, which Vercel runs INSTEAD of that - so a fetch added there
// would restore a production font-host dependency while GitHub CI kept running
// `npm run build` and every code-extension scan stayed green. The two files
// disagreeing about how production is built is precisely the gap.
//
// Scanned whole (no comment stripping - JSON has none).
const BUILD_MANIFESTS = ["package.json", "vercel.json"]
  .filter((rel) => existsSync(path.join(ROOT, rel)))
  .map((rel) => ({
    rel,
    scanned: percentDecoded(readFileSync(path.join(ROOT, rel), "utf8")),
  }));

/** Everything the "no Google host anywhere" invariant must cover. */
const HOST_SCAN_TARGETS = [
  ...ALL_SOURCE.map(({ rel, scanned }) => ({ rel, scanned })),
  ...BUILD_MANIFESTS,
];

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

  it("detects the Google hosts in ANY casing", () => {
    // Hostnames are case-insensitive in DNS and Node normalises them, so all of
    // these are valid requests that would restore the build-time dependency.
    // A case-sensitive guard reports the source clean while the build fetches.
    for (const host of [
      "https://fonts.googleapis.com/css2",
      "https://FONTS.GOOGLEAPIS.COM/css2",
      "https://Fonts.GoogleApis.Com/css2",
      "https://fonts.GSTATIC.com/s/inter.woff2",
    ]) {
      expect(
        GOOGLE_FONT_HOST.test(codeOnly(`const u = "${host}";`)),
        `${host} must be detected`,
      ).toBe(true);
    }
  });

  it("detects a next/font/google import in ANY casing", () => {
    // Module specifiers resolve case-insensitively on macOS and Windows
    // filesystems, so a mis-cased import can still be a live dependency.
    for (const spec of [
      "next/font/google",
      "NEXT/FONT/GOOGLE",
      "Next/Font/Google",
    ]) {
      expect(
        moduleSpecifiers(`import { Inter } from "${spec}";`).some((s) =>
          NEXT_FONT_GOOGLE.test(s),
        ),
        `${spec} must be detected`,
      ).toBe(true);
    }
    // ...but a genuinely different module must not trip it.
    expect(
      moduleSpecifiers('import x from "next/font/local";').some((s) =>
        NEXT_FONT_GOOGLE.test(s),
      ),
    ).toBe(false);
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
      specifiers.some((s) => NEXT_FONT_GOOGLE.test(s)),
    ).map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it("no build-time input references the Google Fonts hosts", () => {
    // Covers source files AND package.json, over text that has had string
    // escapes and percent-encoding decoded - so `a` and `%61` spellings
    // of the hostname are caught, not just the literal one.
    const offenders = HOST_SCAN_TARGETS.filter(
      ({ rel, scanned }) =>
        !MAY_NAME_GOOGLE_FONT_HOSTS.has(rel) && GOOGLE_FONT_HOST.test(scanned),
    ).map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it("CI runs the execution-level host denial on the build", () => {
    // THE OTHER HALF OF THE INVARIANT, and the half the scan above cannot
    // provide. A hostname built from a variable, a template substitution,
    // String.fromCharCode or base64 is invisible to any static scan but still
    // issues a real request. Without this wired into CI, a network-enabled
    // runner stays green while the same commit fails wherever the network is
    // restricted - which is the exact asymmetry this PR exists to remove.
    //
    // Pinned so it cannot be quietly dropped: the preload must exist, and the
    // CI build step must load it.
    const blocker = path.join(ROOT, "scripts", "block-google-fonts.cjs");
    expect(existsSync(blocker), "the block preload must exist").toBe(true);
    const blockerSource = readFileSync(blocker, "utf8");
    expect(blockerSource).toMatch(/node:https/);
    expect(blockerSource).toMatch(/BLOCKED_GOOGLE_FONTS/);

    const ci = read(".github/workflows/ci.yml");
    const buildStep = ci.match(/- name: Build\n[\s\S]*?\n\n/)?.[0] ?? "";
    expect(buildStep, "CI has no Build step").toContain("npm run build");
    expect(
      buildStep,
      "the CI Build step must load scripts/block-google-fonts.cjs via NODE_OPTIONS",
    ).toMatch(/NODE_OPTIONS:\s*--require \.\/scripts\/block-google-fonts\.cjs/);
  });

  it("the host scan reaches package.json, not just code files", () => {
    // Vacuity check for the line above: package.json is not a code extension,
    // so it is added explicitly and could silently fall out.
    expect(HOST_SCAN_TARGETS.map(({ rel }) => rel)).toContain("package.json");
    const manifest = HOST_SCAN_TARGETS.find(({ rel }) => rel === "package.json");
    expect(manifest!.scanned).toContain('"build"');
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

  it("ONLY the two exact licence URLs bypass the auth middleware", () => {
    // THE SECURITY INVARIANT. Putting the notices under public/ is not enough
    // on its own - the Supabase session middleware matches every path it does
    // not explicitly exclude, and before any exclusion existed
    // GET /fonts/LICENSE-Inter.txt answered 307 -> /login, so the licence was
    // unreachable in the deployed app.
    //
    // The first fix excluded the whole `fonts/` PREFIX, and that was an auth
    // hole: Next route groups do not appear in the URL, so
    // `app/(app)/fonts/private/page.tsx` serves `/fonts/private` - a genuine
    // authenticated route that the prefix exempted from updateSession, with no
    // file named `app/fonts/...` anywhere to give it away.
    //
    // So the boundary is the MATCHER, pinned in both directions. Anything that
    // is not one of the two exact licence filenames must still run the
    // middleware, including deeper paths, suffixed paths, and near-miss
    // prefixes.
    // EVERY matcher entry, not just the first. Next treats the array as
    // alternatives, so middleware runs if ANY entry matches. Reading only
    // entry [0] would let a later `/fonts/:path*` re-expose the licence URLs
    // to updateSession while these assertions still passed.
    const entries = middlewareMatchers();
    expect(entries.length, "no middleware matcher entries found").toBeGreaterThan(0);
    const runsMiddleware = (p: string) =>
      entries.some((e) => new RegExp(`^${e}$`).test(p));

    for (const exempt of [
      "/fonts/LICENSE-Inter.txt",
      "/fonts/LICENSE-Fraunces.txt",
    ]) {
      expect(
        runsMiddleware(exempt),
        `${exempt} must NOT be matched by ANY middleware matcher entry`,
      ).toBe(false);
    }

    for (const guarded of [
      // A grouped route resolves here: app/(app)/fonts/private/page.tsx
      "/fonts/private",
      "/fonts/anything",
      // Suffixes must not ride on an exact filename.
      "/fonts/LICENSE-Inter.txt/extra",
      "/fonts/LICENSE-Fraunces.txt/extra",
      // Near-miss prefixes and case.
      "/fonts",
      "/fontsx/dashboard",
      "/xfonts/dashboard",
      "/FONTS/LICENSE-Inter.txt",
      // The authenticated app itself.
      "/dashboard",
      "/calendar",
      "/settings/data",
    ]) {
      expect(
        runsMiddleware(guarded),
        `${guarded} MUST still run through the auth middleware`,
      ).toBe(true);
    }
  });

  it("the exemption is exact-path, not a prefix", () => {
    // Stated separately from the case list so the REASON survives: a bare
    // `fonts/` alternative would re-open the grouped-route hole, and the
    // trailing `$` on each alternative is what prevents it.
    // EXACTLY ONE entry, and this is the load-bearing assertion rather than a
    // tidiness preference. The per-entry evaluation above treats each string as
    // a REGEX, which is not how Next parses path-to-regexp syntax: an added
    // entry like "/fonts/:path*" would be a real, broad matcher that this file
    // would evaluate as a regex and misjudge. Rather than reimplement
    // path-to-regexp to grade a second entry correctly, refuse to have one -
    // any addition, in any syntax, trips here and forces a human to re-derive
    // the boundary.
    const entries = middlewareMatchers();
    expect(
      entries.length,
      "middleware must declare exactly one matcher entry; a second entry in " +
        "path-to-regexp syntax cannot be graded correctly by this guard",
    ).toBe(1);
    // Normalise the source-level escaping first: the file contains `\\.` (a
    // TypeScript string literal escaping a regex dot), which is the same
    // reduction used to build the patterns above.
    // Values come from the AST, so escaping is already resolved.
    const normalised = entries;

    // Enumerate EVERY `/fonts` alternative and compare against the exact
    // allowlist, rather than probing for shapes that look wrong.
    //
    // The previous probe asked "is there a `fonts/` alternative not followed by
    // LICENSE" - which explicitly permitted ANY `LICENSE...` filename. Adding
    // `|fonts/LICENSE-Other.txt$` would have kept one entry, kept both required
    // substrings, matched none of the sampled paths, and passed the probe,
    // while exempting a third path from authentication. Only two notices exist;
    // anything else under /fonts is a boundary change and must be re-derived by
    // a human, not waved through by a pattern that happens to spell LICENSE.
    const fontsAlternatives = normalised.flatMap((e) =>
      [...e.matchAll(/fonts\/[^|)]+/g)].map((m) => m[0]),
    );
    expect(fontsAlternatives.sort()).toEqual(
      [
        "fonts/LICENSE-Fraunces\\.txt$",
        "fonts/LICENSE-Inter\\.txt$",
      ].sort(),
    );
  });

  it("keeps app/fonts/ free as namespace hygiene (NOT the security boundary)", () => {
    // NAMESPACE HYGIENE ONLY. This is deliberately NOT what protects the auth
    // boundary, and must never be described as if it were: it checks a literal
    // directory, while Next route groups are invisible in the URL, so
    // `app/(app)/fonts/private/page.tsx` serves /fonts/private without ever
    // creating `app/fonts/`. Chasing that with a guard would mean
    // reimplementing route-group, parallel-route, interception-route and
    // dynamic-route resolution, and being wrong about any one of them would
    // reopen the hole silently.
    //
    // The actual protection is the exact-path matcher above, which is safe
    // regardless of where a route is declared. This assertion only keeps the
    // obvious collision out of the tree so the two ideas are not confused.
    expect(
      existsSync(path.join(ROOT, "app", "fonts")),
      "app/fonts/ must not exist: serve static font assets from public/fonts/. " +
        "Note this is hygiene, not protection - the auth boundary is the " +
        "exact-path matcher in middleware.ts.",
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
