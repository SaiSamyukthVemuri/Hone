import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsOwner } from "./helpers/flows";
import { seedE2eStudio, sql, type E2eSeed } from "./helpers/seed";

// SIGNOUT-02 · the logout control acknowledges the press it received.
//
// SIGNOUT-01 proved the logout is REAL — the Server Action dispatches, the
// Supabase session rows go, the cookie clears. That spec is untouched and still
// owns those facts. This one owns a different question, which SIGNOUT-01
// deliberately never asked: between the press and the result, what does the
// practitioner SEE?
//
// The measured answer on the production tree was "nothing", for a median of
// 533ms. DESIGN.md LAW 4: "A press is confirmed before its result arrives. A
// control that has been activated must never look idle."
//
// WHAT THIS SPEC IS CAREFUL ABOUT. Every acknowledgement assertion here runs
// against a HELD Server Action, so the pending window is controlled rather than
// raced. That is not a convenience: with the real ~400ms action the control
// might be caught mid-state by a slow runner and the test would be measuring
// the runner, not the product. Holding it also lets the spec prove the two
// things a fast-passing test cannot — that the state is driven by the ACTION
// rather than by a timer, and that the control never claims a success that has
// not happened.

const HOLD_MS = 3_000;

let seed: E2eSeed;

test.beforeAll(async () => {
  seed = await seedE2eStudio();
});

async function authUserId(email: string): Promise<string> {
  const rows = await sql<{ id: string }>(
    `select id::text as id from auth.users where email = $1`,
    [email],
  );
  return rows[0]!.id;
}

async function liveSessionCount(userId: string): Promise<number> {
  const rows = await sql<{ n: string }>(
    `select count(*)::text as n from auth.sessions where user_id = $1::uuid`,
    [userId],
  );
  return Number(rows[0]!.n);
}

/**
 * Holds every Server Action POST until released, and counts them.
 *
 * The count is the duplicate-activation instrument: a guard that merely LOOKS
 * disabled still lets a second POST onto the wire, and only the wire can tell
 * the difference.
 */
/**
 * Holds the FIRST sign-out Server Action until released, and counts every one.
 *
 * `onRelease` decides what happens to the held request, and the default is
 * ABORT for a reason that is easy to get wrong.
 *
 * `signOut()` is a GLOBAL Supabase logout, and every test in this file reuses
 * the same seeded owner. A released request that completes after its test has
 * returned would revoke the session the NEXT test just logged in with — a
 * cross-test failure that would look like a flaky product rather than a leaky
 * fixture, in a spec that runs serially.
 *
 * So only the wire test asks for `continue`, because only it needs the first
 * action to genuinely settle — session destroyed, app navigated — since that
 * settling is what frees a queued duplicate to dispatch. It then waits for
 * /login before returning, so its logout is finished, not merely started.
 * Every other test aborts: it never needed the logout to complete, only to be
 * in flight.
 *
 * (Measured both ways while diagnosing the wire test: the queue behaves the
 * same under `abort` and `continue`. The choice here is about fixture safety,
 * not about what is being proved.)
 */
async function holdActions(
  page: Page,
  opts: { onRelease?: "abort" | "continue" } = {},
) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const onRelease = opts.onRelease ?? "abort";
  const state = { held: 0 };
  let first = true;
  // Resolves the INSTANT a second sign-out action reaches the wire. Proving a
  // negative needs a bounded window, but the positive is event-driven: a
  // duplicate is detected the moment it happens rather than by waiting out a
  // timer and inspecting a counter afterwards.
  let markDuplicate!: () => void;
  const duplicateSeen = new Promise<void>((r) => (markDuplicate = r));
  // "The first action is off the wire", independent of any navigation. The
  // /login arrival is the better signal where it happens, but a logout started
  // and then left behind by a link never applies its redirect to THIS page, so
  // that test needs a signal that does not assume one.
  let markSettled!: () => void;
  const firstSettled = new Promise<void>((r) => (markSettled = r));
  const isAction = (r: { method(): string; headers(): Record<string, string> }) =>
    r.method() === "POST" && Boolean(r.headers()["next-action"]);
  page.on("requestfinished", (r) => {
    if (isAction(r)) markSettled();
  });
  page.on("requestfailed", (r) => {
    if (isAction(r)) markSettled();
  });
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.headers()["next-action"]) {
      state.held += 1;
      // EVERY sign-out action is counted, not just the first, and the FIRST is
      // the only one held. A later one reaching here is the duplicate the wire
      // test exists to catch.
      if (first) {
        first = false;
        await gate;
        if (onRelease === "abort") {
          await route.abort();
          return;
        }
      } else {
        markDuplicate();
      }
    }
    await route.continue();
  });
  return {
    state,
    duplicateSeen,
    firstSettled,
    /**
     * Let the held request through. INTERCEPTION STAYS ACTIVE, deliberately:
     * React serialises form actions rather than dropping them, so a second
     * submission may be QUEUED behind the first and only dispatch once it
     * settles. Tearing the route down here would let exactly that request
     * reach the backend uncounted.
     */
    release: () => release(),
    /** Stop counting. Only after any queued work has had its chance to arrive. */
    unroute: async () => {
      await page.unrouteAll({ behavior: "ignoreErrors" });
    },
  };
}

async function bg(control: Locator): Promise<string> {
  return control.evaluate((el) => getComputedStyle(el).backgroundColor);
}

type Surface = {
  name: string;
  use: Parameters<typeof test.use>[0];
  /** Accessible name of the control that opens — and used to try to close — the panel. */
  trigger: string;
  open: (page: Page) => Promise<Locator>;
};

const SURFACES: Surface[] = [
  {
    name: "desktop AccountMenu",
    use: { viewport: { width: 1280, height: 900 } },
    trigger: "Open account menu",
    open: async (page) => {
      await page.getByRole("button", { name: "Open account menu" }).click();
      return page.getByRole("navigation", { name: "Account menu" });
    },
  },
  {
    name: "phone-width MobileMenu",
    trigger: "Open navigation menu",
    // Same explicit iPhone-12-class emulation SIGNOUT-01 uses: the devices[]
    // descriptors carry defaultBrowserType webkit, which this chromium-only
    // lane does not install.
    use: {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 3,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    },
    open: async (page) => {
      await page.getByRole("button", { name: "Open navigation menu" }).click();
      return page.getByRole("navigation", { name: "Mobile navigation" });
    },
  },
];

for (const surface of SURFACES) {
  test.describe(`SIGNOUT-02 · ${surface.name}`, () => {
    test.use(surface.use);

    test("the in-flight action is reported, and success is never claimed", async ({
      page,
    }) => {
      const userId = await authUserId(seed.ownerEmail);
      await loginAsOwner(page, seed);
      await page.goto("/dashboard");

      const gate = await holdActions(page);
      const panel = await surface.open(page);
      const control = panel.getByRole("button", { name: "Sign out" });
      await expect(control).toBeVisible();

      await control.click({ noWaitAfter: true });

      // THE ACKNOWLEDGEMENT. All three at once, because any one of them alone
      // is satisfiable by something that is not an acknowledgement: a label
      // that never disables still takes a second press, a disable with no
      // label change reads as a broken control, and aria-busy alone is
      // invisible to everyone not using a screen reader.
      const busy = panel.locator("[data-signout-pending]");
      await expect(busy).toBeVisible({ timeout: 5_000 });
      await expect(busy).toHaveText("Signing out…");
      await expect(busy).toBeDisabled();
      await expect(busy).toHaveAttribute("aria-busy", "true");

      // NEVER FAKES SUCCESS. The action has NOT completed — it is held on the
      // wire — so every fact that would mean "signed out" must still be false.
      // A control that closed its panel, or navigated, or said "Signed out"
      // here would be lying, and that is precisely the SIGNOUT-01 failure mode
      // in a new costume: the press LOOKING like it worked.
      expect(
        page.url(),
        "the practitioner was moved to /login before the action answered",
      ).not.toMatch(/\/login/);
      expect(
        await liveSessionCount(userId),
        "the session was reported gone while the action was still in flight",
      ).toBeGreaterThan(0);
      await expect(panel, "the panel unmounted mid-flight").toBeVisible();

      gate.release();
      await gate.unroute();
    });

    test("only one logout ever reaches the wire", async ({ page }) => {
      // THREE ROUNDS OF THIS TEST WERE GREEN FOR THE WRONG REASON. The history
      // is kept because each round removed a different false attribution, and
      // the final shape is only justified by all three.
      //
      //   1. "a second activation cannot dispatch a second logout", blaming
      //      `disabled`. Replacing `disabled={pending}` with `disabled={false}`
      //      left it green — React serialises form actions, so nothing
      //      dispatches concurrently either way.
      //
      //   2. Renamed, and the second press was forced past the guard with
      //      `removeAttribute("disabled")` + `form.requestSubmit()`. Still
      //      wrong twice over: the assertion ran while the first action was
      //      still held, when a serialised submission is QUEUED and the count
      //      is 1 by definition; and releasing the gate tore the counting route
      //      down in the same call, so anything dispatched afterwards was
      //      invisible.
      //
      //   3. Counting kept alive through the drain — which turned it RED at 3.
      //      That was the test's fault, not the product's. Scripting past
      //      `disabled` and calling `requestSubmit()` is not a duplicate
      //      activation a practitioner can perform; it forces submissions into
      //      React's queue and then observes the queue holding them. Measured
      //      both ways, and the first action's fate makes no difference:
      //      released via `continue` -> 3, released via `abort` -> 3.
      //
      // So the duplicate is now attempted the ONLY way it can actually happen:
      // a real pointer press at the control, while it reads "Signing out…".
      // Measured through the drain, with nothing else changed:
      //
      //     guard intact  -> 1 request in total
      //     guard removed -> 3 requests in total
      //
      // Which is what finally makes this test both true and load-bearing:
      // `disabled={pending}` is the duplicate-submit guard, and only a
      // drain-aware count can see it. The concurrent count is 1 either way.
      await loginAsOwner(page, seed);
      await page.goto("/dashboard");

      const gate = await holdActions(page, { onRelease: "continue" });
      const panel = await surface.open(page);
      const control = panel.getByRole("button", { name: "Sign out" });
      const box = (await control.boundingBox())!;
      await control.click({ noWaitAfter: true });
      await expect(panel.locator("[data-signout-pending]")).toBeVisible({
        timeout: 5_000,
      });

      // Press again, twice, where the control is. No `force`, no attribute
      // surgery, no scripted submit — the browser's own rules decide what a
      // press at a disabled control does, which is the whole point.
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

      expect(
        gate.state.held,
        "a second logout dispatched while the first was still in flight",
      ).toBe(1);

      // Release the first action for real — it runs, the session dies, the app
      // navigates. INTERCEPTION STAYS UP so a queued submission is still seen.
      gate.release();

      // THE DRAIN, proved by events in the direction that matters.
      //
      // Reaching /login is the first action genuinely completing — session
      // destroyed, app navigated — which is the moment a queued duplicate
      // becomes free to dispatch.
      await page.waitForURL(/\/login/, { timeout: 20_000 });

      // Then watch. A duplicate resolves `duplicateSeen` the instant it hits
      // the wire, so the failing case is detected by EVENT and fails fast;
      // measured at ~1.2s after release when the guard is removed. The 4s is
      // only a ceiling on how long we watch for something that must not
      // happen — proving a negative has no completion event to wait on.
      //
      // `networkidle` was tried here first and is NOT usable: with the guard
      // removed it never settles at all, so the test died on a 120s timeout
      // instead of naming the defect. A red that reports a timeout is not
      // evidence about duplicate submission.
      await Promise.race([
        gate.duplicateSeen,
        new Promise((r) => setTimeout(r, 4_000)),
      ]);

      expect(
        gate.state.held,
        "a second logout reached the wire — in total, counted through the drain",
      ).toBe(1);

      await gate.unroute();
    });

    test("the panel cannot be dismissed out from under a logout", async ({ page }) => {
      // THE DEFECT THIS CLOSES, which the earlier tests could not see because
      // they never touched the panel. `useFormStatus` reports only for the form
      // it runs inside, and that form lives in a panel rendered from the
      // shell's `open` state — so Escape, an outside click or the trigger
      // unmounted the acknowledgement mid-logout, and a reopened menu offered a
      // fresh ENABLED "Sign out". Measured before the repair: two requests on
      // the wire, `[294, 2404]`.
      //
      // Not a regression — the same path measured `[288, 2355]` on the
      // pre-SIGNOUT-02 runtime, which had no guard at all. It is the boundary
      // SIGNOUT-02 had not yet paid for.
      await loginAsOwner(page, seed);
      await page.goto("/dashboard");

      const gate = await holdActions(page, { onRelease: "continue" });
      const panel = await surface.open(page);
      await panel.getByRole("button", { name: "Sign out" }).click({ noWaitAfter: true });

      const busy = panel.locator("[data-signout-pending]");
      await expect(busy).toBeVisible({ timeout: 5_000 });

      // 1. ESCAPE must not dismiss.
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      await expect(panel, "Escape dismissed the panel mid-logout").toBeVisible();
      await expect(busy, "the acknowledgement was lost to Escape").toBeVisible();

      // 2. An OUTSIDE pointerdown must not dismiss. Top-left corner is outside
      //    both the desktop dropdown and the phone sheet's root.
      await page.mouse.click(4, 4);
      await page.waitForTimeout(300);
      await expect(panel, "an outside click dismissed the panel mid-logout").toBeVisible();

      // 3. The TRIGGER must not close it either.
      await page
        .getByRole("button", { name: surface.trigger })
        .click({ noWaitAfter: true, force: true });
      await page.waitForTimeout(300);
      await expect(panel, "the trigger closed the panel mid-logout").toBeVisible();

      // Still the same in-flight control, still refusing a second press.
      await expect(busy).toHaveText("Signing out…");
      await expect(busy).toBeDisabled();
      await expect(busy).toHaveAttribute("aria-busy", "true");

      // AND NOTHING EXTRA REACHED THE WIRE, counted through the drain — the
      // assertion the acknowledgement exists to protect.
      gate.release();
      await page.waitForURL(/\/login/, { timeout: 20_000 });
      await Promise.race([
        gate.duplicateSeen,
        new Promise((r) => setTimeout(r, 4_000)),
      ]);
      expect(
        gate.state.held,
        "a second logout reached the wire after the panel was pushed at",
      ).toBe(1);

      await gate.unroute();
    });

    test("leaving through a link does not strand the logout", async ({ page }) => {
      // THE DEFECT THIS CLOSES, and it is the correction to my own first fix.
      //
      // That version gated Escape, the outside click and the trigger, but left
      // the panel's LINKS alone, reasoning that a navigation is not a
      // dismissal. It is not — but it closed the panel all the same, which
      // unmounted the leaf. And the leaf's effect is the only thing that can
      // report `false` when the action settles, so the shell's `signingOut`
      // stuck ON permanently: reopening the menu showed a disabled
      // "Signing out…" for a request that had already finished.
      //
      // Worse, it is unrecoverable in exactly this flow. A logout the
      // practitioner walked away from never applies its redirect to the page
      // they walked to — measured: waiting for /login here hung for the full
      // 20s. So nothing would ever come along to clear it. The first fix traded
      // a duplicate logout for a dead control.
      await loginAsOwner(page, seed);
      await page.goto("/dashboard");

      const gate = await holdActions(page, { onRelease: "continue" });
      const panel = await surface.open(page);
      await panel.getByRole("button", { name: "Sign out" }).click({ noWaitAfter: true });
      const busy = panel.locator("[data-signout-pending]");
      await expect(busy).toBeVisible({ timeout: 5_000 });

      // Leave through a real link, mid-logout.
      await panel.getByRole("link", { name: "Getting Started" }).click({ noWaitAfter: true });
      await page.waitForTimeout(500);

      // THE PANEL SURVIVES THE NAVIGATION, which is what keeps the leaf — and
      // therefore the only observer of settlement — alive.
      await expect(
        panel,
        "a link dismissed the panel mid-logout and stranded the pending state",
      ).toBeVisible();
      await expect(busy).toHaveText("Signing out…");
      await expect(busy).toBeDisabled();

      // Let the logout finish. The leaf is still mounted, so it reports the
      // settlement and the shell releases.
      gate.release();
      await gate.firstSettled;

      // NOT STRANDED: the control comes back, or the app has already replaced
      // the shell with /login. Either is a resolved logout; a permanently
      // disabled "Signing out…" is not.
      await expect
        .poll(
          async () => {
            if (/\/login/.test(page.url())) return "resolved";
            const n = await page.locator("[data-signout-pending]").count();
            return n === 0 ? "resolved" : "still-busy";
          },
          {
            timeout: 15_000,
            message:
              "the shell still claims a logout is in flight after the action settled",
          },
        )
        .toBe("resolved");

      // And still only ever one logout on the wire.
      await Promise.race([
        gate.duplicateSeen,
        new Promise((r) => setTimeout(r, 2_000)),
      ]);
      expect(
        gate.state.held,
        "a second logout reached the wire after leaving through a link",
      ).toBe(1);

      await gate.unroute();
    });

    test("the state belongs to the action, not to a timer", async ({ page }) => {
      // A pending state that clears on its own is the "no timer / no fake
      // progress" rule broken: it would tell the practitioner the logout had
      // resolved while the request was still outstanding. Hold the action well
      // past any plausible animation and assert the control has NOT moved on.
      await loginAsOwner(page, seed);
      await page.goto("/dashboard");

      const gate = await holdActions(page);
      const panel = await surface.open(page);
      await panel.getByRole("button", { name: "Sign out" }).click({ noWaitAfter: true });

      const busy = panel.locator("[data-signout-pending]");
      await expect(busy).toBeVisible({ timeout: 5_000 });
      await page.waitForTimeout(HOLD_MS);
      await expect(busy, "the pending state expired on its own").toBeVisible();
      await expect(busy).toHaveText("Signing out…");

      gate.release();
      await gate.unroute();
    });
  });
}

test.describe("SIGNOUT-02 · the press is confirmed before any JS", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  // LAW 4's first sentence — "a press is confirmed BEFORE its result arrives" —
  // is about the frame the finger lands on, not about `useFormStatus`. The
  // pending state needs React to have dispatched; a CSS `:active` rule needs
  // nothing at all.
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`the active step paints, and differs from hover (prefers-reduced-motion: ${reducedMotion})`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion });
      await loginAsOwner(page, seed);
      await page.goto("/dashboard");
      await page.getByRole("button", { name: "Open account menu" }).click();
      const control = page
        .getByRole("navigation", { name: "Account menu" })
        .getByRole("button", { name: "Sign out" });
      await expect(control).toBeVisible();

      // COMPARED AGAINST HOVER, NOT AGAINST REST, and that is the whole point.
      // Pressing the mouse necessarily hovers first, so a press treatment that
      // merely repeated the hover fill would be invisible to every mouse user
      // — the trap button.tsx records for its own variants. The box the finger
      // is on must change when the finger presses it.
      await control.hover();
      await page.waitForTimeout(250);
      const hovered = await bg(control);

      const box = (await control.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(250);
      const pressed = await bg(control);

      // Release AWAY from the control so this probe never submits the form —
      // a click here would sign the fixture out mid-assertion.
      await page.mouse.move(box.x + box.width / 2, box.y - 200);
      await page.mouse.up();

      expect(
        pressed,
        `press (${pressed}) must differ from hover (${hovered}) under reduced-motion: ${reducedMotion}`,
      ).not.toBe(hovered);
    });
  }
});
