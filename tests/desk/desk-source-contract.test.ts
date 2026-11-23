import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// The desk is a closed surface. These pin its shape by reading the files, so a later change that widens it fails here
// and is reviewed. Spelling-based on purpose, for rules that are about what a file may mention at all.

const ROOT = process.cwd();
const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((n) => {
    const rel = join(dir, n);
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });
const files = [...walk("app/(desk)"), ...walk("lib/desk")].filter((f) => /\.tsx?$/.test(f));
const src = (f: string) => readFileSync(join(ROOT, f), "utf8");
const pages = files.filter((f) => /\/page\.tsx$/.test(f));
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the desk surface", () => {
  it("finds the desk files (the check is not vacuous)", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(pages.length).toBeGreaterThanOrEqual(1);
  });

  it("imports nothing from the practitioner app, and no analytics", () => {
    for (const f of files) {
      const s = stripComments(src(f));
      expect(/from\s+["']@\/app\/\(app\)/.test(s), f).toBe(false);
      expect(/@\/lib\/analytics|posthog|@sentry|gtag|dataLayer/.test(s), f).toBe(false);
    }
  });

  it("writes nothing and has no server action", () => {
    for (const f of files) {
      const s = stripComments(src(f));
      expect(/["']use server["']/.test(s), f).toBe(false);
      expect(/\.(insert|update|upsert|delete)\s*\(/.test(s), f).toBe(false);
    }
  });

  it("reads tables only to find the signed-in user's own receptionist row, and calls one database function", () => {
    const fromCalls = files.flatMap((f) => [...stripComments(src(f)).matchAll(/\.from\(\s*["']([^"']+)["']/g)].map((m) => `${f}:${m[1]}`));
    expect(fromCalls.sort()).toEqual(["lib/desk/entry.ts:studio_receptionists", "lib/desk/guard.ts:studio_receptionists"]);
    const rpcs = files.flatMap((f) => [...stripComments(src(f)).matchAll(/rpc(?:<[^>]*>)?\(\s*["']([^"']+)["']/g)].map((m) => m[1]));
    expect(rpcs).toEqual(["receptionist_calendar_v2"]);
  });

  it("calls the guard in the layout and in every page (a layout's redirect does not stop its page)", () => {
    expect(src("app/(desk)/layout.tsx")).toContain("requireReceptionistWithStudio()");
    for (const p of pages) expect(src(p), p).toContain("requireReceptionistWithStudio()");
  });

  it("is dynamic and never statically generated or revalidated", () => {
    for (const f of ["app/(desk)/layout.tsx", ...pages]) {
      expect(src(f), f).toMatch(/export const dynamic = "force-dynamic"/);
      expect(/generateStaticParams|export const revalidate|unstable_cache|"force-static"/.test(src(f)), f).toBe(false);
    }
  });

  it("prefetches no link and carries no search or sort of client data", () => {
    for (const f of files.filter((x) => x.endsWith(".tsx"))) {
      const s = stripComments(src(f));
      for (const m of s.matchAll(/<Link\b[^>]*>/g)) expect(m[0], `${f}: ${m[0]}`).toContain("prefetch={false}");
      expect(/searchParams|type="search"|name="q"/.test(s), f).toBe(false);
    }
  });

  it("keeps every desk path under /desk", () => {
    for (const f of files.filter((x) => x.endsWith(".tsx"))) {
      for (const m of stripComments(src(f)).matchAll(/href=["']([^"']+)["']/g)) expect(m[1].startsWith("/desk"), `${f}: ${m[1]}`).toBe(true);
    }
  });

  it("lists exactly the files this slice ships, so an addition is a decision", () => {
    expect(files.map((f) => relative(ROOT, join(ROOT, f))).sort()).toEqual([
      "app/(desk)/desk/ClockFallbackNotice.tsx",
      "app/(desk)/desk/page.tsx",
      "app/(desk)/layout.tsx",
      "lib/desk/entry.ts",
      "lib/desk/flag.ts",
      "lib/desk/guard.ts",
      "lib/desk/membership.ts",
      "lib/desk/read.ts",
      "lib/desk/time.ts",
    ]);
  });
});
