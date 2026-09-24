import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// MKT-02C: the media this page serves, and the one boundary it had to move.
//
// SCOPE. Two bounded facts, each naming one artefact and one property. This is
// not a scanner and it does not interpret markup: it resolves the asset paths
// the page actually references and asks the filesystem whether they exist, and
// it evaluates the middleware matcher against a fixed list of paths.
//
// WHY IT EXISTS AT ALL. Both defects it covers are SILENT. A mistyped image
// path renders a broken image and fails no test in the suite — every file
// involved is individually valid. And a static asset that is not exempt from
// the auth middleware answers 307 -> /login, so the film on a PUBLIC page plays
// for nobody, which is exactly how the font licences were unreachable before
// their exemption existed.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const PAGE = "app/features/treatment-memory/page.tsx";
const MEDIA = "app/_components/marketing/media.tsx";

/**
 * The matcher entries, read from middleware.ts.
 *
 * Deliberately asserts there is exactly ONE entry before using it, which is the
 * same invariant tests/source-guards/self-hosted-fonts-guards.test.ts pins from
 * the TypeScript AST. Two files parsing this string could otherwise disagree
 * silently; tied to the same invariant, a second entry turns BOTH red and
 * forces a human to re-derive the boundary rather than letting this file grade
 * a path-to-regexp pattern it cannot evaluate.
 */
function matcherEntry(): string {
  const src = read("middleware.ts");
  const block = src.match(/matcher:\s*\[([\s\S]*?)\]/);
  expect(block, "middleware.ts declares no matcher array").not.toBeNull();
  const entries = [...block![1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    JSON.parse(`"${m[1]}"`),
  );
  expect(
    entries.length,
    "middleware must declare exactly one matcher entry; a second cannot be " +
      "graded as a regex here",
  ).toBe(1);
  return entries[0];
}

describe("every media path the page references actually exists", () => {
  // Reconstructed the way the browser resolves it, not grepped as a whole
  // string: the page passes a stem (`base="client-profile"`) and media.tsx
  // appends the width suffix, so no full screenshot URL appears in either file
  // and a naive grep would find nothing and pass vacuously.
  const WIDTHS = [800, 1600];

  it("media.tsx still builds screenshot URLs from a stem and a width", () => {
    // The premise the reconstruction below depends on. If the component stops
    // composing paths this way, this fails rather than letting the next test
    // check paths the product no longer requests.
    const media = read(MEDIA);
    expect(media).toContain("/marketing/treatment-memory/");
    expect(media).toMatch(/\$\{src\}-1600\.webp/);
    expect(media).toMatch(/\$\{src\}-800\.webp 800w/);
  });

  it("every ScreenFigure stem resolves to both width variants", () => {
    const stems = [...read(PAGE).matchAll(/base="([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(stems.length, "no ScreenFigure stems found — vacuous").toBeGreaterThanOrEqual(4);
    expect(new Set(stems).size, "a screenshot is used twice").toBe(stems.length);
    const missing: string[] = [];
    for (const stem of stems) {
      for (const w of WIDTHS) {
        const rel = `public/marketing/treatment-memory/${stem}-${w}.webp`;
        if (!existsSync(path.join(ROOT, rel))) missing.push(rel);
      }
    }
    expect(missing, "the page requests an image that is not in public/").toEqual([]);
  });

  it("every literal /marketing asset URL resolves to a file", () => {
    const urls = [...read(PAGE).matchAll(/"(\/marketing\/[^"]+)"/g)].map((m) => m[1]);
    expect(urls.length, "no literal media URLs found — vacuous").toBeGreaterThanOrEqual(2);
    const missing = urls.filter((u) => !existsSync(path.join(ROOT, "public", u)));
    expect(missing, "the page references a missing public asset").toEqual([]);
  });

  it("the film is referenced, and is the only video shipped for this page", () => {
    // Guards the reverse direction: a 3.5MB binary left in the repo that no
    // page requests is dead weight nothing else would notice.
    const film = "public/marketing/hone-product-overview-v3-1.mp4";
    expect(existsSync(path.join(ROOT, film)), `${film} missing`).toBe(true);
    expect(read(PAGE)).toContain("/marketing/hone-product-overview-v3-1.mp4");
    // A film that quietly grows past a few megabytes stops being appropriate
    // for a marketing page; this is a ceiling, not a measurement.
    const mb = statSync(path.join(ROOT, film)).size / 1024 / 1024;
    expect(mb, `the film is ${mb.toFixed(1)}MB`).toBeLessThan(6);
  });
});

describe("the film is reachable by the anonymous visitors it exists for", () => {
  const entry = matcherEntry();
  const runsMiddleware = (p: string) => new RegExp(`^${entry}$`).test(p);

  it("static media served from public/ does NOT run the auth middleware", () => {
    for (const p of [
      "/marketing/hone-product-overview-v3-1.mp4",
      "/marketing/treatment-memory/client-profile-1600.webp",
    ]) {
      expect(
        runsMiddleware(p),
        `${p} runs updateSession, so an anonymous visitor is answered 307 -> /login`,
      ).toBe(false);
    }
  });

  it("the exemption is extension-anchored, not a /marketing prefix", () => {
    // THE HOLE THIS REFUSES. Exempting the `marketing/` prefix would be the
    // same defect the `fonts/` prefix was: Next route groups do not appear in
    // the URL, so a grouped route could serve a real authenticated page under
    // that prefix with nothing named `app/marketing/...` to give it away.
    // Only the trailing `$` on a literal extension keeps this narrow.
    for (const p of [
      "/marketing/anything",
      "/marketing/treatment-memory",
      // A path containing .mp4 that does not END in it must stay guarded.
      "/clients/x.mp4/edit",
      // A route merely named for the extension is not an asset.
      "/mp4",
    ]) {
      expect(runsMiddleware(p), `${p} MUST still run through the auth middleware`).toBe(
        true,
      );
    }
  });

  it("the page itself, and the authenticated app, still run it", () => {
    for (const p of ["/features/treatment-memory", "/dashboard", "/settings/data"]) {
      expect(runsMiddleware(p), `${p} MUST still run through the auth middleware`).toBe(
        true,
      );
    }
  });
});
