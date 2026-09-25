import { describe, expect, it } from "vitest";
import sharp from "sharp";
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
  //
  // READ FROM THE COMPONENT rather than restated here. A literal list in this
  // file would keep passing after someone adds a fourth tier to the srcSet and
  // ships no file for it — the browser would then request a 404 on exactly the
  // displays that asked for the largest image, which is the least-tested
  // configuration and the one nobody notices.
  const WIDTHS: number[] = (() => {
    const m = read(MEDIA).match(/const WIDTHS = \[([\d,\s]+)\]/);
    expect(m, `${MEDIA}: no WIDTHS array to read`).not.toBeNull();
    return m![1].split(",").map((n) => Number(n.trim()));
  })();

  it("media.tsx still builds screenshot URLs from a stem and a width", () => {
    // The premise the reconstruction below depends on. If the component stops
    // composing paths this way, this fails rather than letting the next test
    // check paths the product no longer requests.
    const media = read(MEDIA);
    expect(media).toContain("/marketing/treatment-memory/");
    expect(media).toMatch(/\$\{src\}-1600\.webp/);
    expect(media).toMatch(/\$\{src\}-\$\{w\}\.webp \$\{w\}w/);
    expect(WIDTHS.length, "fewer than two widths is not a srcSet").toBeGreaterThanOrEqual(2);
  });

  it("the declared slot width is measured, not guessed", () => {
    // `sizes` is the only input the browser has for picking a file, and an
    // under-stated slot silently downgrades every image. It was wrong once
    // already: the first version claimed 68rem against a shell that renders
    // 86vw up to a 87.5rem cap. Pin it to the shell it actually measures.
    const globals = read("app/globals.css");
    expect(
      globals,
      ".mk-shell changed shape — re-measure the figure slot before trusting sizes",
    ).toMatch(/\.mk-shell\s*\{\s*width:\s*min\(100% - clamp\(3rem, 14vw, 15rem\), 87\.5rem\)/);
    const media = read(MEDIA);
    expect(media).toContain("86vw");
    expect(media).toContain("1400px");
  });

  it("every ScreenFigure stem resolves to both width variants", () => {
    const stems = [...read(PAGE).matchAll(/base="([a-z0-9-]+)"/g)].map((m) => m[1]);
    // THREE, not four. The carry-forward section's figure was removed because
    // its capture rendered a WATCH TODAY panel built from the retired
    // `caution_note` input; see the comment at that section. This floor is an
    // anti-vacuity guard, not a target — it only has to be high enough that an
    // empty match set cannot pass.
    expect(stems.length, "no ScreenFigure stems found — vacuous").toBeGreaterThanOrEqual(3);
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

describe("the session-record figure is a crop, and stays one", () => {
  // WHY A PIXEL CHECK AND NOT A COMMENT. The full-viewport capture of this
  // screen carries a blue WATCH TODAY panel, which `point-of-care-memory.ts`
  // builds from `session_blocks.caution_note` — an input PR #199 retired. A
  // marketing figure showing it advertises a workflow no practitioner can
  // start, and no assertion over the PAGE can see that: the defect lives in
  // the image bytes. Re-exporting this figure from the uncropped frame is a
  // one-line mistake that every other test here would wave through.
  const DIR = "public/marketing/treatment-memory";
  const WIDTHS = [800, 1600, 2400];

  /** Mean (blue - red) per row. The panel's tint is ~16; plain paper is ~0. */
  async function maxRowBlueTint(rel: string): Promise<number> {
    const { data, info } = await sharp(path.join(ROOT, rel))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    let worst = -Infinity;
    for (let y = 0; y < height; y++) {
      let r = 0;
      let b = 0;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * channels;
        r += data[i];
        b += data[i + 2];
      }
      worst = Math.max(worst, (b - r) / width);
    }
    return worst;
  }

  for (const w of WIDTHS) {
    it(`session-record-${w}.webp shows no caution panel`, async () => {
      const tint = await maxRowBlueTint(`${DIR}/session-record-${w}.webp`);
      // Threshold 4 sits far below the panel's measured ~16 and far above the
      // ~0.1 of an untinted row, so it separates the two without being tuned
      // to one encoder's rounding.
      expect(
        tint,
        `session-record-${w}.webp contains a blue-tinted band: the retired ` +
          `WATCH TODAY panel is back in frame`,
      ).toBeLessThan(4);
    });
  }

  it("the detector is real: the UNCROPPED source still trips it", async () => {
    // ANTI-VACUITY, and the only honest way to run this one. A threshold test
    // that has never seen a positive is a test that might be measuring
    // nothing. The original capture is checked in nowhere, so the control is
    // built here: paint one band of the panel's own colour onto a copy of the
    // cropped image and confirm the detector fires.
    const rel = `${DIR}/session-record-1600.webp`;
    const meta = await sharp(path.join(ROOT, rel)).metadata();
    const w = meta.width!;
    const band = await sharp({
      create: { width: w, height: 40, channels: 3, background: { r: 239, g: 246, b: 255 } },
    })
      .png()
      .toBuffer();
    const spoiled = await sharp(path.join(ROOT, rel))
      .composite([{ input: band, top: 10, left: 0 }])
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { data, info } = spoiled;
    let worst = -Infinity;
    for (let y = 0; y < info.height; y++) {
      let r = 0;
      let b = 0;
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * info.channels;
        r += data[i];
        b += data[i + 2];
      }
      worst = Math.max(worst, (b - r) / info.width);
    }
    expect(worst, "the detector cannot see a panel-coloured band").toBeGreaterThan(4);
  });

  it("every variant keeps the SAME crop geometry", async () => {
    // A per-width crop drift would show different content at different
    // viewports — including, potentially, the panel at one size only.
    const ratios: number[] = [];
    for (const w of WIDTHS) {
      const m = await sharp(path.join(ROOT, `${DIR}/session-record-${w}.webp`)).metadata();
      expect(m.width, `session-record-${w}.webp is not ${w} wide`).toBe(w);
      ratios.push(m.width! / m.height!);
    }
    const spread = Math.max(...ratios) - Math.min(...ratios);
    expect(spread, `aspect ratios diverge across widths: ${ratios.join(", ")}`).toBeLessThan(0.02);
  });

  it("the page declares THIS figure's real aspect, not the default", async () => {
    // The declared box is what prevents reflow. An 8:5 declaration over a 30:7
    // crop reserves the wrong height and the prose jumps when the image lands.
    const page = read(PAGE);
    const block = page.slice(page.indexOf('base="session-record"'));
    const width = Number(block.match(/width=\{(\d+)\}/)?.[1]);
    const height = Number(block.match(/height=\{(\d+)\}/)?.[1]);
    expect(width, "no explicit width on the session-record figure").toBeGreaterThan(0);
    expect(height, "no explicit height on the session-record figure").toBeGreaterThan(0);
    const m = await sharp(path.join(ROOT, `${DIR}/session-record-2400.webp`)).metadata();
    const declared = width / height;
    const actual = m.width! / m.height!;
    expect(
      Math.abs(declared - actual),
      `declared ${width}x${height} (${declared.toFixed(3)}) does not match the file ` +
        `${m.width}x${m.height} (${actual.toFixed(3)})`,
    ).toBeLessThan(0.02);
  });
});
