import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// HON-124 item 6. A production-build browser check showed posthog-js writing a stable id (`ph_*` cookie, localStorage and
// sessionStorage) on EVERY route, including the signed-in app, /book, /cancel/<token> and the portal, because it was initialised
// in instrumentation-client.ts. The rule: PostHog starts ONLY from the marketing surface, after a route check, and Vercel's
// analytics scripts are not mounted in the app, /admin or /book. `before_send` stays as the backstop for what leaves.
// The browser-side proof is e2e/marketing-analytics-boundary.spec.ts (token-independent, because the lane has no PostHog token).

const ROOT = process.cwd();
const norm = (p: string) => relative(ROOT, p).split(sep).join("/");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}
const SOURCES = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components")), ...walk(join(ROOT, "lib"))]
  .concat(["instrumentation-client.ts", "instrumentation.ts", "middleware.ts"].map((f) => join(ROOT, f)).filter((f) => { try { statSync(f); return true; } catch { return false; } }))
  .map((f) => ({ path: norm(f), text: readFileSync(f, "utf8") }));

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const BROWSER_MODULE = "lib/analytics/posthog-browser.ts";
const importsOf = (needle: RegExp) => SOURCES.filter((s) => needle.test(strip(s.text))).map((s) => s.path).sort();

describe("PostHog starts only from the marketing surface", () => {
  it("the walk is not empty (positive control)", () => {
    expect(SOURCES.length).toBeGreaterThan(500);
    expect(SOURCES.some((s) => s.path === BROWSER_MODULE)).toBe(true);
  });

  it("posthog-js is named in exactly one source file, and instrumentation-client.ts does not touch it", () => {
    expect(importsOf(/["']posthog-js(?:\/[^"']*)?["']/)).toEqual([BROWSER_MODULE]);
    const client = strip(readFileSync(join(ROOT, "instrumentation-client.ts"), "utf8"));
    expect(client).not.toMatch(/posthog/i);
  });

  it("that module loads posthog-js lazily (dynamic import), never statically", () => {
    const src = strip(readFileSync(join(ROOT, BROWSER_MODULE), "utf8"));
    expect(src).toMatch(/import\("posthog-js"\)/);
    expect(src).not.toMatch(/^\s*import\s+[^;]*from\s+["']posthog-js/m);
  });

  it("it checks the route BEFORE it imports anything, and again before it initialises, and never inits without a token", () => {
    const src = strip(readFileSync(join(ROOT, BROWSER_MODULE), "utf8"));
    const imp = src.indexOf('import("posthog-js")');
    const firstRoute = src.indexOf("isMarketingPath(window.location.pathname)");
    const tokenCheck = src.indexOf("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN");
    const init = src.indexOf("posthog.init(");
    expect(firstRoute).toBeGreaterThan(-1);
    expect(firstRoute).toBeLessThan(imp);
    expect(tokenCheck).toBeGreaterThan(imp);
    expect(tokenCheck).toBeLessThan(init);
    expect(src).toMatch(/if \(!token\) return;/);
    expect(src.split("isMarketingPath(window.location.pathname)").length - 1).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/before_send:\s*guardBrowserEvent/);
  });

  it("only MarketingAnalytics starts it, and only MarketingSurface mounts that", () => {
    expect(importsOf(/posthog-browser["']/)).toEqual(["app/_components/marketing/MarketingAnalytics.tsx"]);
    expect(importsOf(/\bMarketingAnalytics\b/).filter((p) => p !== "app/_components/marketing/MarketingAnalytics.tsx")).toEqual([
      "app/_components/marketing/primitives.tsx",
    ]);
  });

  it("MarketingSurface is not used by the app, /admin, /book, the portal or any token route", () => {
    const users = importsOf(/\bMarketingSurface\b/).filter((p) => p !== "app/_components/marketing/primitives.tsx");
    const forbidden = /^app\/(\(app\)|admin|book|portal|cancel|reschedule|manage|intake|invitation|calendar-feed|api)\b/;
    expect(users.filter((p) => forbidden.test(p)), "MarketingSurface used on a non-marketing tree").toEqual([]);
    expect(users.length).toBeGreaterThan(5);
  });
});

describe("Vercel analytics scripts are not mounted in the app, /admin, /book or the portal", () => {
  it("SafeAnalytics and the Vercel packages are imported only by marketing pages", () => {
    const forbidden = /^app\/(\(app\)|admin|book|portal|cancel|reschedule|manage|intake|invitation|calendar-feed|api|login|\(auth\))\b|^components\//;
    const importers = importsOf(/SafeAnalytics["']|@vercel\/analytics|@vercel\/speed-insights/);
    expect(importers.filter((p) => forbidden.test(p)), "analytics mounted on a non-marketing tree").toEqual([]);
    expect(importers).toEqual(expect.arrayContaining(["app/_components/SafeAnalytics.tsx", "app/page.tsx"]));
  });

  it("the /book segment has no layout that could re-mount it", () => {
    expect(SOURCES.some((s) => s.path === "app/book/layout.tsx")).toBe(false);
  });
});
