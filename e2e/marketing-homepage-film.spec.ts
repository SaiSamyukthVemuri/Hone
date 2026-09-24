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
    await expect
      .poll(
        async () => video.evaluate((v) => (v as HTMLVideoElement).currentTime),
        { message: "the film never advanced past 0", timeout: 10_000 },
      )
      .toBeGreaterThan(0.2);

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

  test("the poster, not the film, is the largest contentful paint", async ({ page }) => {
    await page.goto("/");
    const lcp = await page.evaluate(
      () =>
        new Promise<string | null>((resolve) => {
          let last: string | null = null;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const e = entry as PerformanceEntry & { url?: string; element?: Element };
              last = e.url || e.element?.tagName || null;
            }
          }).observe({ type: "largest-contentful-paint", buffered: true });
          // LCP settles after the last candidate; a beat is enough on a static
          // page with no client-side data fetching.
          setTimeout(() => resolve(last), 1200);
        }),
    );
    expect(lcp, "no LCP entry was reported at all").not.toBeNull();
    expect(
      lcp,
      `LCP resolved to ${lcp}; the setup-frame poster is meant to be the candidate`,
    ).toMatch(/treatment-memory-setup-frame|_next\/image|IMG/i);
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
