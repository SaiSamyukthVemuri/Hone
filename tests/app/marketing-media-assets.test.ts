import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
    // Still literal-checked even though the page currently builds every
    // screenshot URL from a stem: a hand-written path is exactly the kind of
    // thing that gets added later and 404s silently.
    const urls = [...read(PAGE).matchAll(/"(\/marketing\/[^"]+)"/g)].map((m) => m[1]);
    const missing = urls.filter((u) => !existsSync(path.join(ROOT, "public", u)));
    expect(missing, "the page references a missing public asset").toEqual([]);
  });

  it("uses the CANONICAL film rather than shipping a second copy", () => {
    // This page once carried its own 3.5MB copy of the film and its own
    // <video>. MKT-02B (#764) had already published the identical bytes at
    // /film/hone-treatment-memory-v3-1.mp4 behind a shared facade player, so
    // the duplicate was deleted. Two copies of one asset is two things to keep
    // in step; two players for it is two places to get preload, muting and
    // focus wrong.
    const page = read(PAGE);
    expect(page, "the page no longer renders the shared player").toContain(
      'import { ProductFilm } from "../../_components/marketing/ProductFilm"',
    );
    expect(
      existsSync(path.join(ROOT, "public/film/hone-treatment-memory-v3-1.mp4")),
      "the canonical film is missing from public/film",
    ).toBe(true);
    expect(page, "this page declares its own film source again").not.toMatch(
      /src="\/marketing\/[^"]*\.mp4"/,
    );
  });

  it("ships no video of its own under public/marketing", () => {
    // The reverse direction: a duplicate re-added under this page's own
    // directory would not be caught by anything above.
    const dir = path.join(ROOT, "public/marketing");
    const stray: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(mp4|webm|mov|m4v)$/i.test(e.name)) stray.push(full.slice(ROOT.length + 1));
      }
    };
    walk(dir);
    expect(stray, "a second copy of a film is shipped under public/marketing").toEqual([]);
  });
});

describe("the film is public by EXACT PATH, and nothing else is", () => {
  const entry = matcherEntry();
  const runsMiddleware = (p: string) => new RegExp(`^${entry}$`).test(p);
  const FILM = "/film/hone-treatment-memory-v3-1.mp4";

  it("the canonical film bypasses the session check", () => {
    expect(
      runsMiddleware(FILM),
      `${FILM} runs updateSession, so an anonymous visitor is answered 307 -> /login`,
    ).toBe(false);
  });

  it("the page's screenshots bypass it too, by extension", () => {
    expect(runsMiddleware("/marketing/treatment-memory/client-profile-1600.webp")).toBe(false);
  });

  it("NO other mp4 is exempt — the extension is not a free pass", () => {
    // THIS IS THE POINT OF THE EXACT PATH, and it is why this branch's earlier
    // `.mp4` extension exemption was dropped in favour of production's policy.
    // Hone stores clinical media. An extension-wide bypass would serve a
    // private treatment video added later under an authenticated path to
    // anyone, and nothing would announce it.
    for (const p of [
      "/film/another-cut.mp4",
      "/clients/abc/treatment-video.mp4",
      "/marketing/hone-product-overview-v3-1.mp4",
      "/mp4",
    ]) {
      expect(runsMiddleware(p), `${p} MUST still run through the auth middleware`).toBe(true);
    }
  });

  it("a suffix cannot ride the exact path, and /film is not a prefix", () => {
    for (const p of [`${FILM}/extra`, "/film", "/film/private", "/filmx/dashboard"]) {
      expect(runsMiddleware(p), `${p} MUST still run through the auth middleware`).toBe(true);
    }
  });

  it("the page itself, and the authenticated app, still run it", () => {
    for (const p of ["/features/treatment-memory", "/dashboard", "/settings/data"]) {
      expect(runsMiddleware(p), `${p} MUST still run through the auth middleware`).toBe(true);
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

describe("alt text describes only what is in the frame", () => {
  // WHY THIS IS ITS OWN CLASS. A screen-reader user cannot check the picture.
  // Alt text naming content the capture does not contain tells them evidence
  // exists that no sighted visitor can see — a worse failure than saying too
  // little, and one no rendering test catches because the attribute is present
  // and non-empty either way.
  //
  // TWO REAL INSTANCES, both shipped on this page and both removed:
  //   * before-today ended at the "FOR NEXT VISIT" heading with no note text,
  //     while the alt promised "the notes left for this visit";
  //   * client-profile ended at the legacy skin notes, while the alt promised
  //     "treatment history".
  //
  // LITERAL, NOT SEMANTIC. Nothing here can decide in general whether alt text
  // is truthful — that needs a human looking at the image. It pins the phrases
  // that were actually wrong, so re-adding one is red rather than silent.
  const RETIRED = [
    "notes left for this visit",
    "skin type and treatment history",
    "and treatment history",
    "with its own response and tolerance",
    "tolerated less than the lip",
  ];

  /** Every alt attribute on the page. */
  const alts = () =>
    [...read(PAGE).matchAll(/alt="([^"]+)"/g)].map((m) => m[1]);

  it("there are alts to check — otherwise this is vacuous", () => {
    const a = alts();
    expect(a.length, "no alt attributes found").toBeGreaterThanOrEqual(3);
    for (const t of a) {
      expect(t.length, `an alt is too short to describe anything: "${t}"`).toBeGreaterThan(60);
    }
  });

  it("no alt names content proven absent from its capture", () => {
    const offenders: string[] = [];
    for (const t of alts()) {
      for (const phrase of RETIRED) {
        if (t.toLowerCase().includes(phrase)) offenders.push(`${phrase} -> "${t.slice(0, 60)}…"`);
      }
    }
    expect(
      offenders,
      "alt text promises content the capture does not contain",
    ).toEqual([]);
  });

  it("the two corrected alts say where their capture stops", () => {
    // Positive half: the honest version names the cut-off rather than trailing
    // off, so a reader knows the panel heading is the end of the evidence.
    const joined = alts().join(" | ");
    expect(joined, "before-today alt no longer names its cut-off").toContain(
      "headed For next visit, where the capture ends",
    );
    expect(joined, "client-profile alt no longer names its cut-off").toContain(
      "legacy skin notes, where the capture ends",
    );
  });
});
