import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eClient,
  seedE2eEndedAppointmentSession,
  setStudioPostcareText,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// UX-01 Quick Wins — the four visual/keyboard repairs, in a real browser.
//
// Each quick win is measured rather than described: a contrast ratio computed
// from painted colours, a box height read from the rendered control, a focus
// location read from `document.activeElement`. A class-string assertion would
// pass on a token that never reaches the element.
//
// WHAT IS DELIBERATELY NOT HERE. QW5 is a radius swap with no behavioural
// surface beyond the painted corner, so it is pinned at source plus a computed
// `border-radius` read below.
//
// BOTH postcare dialogs ARE driven here. An earlier revision proved only the
// settings preview and argued the calendar one shared its mechanism, which was
// true but insufficient: the two differ in the single most consequential way —
// the calendar dialog's confirm hands an email to a PROVIDER, so its Escape is
// idle-gated and the preview's is not. A shared-mechanism argument cannot prove
// an asymmetry, so the in-flight case is now driven against a real held Server
// Action rather than inferred.

const T = 60_000;
const WIDTHS = [
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440", width: 1440, height: 900 },
] as const;

/**
 * The painted contrast ratio of an element against the surface behind it.
 *
 * COLOURS ARE NORMALISED THROUGH A CANVAS, not parsed with a regex. This app's
 * tokens are authored in `oklch()` and Chromium returns them that way from
 * `getComputedStyle`, so pulling "the first three numbers" out of
 * `oklch(0.205 0 0)` yields the RGB triple `[0.205, 0, 0]` — near-black for
 * every colour in the palette. The first version of this helper did exactly
 * that and reported a ratio of 1.00:1 for text and background that actually
 * measure ~16:1, i.e. it would have failed a correct fix and passed a broken
 * one. Painting the colour and reading the pixel back gives sRGB bytes for any
 * CSS colour syntax.
 */
async function contrastAt(page: Page, selector: string): Promise<number | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    const toRgba = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    };
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.slice(0, 3).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const fg = toRgba(getComputedStyle(el).color);
    // The nearest ancestor that actually paints — what the ink sits on.
    let node: Element | null = el;
    let bg: number[] = [255, 255, 255, 1];
    while (node) {
      const c = toRgba(getComputedStyle(node).backgroundColor);
      if (c[3] > 0) {
        bg = c;
        break;
      }
      node = node.parentElement;
    }
    const a = lum(fg);
    const b = lum(bg);
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
  }, selector);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe("UX-01 QW1 · the dashboard day-nav marks where you are", () => {
  test.setTimeout(T * 2);

  test("the current day left the muted vocabulary: live ink, its own ground", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);
    await page.goto("/dashboard");

    const today = page.getByTestId("dashboard-today");
    await expect(today).toBeVisible({ timeout: T });
    // Semantics were already correct and must survive the repaint.
    await expect(today).toHaveAttribute("aria-current", "page");

    const currentRatio = await contrastAt(page, '[data-testid="dashboard-today"]');
    expect(currentRatio).not.toBeNull();

    // THE DEFECT, inverted back. The day you are on used to render in the
    // disabled vocabulary at ≈2.5:1 while its live siblings rendered normally.
    expect(
      currentRatio!,
      `current-day contrast ${currentRatio!.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(4.5);

    // MARKED BY GROUND, NOT BY DIMMING — which is the actual contract, and not
    // the same claim as "has the highest ratio in the row".
    //
    // An earlier version of this test asserted `current >= next` and failed at
    // 16.44 vs 17.93. That was the assertion being wrong, not the fix: a filled
    // chip scores slightly BELOW black-on-white by construction, while reading
    // as more prominent. Contrast ratio is not prominence, and requiring the
    // marked item to win a ratio comparison would forbid every filled state in
    // the product.
    //
    // What the repair actually promises is that the current segment left the
    // MUTED vocabulary: it now carries the same ink as a live sibling, and is
    // distinguished by a ground the sibling does not have.
    const ink = await page.evaluate(() => {
      const read = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const s = getComputedStyle(el);
        return { color: s.color, bg: s.backgroundColor };
      };
      return {
        current: read('[data-testid="dashboard-today"]'),
        sibling: read('[data-testid="dashboard-next-day"]'),
      };
    });
    expect(ink.current).not.toBeNull();
    if (ink.sibling) {
      expect(
        ink.current!.color,
        "the current day must carry the same ink as a live sibling, not a muted one",
      ).toBe(ink.sibling.color);
      const painted = (c: string) => !/rgba\(0, 0, 0, 0\)|transparent/.test(c);
      expect(painted(ink.current!.bg), "current segment paints a ground").toBe(true);
      expect(painted(ink.sibling.bg), "a live sibling does not").toBe(false);
    }
  });

  test("stepping a day does not move the arrows", async ({ page }) => {
    // The file promises this, and it is why the current state is marked by
    // ground rather than by weight: `font-medium` changes the advance width and
    // would shift both arrows every time the practitioner stepped a day.
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);
    await page.goto("/dashboard");

    const prev = page.getByTestId("dashboard-prev-day");
    await expect(prev).toBeVisible({ timeout: T });
    const onToday = await prev.boundingBox();

    await page.getByTestId("dashboard-next-day").click();
    await expect(page.getByTestId("dashboard-today")).toBeVisible({ timeout: T });
    const offToday = await prev.boundingBox();

    expect(onToday).not.toBeNull();
    expect(offToday).not.toBeNull();
    expect(Math.round(offToday!.x)).toBe(Math.round(onToday!.x));
    expect(Math.round(offToday!.width)).toBe(Math.round(onToday!.width));
  });
});

test.describe("UX-01 QW2 · the shell answers 'where am I'", () => {
  test.setTimeout(T * 3);

  test("exactly one primary-nav section is current, and it is the right one", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    await loginAsOwner(page, seed);

    const nav = page.getByRole("navigation", { name: "Primary navigation" });

    const cases: Array<{ url: string; testId: string }> = [
      { url: "/dashboard", testId: "nav-dashboard" },
      { url: "/clients", testId: "nav-clients" },
      { url: "/calendar", testId: "nav-calendar" },
      { url: "/records", testId: "nav-records" },
      // A SUBTREE page must keep its section lit — this is what `match="section"`
      // buys, and the reason a bare equality check would be wrong.
      { url: `/clients/${clientId}`, testId: "nav-clients" },
    ];

    for (const c of cases) {
      await page.goto(c.url);
      await expect(nav).toBeVisible({ timeout: T });
      const current = nav.locator('[aria-current="page"]');
      await expect(current, `${c.url}: exactly one current`).toHaveCount(1);
      await expect(
        nav.getByTestId(c.testId),
        `${c.url} lights ${c.testId}`,
      ).toHaveAttribute("aria-current", "page");
    }
  });

  test("the capacity page lights Business, NOT Dashboard", async ({ page }) => {
    // `/dashboard/capacity` is a different nav entry from `/dashboard`. A bare
    // prefix match lights both; Dashboard is therefore `match="exact"`.
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);
    await page.goto("/dashboard/capacity");

    const nav = page.getByRole("navigation", { name: "Primary navigation" });
    await expect(nav).toBeVisible({ timeout: T });
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(nav.getByTestId("nav-business")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(nav.getByTestId("nav-dashboard")).not.toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("NO REGRESSION: the primary nav still acknowledges the press", async ({
    page,
  }) => {
    // #736's contract. QW2 moved these anchors into a client leaf; the
    // acknowledgement must survive that move, not merely still compile.
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);

    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let held = 0;
    // INSTALLED BEFORE THE PAGE LOADS, deliberately. Next prefetches a <Link>
    // as it enters the viewport, and for a segment change that speculative
    // fetch can satisfy the whole navigation — so a gate installed after the
    // page settled intercepted nothing, the tap made no request, and `held`
    // came back 0. Holding the prefetch keeps the router cache empty while
    // leaving every request successful.
    await page.route(
      (u) => u.pathname === "/clients",
      async (route) => {
        const h = route.request().headers();
        if (h["rsc"] === "1" || h["next-router-prefetch"] === "1") {
          held += 1;
          await gate;
        }
        await route.continue();
      },
    );
    await page.goto("/dashboard");

    const clients = page.getByTestId("nav-clients");
    await expect(clients).toBeVisible({ timeout: T });
    await clients.click();
    await expect(clients.locator("[data-link-pending]")).toBeVisible({
      timeout: 10_000,
    });
    expect(held, "the gate never held a request").toBeGreaterThan(0);
    open();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
});

test.describe("UX-01 QW3 · the flagship actions reach the touch floor", () => {
  for (const vp of WIDTHS) {
    test(`dashboard 'Book appointment' is >= 44px at ${vp.name}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const seed = await seedE2eStudio();
      await loginAsOwner(page, seed);
      await page.goto("/dashboard");

      const book = page.getByRole("link", { name: "Book appointment" });
      await expect(book).toBeVisible({ timeout: T });
      const box = await book.boundingBox();
      expect(box).not.toBeNull();
      expect(
        Math.round(box!.height),
        `Book appointment is ${box!.height}px at ${vp.name}`,
      ).toBeGreaterThanOrEqual(44);

      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test(`records 'Print / Export' is >= 44px at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const seed = await seedE2eStudio();
      await loginAsOwner(page, seed);
      await page.goto("/records");

      const print = page.getByRole("link", { name: "Print / Export" });
      await expect(print).toBeVisible({ timeout: T });
      const box = await print.boundingBox();
      expect(box).not.toBeNull();
      expect(
        Math.round(box!.height),
        `Print / Export is ${box!.height}px at ${vp.name}`,
      ).toBeGreaterThanOrEqual(44);

      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  }
});

test.describe("UX-01 QW4 · a keyboard user can leave the dialog", () => {
  test.setTimeout(T * 2);

  test("focus enters on open, Escape closes, focus returns to the opener", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);
    await page.goto("/settings/intake");

    const opener = page.getByRole("button", { name: /preview email/i }).first();
    await expect(opener).toBeVisible({ timeout: T });
    await opener.focus();
    await opener.press("Enter");

    const dialog = page.getByRole("dialog", { name: /postcare email preview/i });
    await expect(dialog).toBeVisible({ timeout: T });

    // FOCUS IS INSIDE. Before this repair it stayed on the opener behind an
    // `aria-modal` that had already hidden the rest of the page.
    const inside = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"]');
      return !!panel && panel.contains(document.activeElement);
    });
    expect(inside, "focus must be inside the dialog").toBe(true);

    // ESCAPE CLOSES IT — the whole defect.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0, { timeout: 10_000 });

    // AND FOCUS COMES BACK, so a keyboard user is not dropped at <body>.
    await expect(opener).toBeFocused();
  });

  test("Tab does not escape the open dialog", async ({ page }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);
    await page.goto("/settings/intake");

    await page.getByRole("button", { name: /preview email/i }).first().click();
    const dialog = page.getByRole("dialog", { name: /postcare email preview/i });
    await expect(dialog).toBeVisible({ timeout: T });

    const inside = () =>
      page.evaluate(() => {
        const panel = document.querySelector('[role="dialog"]');
        return !!panel && panel.contains(document.activeElement);
      });

    // REVERSE FIRST, and this direction is the one that was broken.
    //
    // Codex P2: on open, focus rests on the PANEL, which is `tabIndex={-1}` and
    // therefore outside the tabbable set. The trap only rewrote Shift+Tab when
    // the active element WAS the first focusable, so this exact keystroke —
    // the first one a reverse-tabbing user makes — fell through to the
    // browser's default order and left the dialog. Forward tabbing from the
    // same state happened to work, which is why the original version of this
    // test passed while the hole was open.
    await page.keyboard.press("Shift+Tab");
    expect(await inside(), "Shift+Tab escaped straight out of the dialog").toBe(
      true,
    );

    for (let i = 0; i < 8; i += 1) await page.keyboard.press("Tab");
    expect(await inside(), "Tab walked out from behind the modal").toBe(true);

    for (let i = 0; i < 8; i += 1) await page.keyboard.press("Shift+Tab");
    expect(await inside(), "reverse tabbing walked out").toBe(true);
  });
});

test.describe("UX-01 QW4 · Escape does not abandon an in-flight send", () => {
  test.setTimeout(T * 3);

  test("Escape closes while idle, and is suppressed mid-send", async ({ page }) => {
    // THE ASYMMETRY, driven rather than asserted at source.
    //
    // Confirm on this dialog hands an email to a provider, and the panel is
    // the only place that outcome is reported. Dismissing it in flight would
    // abandon a result the practitioner still needs, so `busy: pending`
    // suppresses Escape here — while the settings PREVIEW, which sends
    // nothing, stays dismissible at all times. A source pin can show the flag
    // is passed; only this can show it reaches the key handler.
    //
    // THE FIXTURE IS A COMPLETED APPOINTMENT, not a confirmed one. Postcare is
    // completed-only (B8 / 0177) — the surface deliberately does not offer a
    // send the command would refuse — so seeding a confirmed appointment
    // renders no trigger at all, which is how the first version of this test
    // failed.
    const seed = await seedE2eStudio();
    await setStudioPostcareText(seed.studioId, "Keep the area clean and dry.");
    const { appointmentId } = await seedE2eEndedAppointmentSession(seed, {
      status: "completed",
    });

    await loginAsOwner(page, seed);
    await page.goto(`/calendar/${appointmentId}`);

    const opener = page.getByRole("button", { name: "Send postcare", exact: true });
    await expect(opener).toBeVisible({ timeout: T });
    await opener.click();

    const dialog = page.getByRole("dialog", { name: "Send postcare preview" });
    await expect(dialog).toBeVisible({ timeout: T });

    // IDLE: Escape closes, and focus comes back to the trigger.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0, { timeout: 10_000 });
    await expect(opener).toBeFocused();

    // IN FLIGHT: hold the Server Action, then press Escape.
    //
    // The request is HELD, never forwarded — the assertion is about the
    // browser's pending state, and holding it means no postcare claim is
    // written and no provider is called at all.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = 0;
    await page.route("**/*", async (route) => {
      const req = route.request();
      if (req.method() === "POST" && req.headers()["next-action"]) {
        held += 1;
        await gate;
        await route.abort();
        return;
      }
      await route.continue();
    });

    await opener.click();
    await expect(dialog).toBeVisible({ timeout: T });
    await dialog.getByTestId("postcare-confirm").click();

    // ANTI-VACUITY, and the load-bearing precondition. If the transition were
    // NOT pending, `busy` would be false and Escape closing the dialog would
    // be CORRECT behaviour — the assertion below would then pass or fail for
    // a reason that has nothing to do with the gate. "Sending..." renders only
    // while `pending` is true, so it is the in-flight state made visible.
    await expect(dialog.getByTestId("postcare-confirm")).toHaveText("Sending...", {
      timeout: 10_000,
    });
    expect(held, "the send action was never held").toBeGreaterThan(0);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    await expect(
      dialog,
      "Escape abandoned an in-flight provider send",
    ).toBeVisible();

    release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
});

test.describe("UX-01 QW3 · the row shares one baseline", () => {
  test("Book appointment matches the day-nav it sits beside", async ({ page }) => {
    // The defect was not only "below the floor" — it was a 44px control and a
    // 36px control sharing a row, with the page's flagship action as the
    // shorter one. Height parity is the part a floor assertion alone misses.
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/dashboard");

    const book = page.getByRole("link", { name: "Book appointment" });
    const daySegment = page.getByTestId("dashboard-today");
    await expect(book).toBeVisible({ timeout: T });
    await expect(daySegment).toBeVisible({ timeout: T });

    const b = await book.boundingBox();
    const d = await daySegment.boundingBox();
    expect(b).not.toBeNull();
    expect(d).not.toBeNull();
    expect(
      Math.abs(Math.round(b!.height) - Math.round(d!.height)),
      `book ${b!.height}px vs day-nav ${d!.height}px`,
    ).toBeLessThanOrEqual(2);
  });
});

test.describe("UX-01 · #739 acknowledgement is intact", () => {
  test("the client-profile Log session control still acknowledges", async ({
    page,
  }) => {
    // #739 adopted the shipped primitive on eleven clinical navigation
    // controls. UX-01 touched the shell and the dashboard, not those — but
    // "did not touch" is a claim about a diff, and this is the behaviour.
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    await loginAsOwner(page, seed);

    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let held = 0;
    await page.route(
      (u) => u.pathname === `/clients/${clientId}/sessions/new`,
      async (route) => {
        const h = route.request().headers();
        if (h["rsc"] === "1" || h["next-router-prefetch"] === "1") {
          held += 1;
          await gate;
        }
        await route.continue();
      },
    );
    await page.goto(`/clients/${clientId}`);

    const log = page.getByRole("link", { name: "+ Log session" });
    await expect(log).toBeVisible({ timeout: T });
    await log.click();
    await expect(log.locator("[data-link-pending]")).toBeVisible({
      timeout: 10_000,
    });
    expect(held, "the gate never held a request").toBeGreaterThan(0);
    open();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
});

test.describe("UX-01 QW5 · the off-system radius is gone", () => {
  test("the calendar view toggle paints a system radius", async ({ page }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);
    await page.goto("/calendar");

    const week = page.getByTestId("calendar-view-week");
    await expect(week).toBeVisible({ timeout: T });
    const radius = await week.evaluate(
      (el) => getComputedStyle(el).borderTopLeftRadius,
    );
    // 5px was the off-system dialect; `rounded-md` is 6px.
    expect(radius).not.toBe("5px");
    expect(radius).toBe("6px");
  });
});

test.describe("UX-01 · reduced motion", () => {
  test("no quick win introduces motion that reduced-motion must suppress", async ({
    page,
  }) => {
    // None of the four repairs animates: they change fill, ink, box height and
    // a radius. The press acknowledgement `buttonClasses` brings is the app's
    // EXISTING interaction contract, which already honours reduced motion.
    // This asserts the repaired surfaces still render and stay measurable with
    // the preference on, rather than claiming a motion contract they do not own.
    await page.emulateMedia({ reducedMotion: "reduce" });
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);

    await page.goto("/dashboard");
    const today = page.getByTestId("dashboard-today");
    await expect(today).toBeVisible({ timeout: T });
    await expect(today).toHaveAttribute("aria-current", "page");
    const ratio = await contrastAt(page, '[data-testid="dashboard-today"]');
    expect(ratio!).toBeGreaterThanOrEqual(4.5);

    const book = page.getByRole("link", { name: "Book appointment" });
    const box = await book.boundingBox();
    expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);

    expect(
      await page.evaluate(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);
  });
});
