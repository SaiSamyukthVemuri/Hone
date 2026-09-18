import { test, expect, type Page } from "@playwright/test";

import { seedE2eStudio, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// UI-02 — non-colour-only status, proved by the COMPUTED ACCESSIBLE NAME.
//
// The component test beside this one proves the sr-only text exists in source.
// That is not the same claim: text can exist and still be absent from the
// accessibility tree (a wrapping aria-hidden, a role that prunes children, a
// `display:none` utility). Playwright's `getByRole(..., { name })` matches on the
// computed accessible name, so this asserts the property a screen reader would
// actually consume.
//
// WHAT IT STILL DOES NOT CLAIM: this is not a screen-reader acceptance result.
// No automation here drives VoiceOver or NVDA, and real assistive-technology
// acceptance remains required by the roadmap. This proves the name is correct;
// it does not prove the announcement is pleasant.

const T = 20_000;

async function seedNotifications(page: Page) {
  const seed = await seedE2eStudio();
  // `href` IS REQUIRED for the link case. NotificationRow only wraps a row in a
  // <Link> when the notification carries one; without it the row renders as a
  // bare <li>. The first draft of this seed omitted href, so there was no link
  // role to query and the test failed on its own setup rather than on the code
  // under test. Three rows now, because the state has to reach the
  // accessibility tree on a LINKED row and an UNLINKED one alike.
  await sql(
    `insert into public.practitioner_notifications
       (studio_id, event_type, title, body, href, read_at)
     values ($1, 'appointment_booked', $2, 'Seeded unread body',   '/notifications', null),
            ($1, 'appointment_booked', $3, 'Seeded read body',     '/notifications', now()),
            ($1, 'appointment_booked', $4, 'Seeded unlinked body', null,             null)`,
    [
      seed.studioId,
      `UNREAD ${seed.runId}`,
      `ALREADYREAD ${seed.runId}`,
      `UNLINKED ${seed.runId}`,
    ],
  );
  await loginAsOwner(page, seed);
  await page.goto("/notifications");
  return seed;
}

test.describe("UI-02 status has a text equivalent", () => {
  test("an unread row carries 'Unread' in its accessible name; a read row does NOT", async ({
    page,
  }) => {
    const seed = await seedNotifications(page);

    const unread = page.getByText(`UNREAD ${seed.runId}`).first();
    await expect(unread).toBeVisible({ timeout: T });

    // Guard the SETUP before asserting the behaviour. An earlier version of this
    // test seeded rows without `href`, so no <Link> was rendered, and the
    // accessible-name assertion failed for a reason that had nothing to do with
    // the code under test. Asserting the fixture first makes that failure mode
    // say what it actually is.
    const linked = await page.locator("li a").count();
    expect(linked, "fixture: two seeded rows must render as links").toBe(2);

    // THE CLAIM: the link's computed accessible name carries the state. This is
    // the property a screen reader consumes when tabbing the row, and it is
    // strictly stronger than "the text exists in the source".
    const unreadByName = page.getByRole("link", { name: /Unread\./ });
    expect(await unreadByName.count()).toBe(1);

    // THE NEGATIVE CONTROL. Two of the three seeded rows are unread, one is
    // read. If "Unread." were emitted unconditionally the count would be three,
    // and the text would be decoration rather than state.
    const named = await page.locator("li").evaluateAll((els) =>
      els
        .map((el) => el.textContent ?? "")
        .filter((t) => t.includes("Unread.")).length,
    );
    expect(named, "only the two unread rows carry the word").toBe(2);

    const readHasWord = await page
      .getByText(`ALREADYREAD ${seed.runId}`)
      .first()
      .evaluate((el) => (el.closest("li")?.textContent ?? "").includes("Unread."));
    expect(readHasWord, "a READ row must never announce Unread").toBe(false);

    // The UNLINKED unread row has no <Link> wrapper at all and must still carry
    // the state — otherwise the fix only works on deep-linked rows.
    const unlinkedHasWord = await page
      .getByText(`UNLINKED ${seed.runId}`)
      .first()
      .evaluate((el) => (el.closest("li")?.textContent ?? "").includes("Unread."));
    expect(unlinkedHasWord, "an unlinked unread row still announces state").toBe(true);

    // THE "STILL INVISIBLE" CLAIM, measured geometrically rather than by text.
    //
    // My first version asserted `innerText` does not contain the word. That is
    // WRONG, and instructively so: Tailwind's `sr-only` hides content by
    // CLIPPING a 1x1 box, not by removing it from rendering, so innerText
    // legitimately reports it. innerText is not a proxy for "a sighted user
    // cannot see this" — the box is. A span that ever grew to a readable size
    // would fail here, which is the regression actually worth fencing.
    const srBox = await page
      .locator("li .sr-only")
      .first()
      .evaluate((el) => {
        const e = el as HTMLElement;
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return { w: r.width, h: r.height, pos: cs.position, overflow: cs.overflow };
      });
    expect(srBox.w).toBeLessThanOrEqual(1);
    expect(srBox.h).toBeLessThanOrEqual(1);
    expect(srBox.pos).toBe("absolute");
    expect(srBox.overflow).toBe("hidden");
  });

  test("the status dot stays out of the accessibility tree", async ({ page }) => {
    const seed = await seedNotifications(page);
    await expect(page.getByText(`UNREAD ${seed.runId}`).first()).toBeVisible({ timeout: T });

    const dotExposed = await page.evaluate(() => {
      const dots = Array.from(
        document.querySelectorAll<HTMLElement>("span.rounded-full.bg-rose-600"),
      );
      return dots.filter((d) => d.getAttribute("aria-hidden") === null).length;
    });
    // If the dot were un-hidden to "fix" the name, the row would announce the
    // state twice. The fix adds a name; it must not un-hide the mark.
    expect(dotExposed).toBe(0);
  });

  test("the sr-only text contributes NO layout — measured by removing it", async ({
    page,
  }) => {
    const seed = await seedNotifications(page);
    const row = page.getByText(`UNREAD ${seed.runId}`).first();
    await expect(row).toBeVisible({ timeout: T });

    // Isolates exactly this slice's layout contribution: measure the row and a
    // neighbour, delete the sr-only span, measure again. Anything that moves is
    // caused by the span and nothing else.
    const delta = await row.evaluate((el) => {
      const li = el.closest("li") as HTMLElement;
      const list = li.parentElement as HTMLElement;
      const idx = Array.from(list.children).indexOf(li);
      const neighbour = list.children[idx + 1] as HTMLElement | undefined;
      const read = () => ({
        w: li.offsetWidth,
        h: li.offsetHeight,
        top: li.offsetTop,
        nTop: neighbour ? neighbour.offsetTop : -1,
        page: document.body.scrollHeight,
      });
      const before = read();
      const sr = li.querySelector(".sr-only");
      if (!sr) return { found: false, before, after: before };
      sr.remove();
      // Force layout before re-reading.
      void li.offsetHeight;
      return { found: true, before, after: read() };
    });

    expect(delta.found, "the sr-only span must be present to measure").toBe(true);
    expect(delta.after).toEqual(delta.before);
  });
});
