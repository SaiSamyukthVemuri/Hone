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
async function holdActions(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const state = { held: 0 };
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.headers()["next-action"]) {
      state.held += 1;
      await gate;
      await route.abort();
      return;
    }
    await route.continue();
  });
  return {
    state,
    release: async () => {
      release();
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
  open: (page: Page) => Promise<Locator>;
};

const SURFACES: Surface[] = [
  {
    name: "desktop AccountMenu",
    use: { viewport: { width: 1280, height: 900 } },
    open: async (page) => {
      await page.getByRole("button", { name: "Open account menu" }).click();
      return page.getByRole("navigation", { name: "Account menu" });
    },
  },
  {
    name: "phone-width MobileMenu",
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

      await gate.release();
    });

    test("a second activation cannot dispatch a second logout", async ({ page }) => {
      await loginAsOwner(page, seed);
      await page.goto("/dashboard");

      const gate = await holdActions(page);
      const panel = await surface.open(page);
      const control = panel.getByRole("button", { name: "Sign out" });
      await control.click({ noWaitAfter: true });
      await expect(panel.locator("[data-signout-pending]")).toBeVisible({
        timeout: 5_000,
      });

      // Press it again, hard. `force` skips actionability so Playwright will
      // genuinely dispatch at a disabled control rather than politely waiting
      // for it to become enabled — which would make this test pass by never
      // pressing anything.
      await panel
        .locator("[data-signout-pending]")
        .click({ force: true, noWaitAfter: true })
        .catch(() => {});
      await page.waitForTimeout(400);

      expect(
        gate.state.held,
        "a second logout reached the wire — the disable is advisory, not a guard",
      ).toBe(1);

      await gate.release();
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

      await gate.release();
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
