import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The marketing pages are public. The auth middleware allowlists public routes
// explicitly; a missing entry silently bounces anonymous visitors (and search
// crawlers) to /login. These pins guard every shipped marketing route + the
// generated crawler files against that regression.

const MW = readFileSync(join(process.cwd(), "lib/supabase/middleware.ts"), "utf8");

const EXACT_PUBLIC = [
  "/",
  "/pricing",
  "/demo",
  "/privacy",
  "/terms",
  "/electrolysis-software",
  "/features/treatment-memory",
  "/features/booking-calendar",
  "/features/charting-records",
  "/resources",
  "/sitemap.xml",
  "/robots.txt",
];

describe("middleware public-route allowlist", () => {
  it("allowlists every shipped marketing route by exact match", () => {
    for (const p of EXACT_PUBLIC) {
      expect(MW.includes(`pathname === "${p}"`), `missing public route: ${p}`).toBe(true);
    }
  });

  it("allowlists the resource articles via the /resources/ prefix", () => {
    expect(MW).toMatch(/pathname\.startsWith\("\/resources\/"\)/);
  });

  it("still redirects unauthenticated users away from non-public routes", () => {
    // The gate itself is intact (defense against an accidental blanket allow).
    expect(MW).toMatch(/if \(!user && !isPublicRoute\)/);
    expect(MW).toMatch(/url\.pathname = "\/login"/);
  });
});
