import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// The desk is a deliberately small, deny-by-default surface. This is an ALLOW-LIST over its
// imports (a new import fails until it is reviewed), not a deny-list (Privacy R5, R6, design 3):
//   * no practitioner guard, no legal identity, no analytics or user-identify helper;
//   * no link from a desk page to an (app) route;
//   * no search term in a URL;
//   * every page, layout and action resolves the receptionist itself.

const ROOT = path.resolve(__dirname, "../..");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const rel = (p: string) => path.relative(ROOT, p);
const read = (p: string) => readFileSync(p, "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const DESK_APP = walk(path.join(ROOT, "app/(desk)")).filter((p) => /\.(ts|tsx)$/.test(p));
const DESK_LIB = walk(path.join(ROOT, "lib/desk")).filter((p) => /\.(ts|tsx)$/.test(p));
const DESK_FILES = [...DESK_APP, ...DESK_LIB];

// The ONLY modules the desk may import. Relative imports stay inside the desk.
const ALLOWED_IMPORTS = new Set([
  "react",
  "next/link",
  "next/navigation",
  "next/cache", // revalidatePath after a booking command
  "server-only",
  "@/lib/supabase/server",
  "@/lib/supabase/selected-studio",
  "@/components/formatted-date-time",
  "@/app/(auth)/no-access/actions", // the shared sign-out action, outside (app)
  "@/app/(desk)/desk/clients/actions", // the desk's own restricted client search, used by the booking form
]);
function importsOf(source: string): string[] {
  return [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
}
function importProblems(source: string): string[] {
  return importsOf(source).filter(
    (spec) => !(ALLOWED_IMPORTS.has(spec) || spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("@/lib/desk/")),
  );
}

/** Every literal href in a source file that is not a desk path, mailto: or tel:. */
function foreignHrefs(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/href=(?:"([^"]*)"|\{"([^"]*)"\}|\{`([^`]*)`\})/g)) {
    const value = m[1] ?? m[2] ?? m[3] ?? "";
    if (!/^(\/desk(\/|$|\?)|mailto:|tel:)/.test(value) && !value.startsWith("${")) found.push(value);
  }
  return found;
}

describe("the desk imports only what was reviewed (allow-list)", () => {
  it("covers the files that exist (anti-vacuity)", () => {
    const names = DESK_FILES.map(rel);
    expect(names).toEqual(expect.arrayContaining([
      "app/(desk)/layout.tsx", "app/(desk)/desk/page.tsx", "app/(desk)/desk/clients/page.tsx",
      "app/(desk)/desk/clients/actions.ts", "app/(desk)/desk/clients/DeskDirectory.tsx",
      "app/(desk)/desk/actions.ts", "app/(desk)/desk/book/page.tsx", "app/(desk)/desk/book/BookForm.tsx",
      "app/(desk)/desk/ScheduleRowActions.tsx", "lib/desk/book.ts", "lib/desk/time.ts",
      "lib/desk/guard.ts", "lib/desk/read.ts", "lib/desk/flag.ts", "lib/desk/home.ts", "lib/desk/membership.ts",
    ]));
  });

  it.each(DESK_FILES.map(rel))("%s imports nothing outside the allow-list", (file) => {
    expect(importProblems(read(path.join(ROOT, file)))).toEqual([]);
  });

  it("control: the checker flags a practitioner guard, legal identity and an analytics helper", () => {
    expect(importProblems('import { requirePractitionerWithStudio } from "@/lib/supabase/queries";')).toHaveLength(1);
    expect(importProblems('import { x } from "@/lib/clients/legal-identity";')).toHaveLength(1);
    expect(importProblems('import { identifyServerUser } from "@/lib/analytics/server";')).toHaveLength(1);
    expect(importProblems('import { SafeAnalytics } from "@/app/_components/SafeAnalytics";')).toHaveLength(1);
  });

  it("names none of the practitioner, analytics or clinical helpers anywhere in the desk, even in text", () => {
    const forbidden = /requirePractitionerWithStudio|getCurrentPractitionerWithStudio|identifyServerUser|captureServerEvent|SafeAnalytics|posthog|@vercel\/analytics|legal-identity|legal_|client_legal_identities|treatment_images|session_blocks|signed-url|date_of_birth/i;
    for (const file of DESK_FILES) {
      expect(stripComments(read(file)), rel(file)).not.toMatch(forbidden);
    }
  });
});

describe("R6: no desk element links to an (app) route", () => {
  it.each(DESK_APP.filter((p) => p.endsWith(".tsx")).map(rel))("%s links only under /desk (plus mailto: and tel:)", (file) => {
    expect(foreignHrefs(read(path.join(ROOT, file)))).toEqual([]);
  });

  it("control: the checker flags (app) links", () => {
    expect(foreignHrefs('<a href="/clients/123">x</a>')).toEqual(["/clients/123"]);
    expect(foreignHrefs("<Link href={`/calendar`}>x</Link>")).toEqual(["/calendar"]);
    expect(foreignHrefs('<a href="/dashboard">x</a>')).toEqual(["/dashboard"]);
    expect(foreignHrefs('<a href="/desk/clients">x</a><a href="mailto:a@b">y</a>')).toEqual([]);
  });

  it("an intake 'awaiting review' status is plain text, not a link", () => {
    const src = read(path.join(ROOT, "app/(desk)/desk/clients/DeskDirectory.tsx"));
    expect(src).toContain('awaiting_review: "Intake awaiting review"');
    expect(src).not.toMatch(/<(a|Link)[^>]*>[^<]*(intake|review)/i);
    expect(src).not.toMatch(/router\.|window\.location|redirect\(/);
  });
});

describe("R5: the search term is never in a URL", () => {
  it("no desk file reads or writes a query string or navigates with state", () => {
    for (const file of DESK_APP) {
      const src = stripComments(read(file));
      expect(src, rel(file)).not.toMatch(/searchParams|useSearchParams|useRouter|router\.(push|replace)|history\.|location\.(search|href)|URLSearchParams|method="get"|\?q=|[?&]q=/);
    }
  });

  it("the search form is a server action, not a GET form", () => {
    const src = read(path.join(ROOT, "app/(desk)/desk/clients/DeskDirectory.tsx"));
    expect(src).toContain("useActionState");
    expect(src).toMatch(/<form\s+action=\{action\}/);
  });

  it("the desk pages take no props at all (so they cannot be handed a term)", () => {
    for (const f of ["app/(desk)/desk/page.tsx", "app/(desk)/desk/clients/page.tsx"]) {
      expect(read(path.join(ROOT, f))).toMatch(/export default async function \w+\(\)/);
    }
  });
});

describe("R3/R4: every page, layout and action resolves the receptionist itself", () => {
  it("each page and the layout call requireReceptionistWithStudio (a layout redirect does not stop its page)", () => {
    for (const f of ["app/(desk)/layout.tsx", "app/(desk)/desk/page.tsx", "app/(desk)/desk/clients/page.tsx"]) {
      expect(read(path.join(ROOT, f)), f).toMatch(/await requireReceptionistWithStudio\(\)/);
    }
  });

  it("the server action resolves the receptionist (the throwing variant) before any read", () => {
    const src = read(path.join(ROOT, "app/(desk)/desk/clients/actions.ts"));
    expect(src.indexOf("getReceptionistWithStudio()")).toBeGreaterThan(-1);
    expect(src.indexOf("getReceptionistWithStudio()")).toBeLessThan(src.indexOf("readDeskDirectory("));
    expect(src).toMatch(/^"use server";/);
  });

  it("the guard checks the flag before any read and validates the cookie only against studio_receptionists", () => {
    const src = read(path.join(ROOT, "lib/desk/guard.ts"));
    expect(src.indexOf("isDeskEnabled()")).toBeLessThan(src.indexOf("loadDeskRows()"));
    expect(src).toContain('.from("studio_receptionists")');
    expect(src).not.toContain('.from("practitioners")');
    expect(src).not.toContain('.from("studios")');
  });

  it("the practitioner guard, its identity loader and the cookie module know nothing about the desk", () => {
    for (const f of ["lib/supabase/queries.ts", "lib/supabase/selected-studio.ts"]) {
      expect(read(path.join(ROOT, f)), f).not.toMatch(/desk|receptionist/i);
    }
  });
});

describe("routing: /desk is private and inert by default", () => {
  const mw = read(path.join(ROOT, "lib/supabase/middleware.ts"));
  const publicBlock = mw.slice(mw.indexOf("const isPublicRoute"), mw.indexOf("if (!user && !isPublicRoute)"));

  it("/desk is not a public route", () => {
    expect(publicBlock).not.toMatch(/desk/);
  });

  it("the middleware exemption exists only behind the flag and only for /desk paths", () => {
    expect(mw).toContain("const isDeskRoute = isDeskEnabled() && isDeskPath(pathname);");
    expect(mw).toMatch(/!isPublicRoute &&\s+!isDeskRoute &&/);
  });

  it("the sign-in landing routes to /desk only from the ordinary dashboard destination, and never blocks sign-in", () => {
    const cb = read(path.join(ROOT, "app/(auth)/auth/callback/route.ts"));
    const block = cb.slice(cb.indexOf("Receptionist landing"), cb.indexOf("Treat the caller's destination"));
    expect(block).toContain('if (dest === "/dashboard")');
    expect(block).toContain("deskHomeFor(");
    expect(block).toMatch(/catch \{/);
  });

  it("the flag is exactly 'true' and is the only switch", () => {
    const flag = read(path.join(ROOT, "lib/desk/flag.ts"));
    expect(flag).toContain('process.env[DESK_FLAG_ENV] === "true"');
    expect(flag).toContain('"HONE_RECEPTIONIST_DESK_ENABLED"');
  });
});

describe("Insurance L1-L5: the desk last completed appointment is its own fact", () => {
  const UI = read(path.join(ROOT, "app/(desk)/desk/clients/DeskDirectory.tsx"));
  it("L1/L2/L3: the desk label, empty text and unavailable text are the ruled ones", () => {
    expect(UI).toContain("Last completed appointment");
    expect(UI).toContain("No completed appointment in Hone");
    expect(UI).toContain('"Unavailable"');
  });
  it("L5: nothing in the desk uses the staff 'Last visit' label, text or module, and none sorts or compares by it", () => {
    for (const f of DESK_FILES) {
      const src = stripComments(read(f));
      expect(src, rel(f)).not.toMatch(/Last visit|No visit recorded|last-visit|lastVisit/);
      expect(src, rel(f)).not.toMatch(/lib\/clients\//);
    }
  });
  it("control: the checker flags the staff label", () => {
    expect(/Last visit|No visit recorded|last-visit|lastVisit/.test('<dt>Last visit</dt>')).toBe(true);
  });
  it("Privacy F2: the consent label claims only 'on file' / 'needed' for treatment consent", () => {
    expect(UI).toContain('"Consent on file" : "Consent needed"');
    expect(UI).not.toContain("Consent signed");
  });
});
