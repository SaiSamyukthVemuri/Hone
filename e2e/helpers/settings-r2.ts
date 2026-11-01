import type { Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Settings R2 verification helpers (HON-68). The click sequence is driven the way
// a person drives it: through the rail (desktop) or the menu drawer (mobile), never
// by navigating to a URL. Observations are plain facts read from the page after each
// step. Screenshots/observations are written only when SETTINGS_SHOTS_DIR is set,
// under <dir>/<SETTINGS_PHASE: before|after>/, outside the repository.

export const R2_SEQUENCE: ReadonlyArray<{ id: string; label: string; entry: string; section?: string }> = [
  { id: "01-profile", label: "Profile", entry: "Profile" },
  { id: "02-personal-details", label: "Personal details", entry: "Profile", section: "Personal details" },
  { id: "03-calendar", label: "Calendar", entry: "Calendar" },
  { id: "04-display-preferences", label: "Display preferences", entry: "Calendar", section: "Display preferences" },
  { id: "05-studio-details", label: "Studio details", entry: "Studio", section: "Studio details" },
  { id: "06-email-notifications", label: "Email notifications", entry: "Studio", section: "Email notifications" },
  { id: "07-text-messages", label: "Text messages", entry: "Studio", section: "Text messages" },
  { id: "08-client-self-service", label: "Client self-service", entry: "Studio", section: "Client self-service" },
  { id: "09-postcare", label: "Postcare", entry: "Forms & Postcare", section: "Postcare" },
  { id: "10-intake-form-preview", label: "Intake form preview", entry: "Forms & Postcare", section: "Intake form preview" },
  { id: "11-cancellation-policy", label: "Cancellation & no-show policy", entry: "Forms & Postcare", section: "Cancellation & no-show policy" },
  { id: "12-booking", label: "Booking", entry: "Booking" },
  { id: "13-payments", label: "Payments", entry: "Payments" },
  { id: "14-integrations", label: "Integrations", entry: "Integrations" },
];

export const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1280) < 700;

async function openMenuIfMobile(page: Page) {
  if (!isMobile(page)) return;
  const menu = page.getByRole("button", { name: "Settings menu", exact: true });
  if (await menu.isVisible()) {
    if ((await menu.getAttribute("aria-expanded")) !== "true") {
      // the menu button may be scrolled out of view: that is itself an observation (recorded after the step)
      await menu.scrollIntoViewIfNeeded();
      await menu.click();
    }
  }
}

/** Click a rail entry, then (if given) one of its sections, exactly as a user would. */
export async function clickRail(page: Page, entry: string, section?: string): Promise<void> {
  await openMenuIfMobile(page);
  const rail = page.getByRole("navigation", { name: "Settings sections" });
  const entryEl = rail.locator("summary, a").filter({ hasText: new RegExp(`^\\s*${entry.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&")}\\s*[⌄›]?\\s*$`) }).first();
  if (!section) {
    await entryEl.click();
    return;
  }
  const sectionLink = rail.getByRole("link", { name: section, exact: true });
  if (!(await sectionLink.isVisible())) await entryEl.click();
  if (!(await sectionLink.isVisible())) await openMenuIfMobile(page);
  await sectionLink.click();
}

export type Observation = {
  step: string;
  width: number;
  url: string;
  hash: string;
  scrollY: number;
  scrollHeight: number;
  viewportHeight: number;
  mainHeadings: Array<{ level: string; text: string; top: number }>;
  firstHeadingTop: number | null;
  headingUnderFixedChrome: boolean;
  fixedChromeBottom: number;
  openGroups: string[];
  railInViewport: boolean | null;
  menuButton: { visible: boolean; inViewport: boolean; top: number | null } | null;
  focus: { tag: string; role: string | null; text: string; isField: boolean };
  fieldsInMain: number;
};

export async function observe(page: Page, step: string): Promise<Observation> {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(700); // let any delayed programmatic scroll show itself: that is what is being observed
  return page.evaluate((stepName) => {
    const vh = window.innerHeight;
    const main = document.querySelector("main") ?? document.body;
    const hs = Array.from(main.querySelectorAll("h1, h2, h3")).filter((h) => {
      const r = (h as HTMLElement).getBoundingClientRect();
      const cs = getComputedStyle(h as HTMLElement);
      return cs.display !== "none" && cs.visibility !== "hidden" && r.height > 0;
    });
    const fixed = Array.from(document.querySelectorAll("header, [class*='sticky'], [class*='fixed']")).filter((el) => {
      const cs = getComputedStyle(el as HTMLElement);
      return (cs.position === "fixed" || cs.position === "sticky") && (el as HTMLElement).getBoundingClientRect().top <= 1 && (el as HTMLElement).getBoundingClientRect().height < vh * 0.5 && (el as HTMLElement).getBoundingClientRect().height > 0;
    });
    const fixedBottom = fixed.reduce((m, el) => Math.max(m, (el as HTMLElement).getBoundingClientRect().bottom), 0);
    const mainHeadings = hs.map((h) => ({
      level: h.tagName,
      text: (h.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      top: Math.round((h as HTMLElement).getBoundingClientRect().top),
    }));
    const nav = document.querySelector('nav[aria-label="Settings sections"]') as HTMLElement | null;
    const nr = nav?.getBoundingClientRect();
    const menu = document.querySelector('button[aria-label="Settings menu"]') as HTMLElement | null;
    const mr = menu?.getBoundingClientRect();
    const mvis = !!menu && getComputedStyle(menu).display !== "none" && (mr?.height ?? 0) > 0;
    const a = document.activeElement as HTMLElement | null;
    const isField = !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
    const first = mainHeadings[0]?.top ?? null;
    return {
      step: stepName,
      width: window.innerWidth,
      url: location.pathname + location.search,
      hash: location.hash,
      scrollY: Math.round(window.scrollY),
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: vh,
      mainHeadings,
      firstHeadingTop: first,
      headingUnderFixedChrome: first !== null && first < fixedBottom,
      fixedChromeBottom: Math.round(fixedBottom),
      openGroups: Array.from(nav?.querySelectorAll("details[open] > summary") ?? []).map((s) => (s.textContent ?? "").replace(/[⌄›]/g, "").replace(/\s+/g, " ").trim()),
      railInViewport: nr ? nr.bottom > 0 && nr.top < vh && nr.width > 0 && getComputedStyle(nav!).display !== "none" : null,
      menuButton: menu ? { visible: mvis, inViewport: mvis && (mr?.bottom ?? 0) > 0 && (mr?.top ?? 0) < vh, top: mr ? Math.round(mr.top) : null } : null,
      focus: {
        tag: a?.tagName ?? "",
        role: a?.getAttribute("role") ?? null,
        text: (a?.getAttribute("aria-label") ?? a?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
        isField,
      },
      fieldsInMain: main.querySelectorAll("input, textarea, select").length,
    };
  }, step);
}

export function phaseDir(): string | null {
  const base = process.env.SETTINGS_SHOTS_DIR;
  if (!base) return null;
  const dir = path.join(base, process.env.SETTINGS_PHASE ?? "before");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function capture(page: Page, id: string): Promise<void> {
  const dir = phaseDir();
  if (!dir) return;
  const w = page.viewportSize()?.width ?? 0;
  await page.screenshot({ path: path.join(dir, `${id}-${w}-view.png`) });
  await page.screenshot({ path: path.join(dir, `${id}-${w}-full.png`), fullPage: true });
}

export function saveObservations(width: number, rows: Observation[]): void {
  const dir = phaseDir();
  if (!dir) return;
  writeFileSync(path.join(dir, `observations-${width}.json`), JSON.stringify(rows, null, 2));
}
