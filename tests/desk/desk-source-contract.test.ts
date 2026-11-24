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
const files = [...walk("app/(desk)"), ...walk("app/(desk-choose)"), ...walk("lib/desk")].filter((f) => /\.tsx?$/.test(f));
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

  it("keeps contacts out of the calendar payload and loads them only in the visit dialog", () => {
    expect(files.filter(f => /^\s*["']use client["']/m.test(src(f))).sort()).toEqual([
      "app/(desk)/desk/DeskBooking.tsx", "app/(desk)/desk/DeskCalendar.tsx", "app/(desk)/desk/DeskVisitDetails.tsx",
    ]);
    const pagesWithContactRead = files.filter(f => f.endsWith(".tsx") && src(f).includes("getDeskAppointmentContactAction"));
    expect(pagesWithContactRead).toEqual(["app/(desk)/desk/DeskVisitDetails.tsx"]);
    expect(src("app/(desk)/desk/page.tsx")).toContain("key={identity.receptionistId + identity.studioId}");
  });

  it("limits server actions to the chooser and the receptionist booking workflow", () => {
    const ACTION = "lib/desk/choose-actions.ts";
    expect(files.filter((f) => /^\s*["']use server["']/m.test(stripComments(src(f)))).sort()).toEqual(["app/(desk)/desk/booking-actions.ts", "app/(desk)/desk/contact-actions.ts", ACTION]);
    const a = stripComments(src(ACTION));
    expect((a.match(/export async function/g) ?? []).length).toBe(1);
    expect(a).toMatch(/setSelectedStudioId\(/);
    expect(/createClient|\.from\(|\.rpc\(|@\/lib\/supabase\/(server|client)/.test(a), "the action reads through the guard only and writes nothing else").toBe(false);
    // The action re-reads the user's active rows before it sets the cookie.
    expect(a.indexOf("await requireReceptionistChoice()")).toBeGreaterThan(-1);
    expect(a.indexOf("await requireReceptionistChoice()")).toBeLessThan(a.indexOf("setSelectedStudioId("));
    for (const f of files) {
      const s = stripComments(src(f));
      expect(/\.(insert|update|upsert|delete)\s*\(/.test(s), f).toBe(false);
    }
  });

  it("reads tables only to find the signed-in user's own receptionist row, with desk-specific RPCs for scheduling", () => {
    const fromCalls = files.flatMap((f) => [...stripComments(src(f)).matchAll(/\.from\(\s*["']([^"']+)["']/g)].map((m) => `${f}:${m[1]}`));
    expect(fromCalls.sort()).toEqual(["lib/desk/entry.ts:studio_receptionists", "lib/desk/guard.ts:studio_receptionists"]);
    const rpcs = files.flatMap((f) => [...stripComments(src(f)).matchAll(/rpc(?:<[^>]*>)?\(\s*["']([^"']+)["']/g)].map((m) => m[1]));
    expect(rpcs.sort()).toEqual([
      "receptionist_appointment_contact", "receptionist_book_opening", "receptionist_booking_options", "receptionist_calendar_v3",
      "receptionist_booking_clients_v3", "receptionist_find_openings_v2", "receptionist_studio_timezone",
    ].sort());
    for (const f of files) {
      expect(stripComments(src(f)), f).not.toMatch(/createAdminClient|@\/lib\/supabase\/admin/);
    }
  });

  it("calls the guard in the layout and in every page (a layout's redirect does not stop its page)", () => {
    // On the code with comments removed, and as an awaited call: a commented-out call or a bare reference must not pass.
    const awaited = /await\s+requireReceptionistWithStudio\(\)/;
    const awaitedChoice = /await\s+requireReceptionistChoice\(\)/;
    expect(stripComments(src("app/(desk)/layout.tsx"))).toMatch(awaited);
    for (const p of pages) expect(stripComments(src(p)), p).toMatch(p === "app/(desk-choose)/desk/choose/page.tsx" ? awaitedChoice : awaited);
    expect(pages).toContain("app/(desk-choose)/desk/choose/page.tsx");
  });

  it("is dynamic and never statically generated or revalidated", () => {
    for (const f of ["app/(desk)/layout.tsx", ...pages]) {
      expect(src(f), f).toMatch(/export const dynamic = "force-dynamic"/);
      expect(/generateStaticParams|export const revalidate|unstable_cache|"force-static"/.test(src(f)), f).toBe(false);
    }
  });

  it("keeps booking searches out of URLs, and prefetches no links", () => {
    for (const f of files.filter((x) => x.endsWith(".tsx"))) {
      const s = stripComments(src(f));
      for (const m of s.matchAll(/<Link\b[^>]*>/g)) expect(m[0], `${f}: ${m[0]}`).toContain("prefetch={false}");
      expect(/type="search"|name="q"/.test(s), f).toBe(false);
      if (f !== "app/(desk)/desk/page.tsx") expect(s.includes("searchParams"), f).toBe(false);
    }
  });

  it("accepts only date and view for calendar navigation", () => {
    const page = stripComments(src("app/(desk)/desk/page.tsx"));
    expect([...new Set([...page.matchAll(/params\.(\w+)/g)].map(m => m[1]))].sort()).toEqual(["date", "view"]);
    expect(src("app/(desk)/desk/desk-period.ts")).toContain('return `/desk?date=${date}&view=${view}`;');
  });

  it("keeps every desk path under /desk", () => {
    for (const f of files.filter((x) => x.endsWith(".tsx"))) {
      for (const m of stripComments(src(f)).matchAll(/href=["']([^"']+)["']/g)) expect(m[1].startsWith("/desk"), `${f}: ${m[1]}`).toBe(true);
    }
  });

  it("lists exactly the files this slice ships, so an addition is a decision", () => {
    expect(files.map((f) => relative(ROOT, join(ROOT, f))).sort()).toEqual([
      "app/(desk)/desk/ClockFallbackNotice.tsx",
      "app/(desk)/desk/DeskBooking.tsx",
      "app/(desk)/desk/DeskCalendar.tsx",
      "app/(desk)/desk/DeskTimeGrid.tsx",
      "app/(desk)/desk/DeskVisitDetails.tsx",
      "app/(desk)/desk/booking-actions.ts",
      "app/(desk)/desk/contact-actions.ts",
      "app/(desk)/desk/desk-period.ts",
      "app/(desk)/desk/page.tsx",
      "app/(desk)/layout.tsx",
      "app/(desk-choose)/desk/choose/page.tsx",
      "lib/desk/booking.ts",
      "lib/desk/choose-actions.ts",
      "lib/desk/entry.ts",
      "lib/desk/flag.ts",
      "lib/desk/guard.ts",
      "lib/desk/membership.ts",
      "lib/desk/read.ts",
      "lib/desk/time.ts",
    ]);
  });
});
