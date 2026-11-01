import type { Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Dashboard WS-DC verification helpers. Screenshots and observations are written
// only when DASH_SHOTS_DIR is set, under <dir>/<DASH_PHASE: before|after>/, outside
// the repository. Synthetic studio only; nothing here reads a real database.

const DIR = process.env.DASH_SHOTS_DIR;
const PHASE = process.env.DASH_PHASE ?? "after";

export const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1280) < 700;
const width = (page: Page) => page.viewportSize()?.width ?? 1280;

export type DashFacts = {
  url: string;
  width: number;
  h1: string | null;
  h2: string[];
  appointmentsBox: { x: number; y: number; w: number; h: number } | null;
  needsBox: { x: number; y: number; w: number; h: number } | null;
  needsCountText: string | null;
  entryCount: number;
  rosterRows: number;
  horizontalOverflow: boolean;
  snapshotNumbers: Record<string, string>;
};

export async function facts(page: Page): Promise<DashFacts> {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const appts = document.querySelector('section[aria-label="Appointments"]');
    const needs = document.querySelector('section[aria-labelledby="needs-attention-heading"]');
    const snap: Record<string, string> = {};
    for (const h3 of Array.from(document.querySelectorAll("h3"))) {
      const card = h3.closest("section");
      if (!card) continue;
      const rows = Array.from(card.querySelectorAll("div.flex.items-baseline")).map((d) => (d.textContent ?? "").replace(/\s+/g, " ").trim());
      const big = card.querySelector("p.text-3xl");
      snap[(h3.textContent ?? "").trim()] = [big?.textContent ?? "", ...rows].filter(Boolean).join(" | ");
    }
    return {
      url: location.pathname + location.search,
      width: window.innerWidth,
      h1: document.querySelector("h1")?.textContent?.trim() ?? null,
      h2: Array.from(document.querySelectorAll("h2")).map((h) => (h.textContent ?? "").trim()),
      appointmentsBox: box(appts),
      needsBox: box(needs),
      needsCountText: document.querySelector('[data-testid="needs-attention-count"]')?.textContent?.trim() ?? null,
      entryCount: document.querySelectorAll("[data-attention-id]").length,
      rosterRows: appts ? appts.querySelectorAll(":scope > ul > li").length : 0,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      snapshotNumbers: snap,
    };
  });
}

/** Full-page screenshot plus the observed facts, named; written only when DASH_SHOTS_DIR is set. */
export async function capture(page: Page, name: string): Promise<DashFacts> {
  const f = await facts(page);
  if (DIR) {
    const dir = path.join(DIR, PHASE);
    mkdirSync(dir, { recursive: true });
    const base = `${name}-${width(page)}`;
    await page.screenshot({ path: path.join(dir, `${base}.png`), fullPage: true });
    writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(f, null, 1));
  }
  return f;
}
