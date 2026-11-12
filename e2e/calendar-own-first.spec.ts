import { expect, test, type Page } from "@playwright/test";
import {
  getOwnerPractitionerId, seedE2eMember, seedE2eStudio, seedPractitionerDefault, setStudioCapacityBookingEnabled,
  setStudioCapacityEnabled, setStudioTimezone, sql, type E2eSeed,
} from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";

// Opt-in (a short browser run; OPS decides whether a CI lane carries it): CAL_OWN_FIRST_E2E=1.
test.skip(process.env.CAL_OWN_FIRST_E2E !== "1", "opt-in #1424 own-calendar-first matrix; set CAL_OWN_FIRST_E2E=1");

// #1424: a practitioner's first visit to the team calendar opens on their OWN column. SYNTHETIC data only, one team studio:
// an owner and two practitioners (A, B), all open every day so each has a column today.
//
//   1  practitioner first visit: the URL gains people=<own id>; only their column; the others are unchecked but selectable
//   2  picking a second calendar adds it, and a plain /calendar load afterwards keeps the choice (a stored choice wins)
//   3  choosing everyone, then a plain load: everyone (an explicit "all" wins over the default)
//   4  owner first visit: everyone, no people param is added
//   5  an explicit ?people=<B> link is the selection and is not rewritten to the viewer's own id
//   6  a load with no people param lands on the own default again; a later choice is stored and then wins. NOTE (measured): the default
//      itself is also written to the stored preference right after the first load (the hasParam branch of the sidebar effect)
//
// A solo practitioner (fewer than two listed) is proved by the unit tests (firstVisitParam), not here: a one-person team has no
// team calendar to open. Screenshots: CAL_SHOTS_DIR (default test-results/cal-own-first), <viewport>-<case>.png.

const TZ = "America/Los_Angeles";
const SHOTS = process.env.CAL_SHOTS_DIR ?? "test-results/cal-own-first";
const STORAGE_PREFIX = "hone:calendar:selection:v1:"; // lib/calendar/practitioner-selection.ts SELECTION_STORAGE_PREFIX

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false },
  mobile: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
} as const;

type Team = { seed: E2eSeed; ownerId: string; a: { id: string; email: string }; b: { id: string; email: string } };
let team: Promise<Team> | null = null;

function getTeam(): Promise<Team> {
  team ??= (async () => {
    const seed = await seedE2eStudio();
    await setStudioTimezone(seed.studioId, TZ);
    await setStudioCapacityEnabled(seed.studioId, true);
    await setStudioCapacityBookingEnabled(seed.studioId, true);
    const ownerId = await getOwnerPractitionerId(seed.studioId);
    const a = await seedE2eMember(seed);
    const b = await seedE2eMember(seed);
    for (const id of [ownerId, a.practitionerId, b.practitionerId]) {
      for (let dow = 0; dow < 7; dow++) await seedPractitionerDefault(seed.studioId, id, dow, true, "08:00", "20:00");
    }
    await sql("update public.practitioners set display_name=$3 where studio_id=$1 and id=$2", [seed.studioId, ownerId, "Synthetic Owner"]);
    return { seed, ownerId, a: { id: a.practitionerId, email: a.email }, b: { id: b.practitionerId, email: b.email } };
  })();
  return team;
}

const checkbox = (page: Page, id: string) => page.locator(`[data-testid="calendar-sidebar-checkbox"][data-practitioner-id="${id}"]`);
const headerIds = async (page: Page): Promise<string[]> =>
  (await page.getByTestId("team-day-column-header").evaluateAll((els) => els.map((e) => e.getAttribute("data-practitioner-id") ?? ""))).sort();
const peopleParam = (page: Page): string | null => new URL(page.url()).searchParams.get("people");

// On a phone the sidebar is a drawer: open it before touching a checkbox.
async function openSidebar(page: Page): Promise<void> {
  const toggle = page.getByTestId("calendar-sidebar-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(checkbox(page, (await getTeam()).ownerId)).toBeVisible();
}

async function plainLoad(page: Page): Promise<void> {
  await page.goto("/calendar");
  await expect(page.getByTestId("calendar-sidebar")).toBeAttached();
}

const sorted = (...ids: string[]) => [...ids].sort();

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`#1424 own calendar first, ${vpName}`, () => {
    test.use({ viewport: vp.viewport, hasTouch: vp.hasTouch, isMobile: vp.isMobile });

    async function shot(page: Page, name: string): Promise<void> {
      await page.screenshot({ path: `${SHOTS}/${vpName}-${name}.png`, fullPage: false });
    }

    test("1: a practitioner's first visit opens on their own column; the others are unchecked but selectable", async ({ page }) => {
      const t = await getTeam();
      await loginByMagicLink(page, t.a.email);
      await plainLoad(page);
      await expect.poll(() => peopleParam(page)).toBe(t.a.id);
      await expect.poll(() => headerIds(page)).toEqual([t.a.id]);
      await openSidebar(page);
      await expect(checkbox(page, t.a.id)).toBeChecked();
      await expect(checkbox(page, t.b.id)).not.toBeChecked();
      await expect(checkbox(page, t.ownerId)).not.toBeChecked();
      await expect(checkbox(page, t.b.id)).toBeEnabled();
      await expect(checkbox(page, t.ownerId)).toBeEnabled();
      await shot(page, "1-practitioner-first-visit");
    });

    test("2: picking a second calendar adds it, and a plain load afterwards keeps the choice", async ({ page }) => {
      const t = await getTeam();
      await loginByMagicLink(page, t.a.email);
      await plainLoad(page);
      await expect.poll(() => peopleParam(page)).toBe(t.a.id);
      await openSidebar(page);
      await checkbox(page, t.b.id).check();
      await expect.poll(() => headerIds(page)).toEqual(sorted(t.a.id, t.b.id));
      await plainLoad(page);
      await expect.poll(() => headerIds(page)).toEqual(sorted(t.a.id, t.b.id));
      await openSidebar(page);
      await expect(checkbox(page, t.ownerId)).not.toBeChecked();
      await shot(page, "2-second-calendar-kept");
    });

    test("3: choosing everyone, then a plain load, shows everyone (an explicit all wins over the default)", async ({ page }) => {
      const t = await getTeam();
      await loginByMagicLink(page, t.a.email);
      await plainLoad(page);
      await expect.poll(() => peopleParam(page)).toBe(t.a.id);
      await openSidebar(page);
      await checkbox(page, t.b.id).check();
      await checkbox(page, t.ownerId).check();
      await expect.poll(() => peopleParam(page)).toBeNull();
      await plainLoad(page);
      await expect.poll(() => headerIds(page)).toEqual(sorted(t.ownerId, t.a.id, t.b.id));
      expect(peopleParam(page)).toBeNull();
      await shot(page, "3-everyone-wins");
    });

    test("4: an owner's first visit shows everyone and adds no people param", async ({ page }) => {
      const t = await getTeam();
      await loginByMagicLink(page, t.seed.ownerEmail);
      await plainLoad(page);
      await expect.poll(() => headerIds(page)).toEqual(sorted(t.ownerId, t.a.id, t.b.id));
      await page.waitForTimeout(1000); // give a wrongly-applied default time to rewrite the URL
      expect(peopleParam(page)).toBeNull();
      await shot(page, "4-owner-first-visit");
    });

    test("5: an explicit ?people= link is the selection and is not rewritten to the viewer's own id", async ({ page }) => {
      const t = await getTeam();
      await loginByMagicLink(page, t.a.email);
      await page.goto(`/calendar?people=${t.b.id}`);
      await expect.poll(() => headerIds(page)).toEqual([t.b.id]);
      await page.waitForTimeout(1000);
      expect(peopleParam(page)).toBe(t.b.id);
      await openSidebar(page);
      await expect(checkbox(page, t.b.id)).toBeChecked();
      await expect(checkbox(page, t.a.id)).not.toBeChecked();
      await shot(page, "5-explicit-link");
    });

    test("6: the default re-applies on a load with no people param until the person chooses; a choice is stored and then wins", async ({ page }) => {
      const t = await getTeam();
      const key = STORAGE_PREFIX + t.seed.studioId;
      await loginByMagicLink(page, t.a.email);
      const stored = () => page.evaluate((k) => window.localStorage.getItem(k), key);

      await plainLoad(page);
      await expect.poll(() => peopleParam(page)).toBe(t.a.id);
      // Reloading with no people param lands on the same default again (it is stored after the first load, so this restore equals the default).
      await plainLoad(page);
      await expect.poll(() => peopleParam(page)).toBe(t.a.id);
      await expect.poll(() => headerIds(page)).toEqual([t.a.id]);

      // A choice: also show B. It is written to the stored preference, and a plain load then restores THAT, not the own-only default.
      await openSidebar(page);
      await checkbox(page, t.b.id).check();
      await expect.poll(stored).toContain(t.b.id);
      await plainLoad(page);
      await expect.poll(() => headerIds(page)).toEqual(sorted(t.a.id, t.b.id));
      expect(peopleParam(page)).not.toBe(t.a.id);
      await shot(page, "6-choice-stored-and-wins");
    });
  });
}
