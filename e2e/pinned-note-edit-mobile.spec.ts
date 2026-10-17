import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eClient,
  seedPinnedNote,
  getPinnedNoteById,
  seedConfirmedAppointment,
  getOwnerPractitionerId,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Editing a mutable pinned note at iPhone width (Chloe's request): Edit opens an
// inline editor pre-filled with the current text; Save updates the SAME note in
// place (same id, no duplicate); Cancel leaves it unchanged; no horizontal
// overflow while editing.

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({
    s: document.documentElement.scrollWidth,
    c: document.documentElement.clientWidth,
  }));
  expect(
    w.s,
    `${label}: page must not scroll horizontally (${w.s} vs ${w.c})`,
  ).toBeLessThanOrEqual(w.c);
}

async function iphone(browser: import("@playwright/test").Browser) {
  return browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    deviceScaleFactor: 2,
  });
}

test("owner edits a pinned note in place on an iPhone viewport", async ({ browser }) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const noteId = await seedPinnedNote(seed.studioId, clientId, "Allergy: latex");

  const ctx = await iphone(browser);
  try {
    const page = await ctx.newPage();
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}`);

    await expect(page.getByText("Allergy: latex")).toBeVisible({ timeout: 20_000 });
    await expectNoHorizontalOverflow(page, "client profile @390 (view)");

    await page.getByRole("button", { name: "Edit pinned note" }).click();
    const editor = page.getByRole("textbox", { name: "Edit pinned note" });
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue("Allergy: latex"); // pre-filled
    await expectNoHorizontalOverflow(page, "client profile @390 (editing)");

    await editor.fill("Allergy: latex + penicillin");
    await page.getByRole("button", { name: /^Save$/ }).click();

    // HON-9: the editor is a <textarea>, whose text content React mirrors from
    // its value, so getByText would match the open editor itself before the
    // save lands. Wait for the editor to close, then for the saved row.
    await expect(editor).toBeHidden({ timeout: 20_000 });
    await expect(page.getByText("Allergy: latex + penicillin")).toBeVisible({ timeout: 20_000 });
    await expectNoHorizontalOverflow(page, "client profile @390 (after save)");

    // Same note id, text changed → edited in place, not deleted + recreated.
    await expect.poll(async () => (await getPinnedNoteById(noteId))?.text, { timeout: 20_000 }).toBe("Allergy: latex + penicillin");
    const row = await getPinnedNoteById(noteId);
    expect(row?.id).toBe(noteId);
  } finally {
    await ctx.close();
  }
});

// HON-9: the FULL pinned note is readable in place. A 200-character note used
// to scroll sideways inside a single-line input while being edited; the field
// now wraps and grows to show all of it. Keyboard behaviour is unchanged:
// Enter saves, and a pasted line break becomes a space (no stored newlines).
const LONG_NOTE =
  "Allergic to lidocaine and latex. Prefers the right side first. Numbs easily on the upper lip; " +
  "stop at 40 minutes. Bring the 3-step probe set. Rebook in four weeks, Tuesday mornings only.";

test("a full 200-character pinned note is readable while editing, and Enter still saves", async ({ browser }) => {
  expect(LONG_NOTE.length).toBeLessThanOrEqual(200);
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const noteId = await seedPinnedNote(seed.studioId, clientId, LONG_NOTE);

  const ctx = await iphone(browser);
  try {
    const page = await ctx.newPage();
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}`);
    await expect(page.getByText(LONG_NOTE)).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Edit pinned note" }).click();
    const editor = page.getByRole("textbox", { name: "Edit pinned note" });
    await expect(editor).toHaveValue(LONG_NOTE);

    // The whole note is on screen: no inner scroll either way, and the field
    // grew beyond one line to hold it.
    const box = await editor.evaluate((el) => {
      const t = el as HTMLTextAreaElement;
      const lineHeight = parseFloat(getComputedStyle(t).lineHeight) || 20;
      return {
        tag: t.tagName,
        scrollH: t.scrollHeight,
        clientH: t.clientHeight,
        scrollW: t.scrollWidth,
        clientW: t.clientWidth,
        lines: t.clientHeight / lineHeight,
      };
    });
    expect(box.tag).toBe("TEXTAREA");
    expect(box.scrollH, "no vertical scroll inside the editor").toBeLessThanOrEqual(box.clientH + 1);
    expect(box.scrollW, "no horizontal scroll inside the editor").toBeLessThanOrEqual(box.clientW + 1);
    expect(box.lines, "the editor grew to several lines for a long note").toBeGreaterThan(2);
    await expectNoHorizontalOverflow(page, "client profile @390 (editing a long note)");
    await expect(page.getByText(`${LONG_NOTE.length}/200`)).toBeVisible();

    // A pasted line break is flattened, and Enter saves (no newline stored).
    await editor.fill("");
    await editor.evaluate((el, v) => {
      const t = el as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(t, v);
      t.dispatchEvent(new Event("input", { bubbles: true }));
    }, "Line one\nLine two");
    await expect(editor).toHaveValue("Line one Line two");
    await editor.press("Enter");
    await expect(editor).toBeHidden({ timeout: 20_000 }); // Enter saved and closed the editor
    await expect(page.getByText("Line one Line two")).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await getPinnedNoteById(noteId))?.text, { timeout: 20_000 }).toBe("Line one Line two");
  } finally {
    await ctx.close();
  }
});

test("a long unbroken pinned note wraps on the appointment page instead of pushing it sideways", async ({ browser }) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const unbroken = "x".repeat(200);
  await seedPinnedNote(seed.studioId, clientId, unbroken);
  const practitionerId = await getOwnerPractitionerId(seed.studioId);
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const appointmentId = await seedConfirmedAppointment(seed.studioId, practitionerId, clientId, start.toISOString(), end.toISOString());

  const ctx = await iphone(browser);
  try {
    const page = await ctx.newPage();
    await loginAsOwner(page, seed);
    await page.goto(`/calendar/${appointmentId}`);
    await expect(page.getByText(unbroken)).toBeVisible({ timeout: 20_000 });
    await expectNoHorizontalOverflow(page, "appointment page @390 (long unbroken pinned note)");
  } finally {
    await ctx.close();
  }
});

test("cancel leaves the pinned note unchanged", async ({ browser }) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const noteId = await seedPinnedNote(seed.studioId, clientId, "Keep me");

  const ctx = await iphone(browser);
  try {
    const page = await ctx.newPage();
    await loginAsOwner(page, seed);
    await page.goto(`/clients/${clientId}`);

    await page.getByRole("button", { name: "Edit pinned note" }).click();
    const editor = page.getByRole("textbox", { name: "Edit pinned note" });
    await editor.fill("changed but cancelled");
    await page.getByRole("button", { name: /^Cancel$/ }).click();

    await expect(page.getByText("Keep me")).toBeVisible();
    const row = await getPinnedNoteById(noteId);
    expect(row?.text).toBe("Keep me"); // unchanged
  } finally {
    await ctx.close();
  }
});
