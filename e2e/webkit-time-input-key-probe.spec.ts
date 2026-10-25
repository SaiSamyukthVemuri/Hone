import { test, expect, type Page } from "@playwright/test";

// HON-62 discriminator (#1094, run 40087568090). In Playwright's Linux WebKit
// the availability editor's keyboard test typed '08' into "Monday opens" and
// the value stayed 06:00 (the key delivery checkpoint). Two explanations:
//
//   ENGINE_LIMIT  Playwright's Linux WebKit does not take typed digits into
//                 the segments of ANY <input type="time">; the app is not
//                 involved and a human Safari check is the only evidence.
//   APP_DEFECT    A bare time input takes the digits and the editor's
//                 controlled TimeField loses them; that would reproduce in
//                 Safari and is the customer's "could not type a time".
//
// This probe takes the app out. It runs on about:blank with no server data and
// no login: bare inputs only, plus one that mimics a controlled React input.
// It does NOT assert the engine's behaviour; it asserts only that the harness
// delivered the keys at all (keydown reached the focused input), then prints
// one machine-readable line per case:
//
//   HON62-PROBE {"case": "...", "value": "...", "events": [...]}
//
// Reading it: P1 or P2 value "08:00" (with P3 "07:00") means segment entry
// works in this engine, so a failing editor test points at the app. P1 and P2
// both "06:00" while P3 changes the value means arrow keys reach the segments
// but digit typing does not (ENGINE_LIMIT for typing). All three "06:00" with
// keydown events recorded means keys are not reaching the segments at all
// (ENGINE_LIMIT). The controlled mimic (P5) must equal P1; if it differs, a
// re-assigned value is what drops the digits.
//
// WebKit only: every other project skips it. Synthetic, no network, no data.

test.skip(({ browserName }) => browserName !== "webkit", "WebKit-only discriminator for HON-62");

const MARKUP = `<!doctype html><meta charset="utf-8"><title>probe</title>
<input id="t" type="time" value="06:00" aria-label="probe time">
<input id="c" type="time" value="06:00" aria-label="controlled mimic">
<script>
  window.__ev = [];
  const log = (id) => (e) => window.__ev.push(id + ":" + e.type + (e.key ? "(" + e.key + ")" : "") + (e.data ? "[" + e.data + "]" : ""));
  for (const id of ["t", "c"]) {
    const el = document.getElementById(id);
    for (const type of ["keydown", "keypress", "beforeinput", "input", "change"]) el.addEventListener(type, log(id));
  }
  // What a React controlled input does: state follows the event, then the DOM
  // value is re-assigned from state on every render.
  let state = "06:00";
  const c = document.getElementById("c");
  c.addEventListener("input", (e) => { state = e.target.value; c.value = state; });
</script>`;

async function fresh(page: Page) {
  await page.goto("about:blank");
  await page.setContent(MARKUP);
}

async function report(page: Page, name: string, id: string) {
  const value = await page.locator(`#${id}`).inputValue();
  const events = await page.evaluate(() => (window as unknown as { __ev: string[] }).__ev);
  console.log("HON62-PROBE " + JSON.stringify({ case: name, value, events }));
  return { value, events };
}

// The harness check: the keys reached the focused element. Not an engine claim.
function keysDelivered(events: string[], id: string, n: number) {
  expect(events.filter((e) => e.startsWith(`${id}:keydown`)).length, `${id} keydown events`).toBe(n);
}

test("P1 focus() then type '08' into a bare time input", async ({ page }) => {
  await fresh(page);
  await page.locator("#t").focus();
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("t");
  await page.keyboard.type("08");
  const { events } = await report(page, "P1 focus+type08", "t");
  keysDelivered(events, "t", 2);
});

test("P2 click the hour segment then type '08'", async ({ page }) => {
  await fresh(page);
  const box = await page.locator("#t").boundingBox();
  expect(box).not.toBeNull();
  await page.locator("#t").click({ position: { x: 14, y: Math.round((box?.height ?? 20) / 2) } });
  await page.keyboard.type("08");
  const { events } = await report(page, "P2 click-hour+type08", "t");
  keysDelivered(events, "t", 2);
});

test("P3 ArrowUp on the focused hour segment", async ({ page }) => {
  await fresh(page);
  await page.locator("#t").focus();
  await page.keyboard.press("ArrowUp");
  const { events } = await report(page, "P3 focus+ArrowUp", "t");
  keysDelivered(events, "t", 1);
});

test("P4 type '08', ArrowRight, type '30'", async ({ page }) => {
  await fresh(page);
  await page.locator("#t").focus();
  await page.keyboard.type("08");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("30");
  const { events } = await report(page, "P4 08,ArrowRight,30", "t");
  keysDelivered(events, "t", 5);
});

test("P5 a controlled-input mimic receives the same digits", async ({ page }) => {
  await fresh(page);
  await page.locator("#c").focus();
  await page.keyboard.type("08");
  const { events } = await report(page, "P5 controlled-mimic focus+type08", "c");
  keysDelivered(events, "c", 2);
});
