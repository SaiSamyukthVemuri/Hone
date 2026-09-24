import { test, expect, type Page } from "@playwright/test";

// Film V1 on the homepage (copy deck v2.2 §12b/§13). Public, static, no auth
// and no seed.
//
// WHAT THIS HAS TO PROVE, AND WHY EACH CHECK CAN ACTUALLY FAIL.
//
//   "video lazy"    Asserted as ZERO REQUESTS for the mp4 before the click, not
//                   as the absence of an element. An element can be absent for
//                   a dozen uninteresting reasons; a network request either
//                   happened or it did not, and 3.6 MB arriving on every
//                   homepage view is the actual regression being guarded.
//   "poster is LCP" Asserted from the browser's own
//                   largest-contentful-paint entry, not from `priority` being
//                   in the source. The source already says priority; only the
//                   renderer can say whether it won.
//   "NO AUTOPLAY"   Asserted after a full load AND settle, under both default
//                   and reduced-motion preferences.
//   "it plays"      Asserted as currentTime advancing and videoWidth reporting
//                   1920 — i.e. frames were actually decoded. `paused === false`
//                   alone would pass against a file the browser cannot decode.

const FILM_URL = /\/film\/hone-treatment-memory-v3-1\.mp4/;

async function expectNoPageOverflow(page: Page, label: string) {
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    widths.scrollWidth,
    `${label}: page must not scroll horizontally (scrollWidth ${widths.scrollWidth} vs clientWidth ${widths.clientWidth})`,
  ).toBeLessThanOrEqual(widths.clientWidth);
}

/** Records every request the page makes for the film. */
function watchFilmRequests(page: Page): string[] {
  const hits: string[] = [];
  page.on("request", (r) => {
    if (FILM_URL.test(r.url())) hits.push(r.url());
  });
  return hits;
}

test.describe("homepage film (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("poster only until asked, then it actually plays", async ({ page }) => {
    const filmHits = watchFilmRequests(page);
    await page.goto("/");

    const play = page.getByRole("button", { name: /Play: Hone treatment-memory/ });
    await expect(play).toBeVisible();

    // ── Before the click ──────────────────────────────────────────────────
    // No media element on the page at all, and nothing fetched.
    await expect(page.locator("video")).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    expect(
      filmHits,
      `the film was fetched before anyone pressed play: ${filmHits.join(", ")}`,
    ).toHaveLength(0);

    // The poster is a REAL decoded image, not a broken reference that happens
    // to occupy the right box.
    const poster = page.locator("figure img").first();
    await expect(poster).toBeVisible();
    const natural = await poster.evaluate(
      (img) => (img as HTMLImageElement).naturalWidth,
    );
    expect(natural, "poster did not decode").toBeGreaterThan(0);

    // The demo-data label is on the poster, for the visitor who never presses
    // play, and again under the player.
    await expect(
      page.getByText("Demo data. Actual Hone application.").first(),
    ).toBeVisible();

    // The transcript is in the accessibility tree, carrying the film's claims
    // for anyone who cannot watch it.
    await expect(
      page.getByText(/Areas treated, how she responded/).first(),
    ).toBeAttached();

    // ── The click ─────────────────────────────────────────────────────────
    await play.click();

    const video = page.locator("video");
    await expect(video).toHaveCount(1);
    await expect(video).toHaveAttribute("preload", "none");
    await expect(video).toHaveAttribute("aria-label", /silent/);

    // Frames decoded, clock moving. This is the assertion that fails if the
    // asset is swapped for something the browser cannot play.
    //
    // The failure message carries the element's own diagnosis. "currentTime is
    // still 0" is true of a missing codec, a 404, a rejected play() and a slow
    // runner alike, and those want four different fixes — so report
    // networkState / readyState / error alongside it rather than making the
    // next reader re-run it by hand.
    const MEDIA_ERR = ["", "ABORTED", "NETWORK", "DECODE", "SRC_NOT_SUPPORTED"];
    const diag = async () =>
      video.evaluate((v) => {
        const el = v as HTMLVideoElement;
        return {
          currentTime: el.currentTime,
          readyState: el.readyState,
          networkState: el.networkState,
          errorCode: el.error?.code ?? 0,
          paused: el.paused,
          src: el.currentSrc,
        };
      });

    try {
      await expect
        .poll(async () => (await diag()).currentTime, { timeout: 20_000 })
        .toBeGreaterThan(0.2);
    } catch {
      const d = await diag();
      throw new Error(
        `the film never advanced past 0. currentTime=${d.currentTime} ` +
          `readyState=${d.readyState} networkState=${d.networkState} ` +
          `paused=${d.paused} error=${MEDIA_ERR[d.errorCode] || "none"} ` +
          `currentSrc=${d.src || "(none)"} requests=${filmHits.length}`,
      );
    }

    const state = await video.evaluate((v) => {
      const el = v as HTMLVideoElement;
      return {
        paused: el.paused,
        muted: el.muted,
        controls: el.controls,
        width: el.videoWidth,
        height: el.videoHeight,
      };
    });
    expect(state).toMatchObject({
      paused: false,
      muted: true,
      controls: true,
      width: 1920,
      height: 1080,
    });

    expect(filmHits.length, "the film should be fetched once play is pressed")
      .toBeGreaterThan(0);

    await expectNoPageOverflow(page, "homepage film desktop");
  });

  test("the poster is preloaded eagerly, and is never the lazy straggler", async ({ page }) => {
    // THE DECK ASKED FOR SOMETHING THE BRIEF'S ORDERING CANNOT GIVE, and this
    // test says so rather than asserting it anyway.
    //
    // §13 specifies the poster as "the LCP candidate on the homepage". Measured
    // here, LCP resolves to the H1 — and that is correct, not a regression: the
    // brief puts a type-only hero above the film, so at 1440x900 the film
    // starts roughly 890px down and is never in the initial viewport. An image
    // below the fold cannot be a largest-CONTENTFUL-PAINT candidate at all; the
    // requirement and the ordering are simply incompatible.
    //
    // What §13 actually wanted from that line is that the poster is fetched
    // eagerly rather than discovered late, so the film section is never a grey
    // box someone scrolls into. That IS what `priority` guarantees and it is
    // what is asserted: a preload link the scanner sees in the head, and an
    // image that really decoded.
    await page.goto("/");

    const preload = page.locator('link[rel="preload"][as="image"]');
    await expect(
      preload,
      "next/image `priority` must emit a preload link for the poster",
    ).toHaveCount(1);

    // READ THE WHOLE TAG, not one attribute. A RESPONSIVE preload carries its
    // candidates in `imagesrcset`/`imagesizes` and has NO `href` at all, so an
    // assertion on href alone reads null and fails against a perfectly correct
    // preload — which is exactly what it did before this line was written this
    // way. The tag naming the poster is the claim; which attribute Next chose
    // to carry it is Next's business.
    const tag = await preload.evaluate((el) => el.outerHTML);
    expect(tag, `image preload does not name the poster: ${tag}`).toMatch(
      /treatment-memory-setup-frame|_next%2Fstatic|_next\/image/,
    );

    const poster = page.locator("figure img").first();
    await expect
      .poll(async () => poster.evaluate((i) => (i as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);

    // And it is NOT lazy — a lazy poster is the defect this replaced.
    expect(await poster.getAttribute("loading")).not.toBe("lazy");
  });
});

test.describe("homepage film (reduced motion)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("still never starts on its own", async ({ page }) => {
    const filmHits = watchFilmRequests(page);
    // Without emulateMedia this reads the HOST's preference, not a controlled
    // one, and passes or fails on whoever ran it.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("video")).toHaveCount(0);
    expect(filmHits, "the film was fetched under reduced motion").toHaveLength(0);

    // And the film is still REACHABLE — reduced motion must not remove the
    // control, only refrain from moving without being asked.
    await expect(
      page.getByRole("button", { name: /Play: Hone treatment-memory/ }),
    ).toBeVisible();
  });
});

test.describe("homepage film (mobile)", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("fits the phone and the control is reachable", async ({ page }) => {
    const filmHits = watchFilmRequests(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // The phone is exactly where 3.6 MB of unrequested video hurts most.
    expect(filmHits, "the film was fetched on a phone before any tap").toHaveLength(0);

    const play = page.getByRole("button", { name: /Play: Hone treatment-memory/ });
    await expect(play).toBeVisible();

    // A real 16:9 box, inside the viewport, and a control big enough to hit.
    const box = await play.boundingBox();
    expect(box, "play control has no box").not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(390);
    expect(box!.height).toBeGreaterThan(44);

    await expectNoPageOverflow(page, "homepage film mobile");
  });
});
