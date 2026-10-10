import { test, expect, type Locator, type Page } from "@playwright/test";

// The homepage film (MKT-03 contract; deck v2.2 §12b/§13 before it). Public,
// static, no auth and no seed.
//
// WHAT THIS HAS TO PROVE, AND WHY EACH CHECK CAN ACTUALLY FAIL.
//
//   "it plays on its own"   currentTime advancing with no input, and videoWidth
//                           reporting 1920 — frames decoded. `paused === false`
//                           alone would pass against a file the browser cannot
//                           decode, or a src the middleware bounced to /login.
//   "muted, inline, loop"   read from the element, and the LOOP is observed: at
//                           16x the clock runs past the end, wraps, and is still
//                           playing. An attribute check cannot see a loop break.
//   "Pause is real"         after Pause the clock stops (two reads apart are
//                           equal) and the control says Play; scrolling away
//                           and back does not restart it.
//   "reduced motion"        EMULATED in both directions, never the host's own
//                           setting, and the precondition is asserted: no video
//                           element, zero film requests, a Play button; pressing
//                           it plays and hands focus to Pause.
//   "half on screen"        the RATIO decides, measured in the page each time:
//                           at 30% on screen the film is paused and its clock
//                           still, both on the way out (the very callback that
//                           used to restart it) and on the way in from off
//                           screen; past half it plays. A frame a quarter on
//                           screen at load fetches nothing, and its Play plays.
//   "reduced motion, later" switched on while the film is paused off screen, it
//                           stays still when it returns, and Play and Pause
//                           still work; while it plays, it stops and scrolling
//                           does not restart it; before it ever ran, the
//                           poster's Play comes back and nothing is fetched.
//   "refusal"               play() rejected with NotAllowedError: the poster's
//                           Play button comes back and no control claims Pause;
//                           a person's Play then works.
//   "phone"                 plays inline, runs edge to edge inside the first
//                           screen, the control meets 44px, and nothing in
//                           <main> extends past the viewport — measured per
//                           element, because <main> clips horizontal overflow
//                           and a page-scroll check cannot fail inside it.

const FILM_URL = /\/film\/hone-treatment-memory-v3-1\.mp4/;
const START = /^Play: Hone treatment-memory/;
const PAUSE = "Pause the product film";
const PLAY = "Play the product film";

/** Records every request the page makes for the film. */
function watchFilmRequests(page: Page): string[] {
  const hits: string[] = [];
  page.on("request", (r) => {
    if (FILM_URL.test(r.url())) hits.push(r.url());
  });
  return hits;
}

const film = (page: Page) => page.locator("main figure").first();
const video = (page: Page) => film(page).locator("video");

type Clock = {
  currentTime: number;
  paused: boolean;
  readyState: number;
  networkState: number;
  errorCode: number;
  src: string;
};

const clock = (v: Locator): Promise<Clock> =>
  v.evaluate((node) => {
    const el = node as HTMLVideoElement;
    return {
      currentTime: el.currentTime,
      paused: el.paused,
      readyState: el.readyState,
      networkState: el.networkState,
      errorCode: el.error?.code ?? 0,
      src: el.currentSrc,
    };
  });

/** Frames decoded and the clock moving past `from`, or a diagnosis of why not. */
async function expectAdvancing(v: Locator, from = 0.2): Promise<void> {
  const MEDIA_ERR = ["", "ABORTED", "NETWORK", "DECODE", "SRC_NOT_SUPPORTED"];
  try {
    await expect.poll(async () => (await clock(v)).currentTime, { timeout: 20_000 }).toBeGreaterThan(from);
  } catch {
    const d = await clock(v);
    throw new Error(
      `the film never advanced past ${from}. currentTime=${d.currentTime} readyState=${d.readyState} ` +
        `networkState=${d.networkState} paused=${d.paused} error=${MEDIA_ERR[d.errorCode] || "none"} ` +
        `currentSrc=${d.src || "(none)"}`,
    );
  }
}

async function expectReducedMotion(page: Page, reduce: boolean): Promise<void> {
  // The proof checks its own precondition, so it cannot pass on the host's
  // setting by accident.
  expect(
    await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches),
  ).toBe(reduce);
}

/** Paused, and the clock does not move over `ms`. */
async function expectStill(v: Locator, ms: number): Promise<void> {
  const before = await clock(v);
  await v.page().waitForTimeout(ms);
  const after = await clock(v);
  expect(after.paused, "the film is playing").toBe(true);
  expect(after.currentTime, "the film's clock moved").toBe(before.currentTime);
}

const frameOf = (page: Page) => film(page).locator(":scope > div").first();

/** The share of the frame inside the viewport, as the observer measures it. */
function visibleShare(page: Page): Promise<number> {
  return frameOf(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const visible = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    return Math.max(0, visible) / r.height;
  });
}

/** Scroll so that `share` of the frame is on screen, its top part scrolled away. */
async function showShare(page: Page, share: number): Promise<void> {
  await frameOf(page).evaluate((el, s) => {
    const r = el.getBoundingClientRect();
    window.scrollTo({ top: r.top + window.scrollY + (1 - s) * r.height, behavior: "instant" });
  }, share);
}

const scrollToEnd = (page: Page) =>
  page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
const scrollToTop = (page: Page) => page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));

// A laptop window with the browser's own chrome taking height: the frame starts
// part-way on screen. Asserted, never assumed, by every test that uses it.
const PART_WAY = { width: 1440, height: 600 };

async function expectPartWay(page: Page): Promise<void> {
  const share = await visibleShare(page);
  expect(share, `precondition: ${share.toFixed(2)} of the frame on screen`).toBeGreaterThan(0.1);
  expect(share, `precondition: ${share.toFixed(2)} of the frame on screen`).toBeLessThan(0.45);
}

// TWO MEANINGS OF `isIntersecting`, AND WHY THE PARTIAL-VISIBILITY TESTS RUN
// UNDER BOTH. Measured in Chromium 148: with `threshold: 0.5`, a frame 30% on
// screen reports `isIntersecting: false`, because Chromium counts a target as
// intersecting only once its ratio reaches the lowest threshold. The spec
// counts ANY overlap, and notifies when a target enters or leaves the viewport
// as well. So in plain Chromium a player that gates on `isIntersecting` behaves
// as if it read the ratio, and these tests could never catch the difference:
// against the first version they passed in Chromium. Under the spec's meaning
// they fail against it, as they must.
type Semantics = "chromium" | "spec";
const SEMANTICS: Semantics[] = ["chromium", "spec"];

/**
 * Give Chromium the spec's `isIntersecting`: add a 0 threshold (which makes
 * its flag mean "any overlap") and deliver entries only when the spec would,
 * on a change of threshold index or of `isIntersecting`, for the thresholds
 * the page asked for.
 */
async function useSemantics(page: Page, semantics: Semantics): Promise<void> {
  if (semantics === "chromium") return;
  await page.addInitScript(() => {
    const Native = window.IntersectionObserver;
    window.IntersectionObserver = class extends Native {
      constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
        const asked = [options.threshold ?? 0].flat().sort((a, b) => a - b);
        const last = new Map<Element, string>();
        super(
          (entries, observer) => {
            const due = entries.filter((e) => {
              const state = `${asked.filter((t) => t <= e.intersectionRatio).length}:${e.isIntersecting}`;
              if (last.get(e.target) === state) return false;
              last.set(e.target, state);
              return true;
            });
            if (due.length > 0) callback(due, observer);
          },
          { ...options, threshold: [0, ...asked] },
        );
      }
    };
  });
}

/** What a 0.5-threshold observer reports as `isIntersecting` for the frame right now. */
function reportsIntersecting(page: Page): Promise<boolean> {
  return frameOf(page).evaluate(
    (el) =>
      new Promise<boolean>((resolve) => {
        const io = new IntersectionObserver(
          ([entry]) => {
            io.disconnect();
            resolve(entry!.isIntersecting);
          },
          { threshold: 0.5 },
        );
        io.observe(el);
      }),
  );
}

/** Under the spec's meaning, prove the shim is live: a frame part-way on screen IS intersecting. */
async function expectSemantics(page: Page, semantics: Semantics): Promise<void> {
  if (semantics === "spec") {
    expect(await reportsIntersecting(page), "the spec's isIntersecting is not in force").toBe(true);
  }
}

/** Elements inside <main> whose box reaches past the viewport's edges. */
async function pastTheViewport(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const width = document.documentElement.clientWidth;
    for (const el of document.querySelectorAll("main *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.closest(".sr-only")) continue;
      if (r.right > width + 1 || r.left < -1) {
        out.push(`${el.tagName.toLowerCase()} left=${Math.round(r.left)} right=${Math.round(r.right)}`);
      }
    }
    return out;
  });
}

test.describe("homepage film (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
  });

  test("plays on its own: muted, inline, decoded, in the first screen", async ({ page }) => {
    const hits = watchFilmRequests(page);
    await page.goto("/");
    await expectReducedMotion(page, false);

    // The opening is compact: the film starts in the top half of the screen.
    const box = await film(page).boundingBox();
    expect(box, "film has no box").not.toBeNull();
    expect(box!.y, `film starts ${box!.y}px down`).toBeLessThan(450);

    await expect(video(page)).toHaveCount(1);
    await expectAdvancing(video(page));

    const state = await video(page).evaluate((node) => {
      const el = node as HTMLVideoElement;
      return {
        paused: el.paused,
        muted: el.muted,
        loop: el.loop,
        playsInline: el.playsInline,
        controls: el.controls,
        width: el.videoWidth,
        height: el.videoHeight,
      };
    });
    expect(state).toMatchObject({
      paused: false,
      muted: true,
      loop: true,
      playsInline: true,
      controls: false,
      width: 1920,
      height: 1080,
    });

    // The control says what is true, and nothing sits on the picture.
    await expect(page.getByRole("button", { name: PAUSE })).toBeVisible();
    await expect(page.getByRole("button", { name: START })).toHaveCount(0);

    // The disclosure and the transcript are both there while it plays.
    await expect(page.getByText("Demo data. Actual Hone application.").first()).toBeVisible();
    await expect(page.getByText(/Areas treated, how she responded/).first()).toBeAttached();

    expect(hits.length, "the film was never fetched").toBeGreaterThan(0);
  });

  test("loops: the clock wraps past the end and keeps playing", async ({ page }) => {
    await page.goto("/");
    const v = video(page);
    await expectAdvancing(v);

    // 25 seconds at 16x is about 1.6 seconds a pass. Watch for the clock going
    // BACKWARDS while still playing and without an `ended`: that is the wrap.
    const wrapped = await v.evaluate(
      (node) =>
        new Promise<string>((resolve) => {
          const el = node as HTMLVideoElement;
          el.playbackRate = 16;
          let last = el.currentTime;
          let ended = false;
          el.addEventListener("ended", () => {
            ended = true;
          });
          const timer = setInterval(() => {
            if (ended) {
              clearInterval(timer);
              resolve("ended");
            } else if (el.currentTime + 1 < last && !el.paused) {
              clearInterval(timer);
              resolve("wrapped");
            }
            last = el.currentTime;
          }, 40);
          setTimeout(() => {
            clearInterval(timer);
            resolve(`timeout at ${el.currentTime}`);
          }, 15_000);
        }),
    );
    expect(wrapped, "the film did not loop").toBe("wrapped");
    await expectAdvancing(v, 0);
  });

  test("Pause stops the clock, survives scrolling, and Play resumes from the keyboard", async ({ page }) => {
    await page.goto("/");
    const v = video(page);
    await expectAdvancing(v);

    await page.getByRole("button", { name: PAUSE }).click();
    const play = page.getByRole("button", { name: PLAY });
    await expect(play).toBeVisible();

    const t1 = (await clock(v)).currentTime;
    await page.waitForTimeout(700);
    const t2 = await clock(v);
    expect(t2.paused).toBe(true);
    expect(t2.currentTime, "the clock kept moving after Pause").toBe(t1);

    // A person's Pause is final: out of view and back must not restart it.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(900);
    expect((await clock(v)).paused, "scrolling restarted a film the visitor paused").toBe(true);

    // Reachable and operable without a pointer, and the focus is drawn.
    await play.focus();
    await page.keyboard.press("Enter");
    const pause = page.getByRole("button", { name: PAUSE });
    await expect(pause).toBeFocused();
    await expectAdvancing(v, t2.currentTime + 0.2);
    expect(await pause.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
  });

  test("stops while scrolled out of view and resumes in view", async ({ page }) => {
    await page.goto("/");
    const v = video(page);
    await expectAdvancing(v);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(async () => (await clock(v)).paused, { timeout: 5_000 }).toBe(true);

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(async () => (await clock(v)).paused, { timeout: 5_000 }).toBe(false);
    await expect(page.getByRole("button", { name: PAUSE })).toBeVisible();
  });

  for (const semantics of SEMANTICS) {
    test(`plays only while at least half the frame is on screen, in both directions (${semantics} isIntersecting)`, async ({
      page,
    }) => {
      await useSemantics(page, semantics);
      await page.goto("/");
      const v = video(page);
      await expectAdvancing(v);

      // ON THE WAY OUT. 30% left on screen. The observer's callback fires as
      // the frame drops below half, and under the spec `isIntersecting` is
      // still true inside it: the first version played on that callback
      // instead of pausing.
      await showShare(page, 0.3);
      expect(await visibleShare(page)).toBeCloseTo(0.3, 1);
      await expectSemantics(page, semantics);
      await expect.poll(async () => (await clock(v)).paused, { timeout: 5_000 }).toBe(true);
      await expectStill(v, 900);

      // ON THE WAY IN. From fully off screen back to the same 30%: entering
      // the viewport is not being half on screen.
      await scrollToEnd(page);
      await expect.poll(() => visibleShare(page)).toBe(0);
      await showShare(page, 0.3);
      await expectStill(v, 900);

      // Past half, it plays again by itself.
      await showShare(page, 0.7);
      expect(await visibleShare(page)).toBeCloseTo(0.7, 1);
      await expect.poll(async () => (await clock(v)).paused, { timeout: 5_000 }).toBe(false);
      await expectAdvancing(v, (await clock(v)).currentTime + 0.2);
    });
  }

  test("a refused autoplay puts the poster's Play back, and a person's Play still works", async ({ page }) => {
    // Low Power Mode, a data saver or a site setting can refuse play(). Refuse
    // it here until the test says otherwise, with the error a browser uses.
    await page.addInitScript(() => {
      const w = window as unknown as { __honeAllowPlay?: boolean };
      w.__honeAllowPlay = false;
      const original = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
        if (!w.__honeAllowPlay) {
          return Promise.reject(new DOMException("refused by the test", "NotAllowedError"));
        }
        return original.call(this);
      };
    });
    await page.goto("/");

    const start = page.getByRole("button", { name: START });
    await expect(start).toBeVisible();
    // No control is left claiming the film is playing.
    await expect(page.getByRole("button", { name: PAUSE })).toHaveCount(0);
    await expect(page.getByRole("button", { name: PLAY })).toHaveCount(0);
    expect((await clock(video(page))).paused).toBe(true);

    await page.evaluate(() => {
      (window as unknown as { __honeAllowPlay?: boolean }).__honeAllowPlay = true;
    });
    await start.click();
    await expectAdvancing(video(page));
    await expect(page.getByRole("button", { name: PAUSE })).toBeFocused();
  });

  test("the poster is preloaded eagerly, and is never the lazy straggler", async ({ page }) => {
    // `priority` guarantees a preload link the scanner sees, and the film now
    // sits inside the first screen, so the poster is what paints first there.
    await page.goto("/");

    const preload = page.locator('link[rel="preload"][as="image"]');
    await expect(preload, "next/image `priority` must emit a preload link for the poster").toHaveCount(1);

    // READ THE WHOLE TAG, not one attribute. A responsive preload carries its
    // candidates in `imagesrcset` and has NO `href`, so an href assertion reads
    // null against a perfectly correct preload.
    const tag = await preload.evaluate((el) => el.outerHTML);
    expect(tag, `image preload does not name the poster: ${tag}`).toMatch(
      /treatment-memory-setup-frame|_next%2Fstatic|_next\/image/,
    );

    const poster = film(page).locator("img").first();
    await expect.poll(async () => poster.evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await poster.getAttribute("loading")).not.toBe("lazy");
  });
});

test.describe("homepage film (reduced motion)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("starts on the poster, fetches nothing, and plays only when asked", async ({ page }) => {
    const hits = watchFilmRequests(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expectReducedMotion(page, true);

    await expect(video(page)).toHaveCount(0);
    expect(hits, "the film was fetched under reduced motion").toHaveLength(0);

    // Reduced motion refrains from moving; it does not remove the film.
    const start = page.getByRole("button", { name: START });
    await expect(start).toBeVisible();
    await start.focus();
    await page.keyboard.press("Enter");

    // The button that was pressed is gone; focus is on its successor.
    await expect(page.getByRole("button", { name: PAUSE })).toBeFocused();
    await expectAdvancing(video(page));
    expect(hits.length, "Play did not fetch the film").toBeGreaterThan(0);
  });

  test("Save-Data is honoured the same way", async ({ page }) => {
    const hits = watchFilmRequests(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "connection", { value: { saveData: true }, configurable: true });
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("button", { name: START })).toBeVisible();
    await expect(video(page)).toHaveCount(0);
    expect(hits, "the film was fetched against Save-Data").toHaveLength(0);
  });

  test("switched on while the film is off screen: it stays still when it returns", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    const v = video(page);
    await expectAdvancing(v);

    // Off screen the observer has already paused it, so nothing is PLAYING
    // when the preference changes: the case the first version ignored, which
    // left the film in auto mode to start again on its way back.
    await scrollToEnd(page);
    await expect.poll(async () => (await clock(v)).paused, { timeout: 5_000 }).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expectReducedMotion(page, true);

    await scrollToTop(page);
    expect(await visibleShare(page), "precondition: back in view").toBeGreaterThan(0.5);
    await expectStill(v, 1_200);
    const play = page.getByRole("button", { name: PLAY });
    await expect(play).toBeVisible();
    await expect(page.getByRole("button", { name: PAUSE })).toHaveCount(0);

    // The visitor keeps the control: Play plays, and their Pause stops it.
    await play.click();
    await expectAdvancing(v, (await clock(v)).currentTime + 0.2);
    await page.getByRole("button", { name: PAUSE }).click();
    await expect(page.getByRole("button", { name: PLAY })).toBeVisible();
    await expectStill(v, 700);
  });

  test("switched on while the film plays: it stops, and scrolling away and back does not restart it", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    const v = video(page);
    await expectAdvancing(v);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(async () => (await clock(v)).paused, { timeout: 5_000 }).toBe(true);
    await expect(page.getByRole("button", { name: PLAY })).toBeVisible();

    await scrollToEnd(page);
    await page.waitForTimeout(500);
    await scrollToTop(page);
    expect(await visibleShare(page), "precondition: back in view").toBeGreaterThan(0.5);
    await expectStill(v, 1_200);
  });
});

for (const semantics of SEMANTICS) {
  test.describe(`homepage film (part-way on screen at load, ${semantics} isIntersecting)`, () => {
    test.use({ viewport: PART_WAY });

    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await useSemantics(page, semantics);
    });

    test("fetches and starts nothing, and its Play still plays", async ({ page }) => {
      const hits = watchFilmRequests(page);
      await page.goto("/");
      await page.waitForLoadState("networkidle");
      await expectPartWay(page);
      await expectSemantics(page, semantics);

      // The first version gated on `isIntersecting`, true at any overlap, so a
      // strip of frame at the bottom of the window started the film.
      await page.waitForTimeout(700);
      await expect(video(page)).toHaveCount(0);
      expect(hits, "the film was fetched while less than half on screen").toHaveLength(0);

      // Play under the frame, pressed without scrolling the frame into view: a
      // person's start before the page has created the film at all, which the
      // first version's Play answered by doing nothing.
      const play = page.getByRole("button", { name: PLAY });
      await play.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: PAUSE })).toBeFocused();
      await expectAdvancing(video(page));
      await expectPartWay(page);
    });

    test("reduced motion switched on before the film ever ran: the poster's Play, and nothing fetched", async ({ page }) => {
      const hits = watchFilmRequests(page);
      await page.goto("/");
      await page.waitForLoadState("networkidle");
      await expectPartWay(page);
      await expectSemantics(page, semantics);
      await expect(video(page)).toHaveCount(0);

      await page.emulateMedia({ reducedMotion: "reduce" });
      await expectReducedMotion(page, true);
      // The state a reduced-motion visit begins in.
      const start = page.getByRole("button", { name: START });
      await expect(start).toBeAttached();
      await expect(page.getByRole("button", { name: PLAY })).toHaveCount(0);

      // Brought well past half on screen, it still does not start by itself.
      await showShare(page, 0.75);
      expect(await visibleShare(page), "precondition: well past half on screen").toBeGreaterThan(0.7);
      await page.waitForTimeout(1_200);
      await expect(video(page)).toHaveCount(0);
      expect(hits, "the film was fetched after reduced motion was switched on").toHaveLength(0);

      await start.click();
      await expectAdvancing(video(page));
      await expect(page.getByRole("button", { name: PAUSE })).toBeFocused();
    });
  });
}

test.describe("homepage film (phone)", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("plays inline, runs edge to edge in the first screen, and nothing passes the edge", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");

    const frame = film(page).locator(":scope > div").first();
    const box = await frame.boundingBox();
    expect(box, "film frame has no box").not.toBeNull();
    expect(Math.round(box!.x)).toBe(0);
    expect(Math.round(box!.width)).toBe(390);
    expect(box!.y + box!.height, "the film is not entirely in the first screen").toBeLessThanOrEqual(844);

    await expectAdvancing(video(page));
    expect(await video(page).evaluate((v) => (v as HTMLVideoElement).playsInline)).toBe(true);

    const toggle = page.getByRole("button", { name: PAUSE });
    const t = await toggle.boundingBox();
    expect(t!.width).toBeGreaterThanOrEqual(44);
    expect(t!.height).toBeGreaterThanOrEqual(44);

    // ANTI-VACUITY FIRST: the detector must see a deliberate overflow, or its
    // empty answer below means nothing. <main> clips overflow-x, so this is
    // exactly the kind of overflow a page-scroll check would never report.
    await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.id = "overflow-probe";
      probe.style.width = "3000px";
      probe.style.height = "4px";
      document.querySelector("main")!.appendChild(probe);
    });
    expect((await pastTheViewport(page)).length, "the overflow detector is blind").toBeGreaterThan(0);
    await page.evaluate(() => document.getElementById("overflow-probe")!.remove());

    expect(await pastTheViewport(page), "content reaches past the phone's edge").toEqual([]);
  });
});
