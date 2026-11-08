import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonalChartingCard } from "@/app/(app)/dashboard/personal-charting-card";

const html = (m: Parameters<typeof PersonalChartingCard>[0]["metrics"]) =>
  renderToStaticMarkup(createElement(PersonalChartingCard, { metrics: m }));

describe("PersonalChartingCard", () => {
  it("shows the figure as x/y", () => {
    expect(html({ completedCount: 4, chartedWithin24hCount: 3 })).toContain("3/4");
  });
  it("a true zero is stated as no completed sessions", () => {
    expect(html({ completedCount: 0, chartedWithin24hCount: 0 })).toContain("No completed sessions of yours");
  });
  it("a failed read is stated, never 0/0", () => {
    const out = html(null);
    expect(out).toContain("Could not load your charting figure");
    expect(out).not.toContain("0/0");
  });
  it("is rendered for non-owners only, and the loader is started only for them", () => {
    const stack = readFileSync("app/(app)/dashboard/secondary-stack.tsx", "utf8");
    expect(stack).toMatch(/\{!isOwner && personalCharting !== null && \(/);
    const page = readFileSync("app/(app)/dashboard/page.tsx", "utf8");
    expect(page).toMatch(/isOwner\s*\?\s*Promise\.resolve\(null\)\s*:\s*getPersonalChartedWithin24h\(/);
  });
});
