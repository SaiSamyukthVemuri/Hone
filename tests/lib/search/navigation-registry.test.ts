import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  matchNavEntries,
  normalizeNavText,
  NAV_ENTRIES,
  NON_SEARCHABLE_ROUTES,
  NON_SEARCHABLE_RECORD_SECTIONS,
  type NavEntry,
  type NavSearchContext,
} from "@/lib/search/navigation-registry";
import {
  capResults,
  NAV_RESULT_CAP,
  type SearchResult,
} from "@/lib/search/global-search";

// Global Search V2-A — the navigation/settings registry.
//
// Four things are proved here, in order of how badly they would hurt:
//   1. PERMISSIONS. An owner-only surface is never advertised to a
//      practitioner, and a flag-gated surface is never advertised while the
//      flag is off. Search must not become a map of what you cannot have.
//   2. HREF INTEGRITY. Every registered destination resolves to a real route
//      in the app router, every fragment resolves to a real anchor id, and
//      every Records section parameter is a real section. A search result
//      that 404s is worse than no result.
//   3. MATCHING. The vocabulary Chloe actually types resolves to the right
//      page, case and whitespace are irrelevant, and the output is capped and
//      deterministic.
//   4. COVERAGE. A newly-added authenticated page cannot silently become
//      undiscoverable — it has to be registered or explicitly excluded.

const ROOT = path.resolve(__dirname, "../../..");
const OWNER: NavSearchContext = { isOwner: true, googleCalendarEnabled: false };
const PRACTITIONER: NavSearchContext = {
  isOwner: false,
  googleCalendarEnabled: false,
};

function titles(query: string, ctx: NavSearchContext): string[] {
  return matchNavEntries(query, ctx).map((m) => m.entry.title);
}

function hrefs(query: string, ctx: NavSearchContext): string[] {
  return matchNavEntries(query, ctx).map((m) => m.entry.href);
}

function top(query: string, ctx: NavSearchContext): string | undefined {
  return titles(query, ctx)[0];
}

/** The same projection the server action applies before capping. */
function asPageResult(entry: NavEntry): SearchResult {
  return {
    id: `page:${entry.id}`,
    type: "page",
    title: entry.title,
    subtitle: entry.description,
    href: entry.href,
  };
}

// ---------------------------------------------------------------------------
// Route table, read from the filesystem router
// ---------------------------------------------------------------------------

/** Walk app/ and collect every static page route, stripping (route groups). */
function collectRoutes(): {
  routes: Set<string>;
  files: Map<string, string>;
  authenticated: string[];
} {
  const routes = new Set<string>();
  const files = new Map<string, string>();
  const authenticated: string[] = [];

  function walk(dir: string, segments: string[]) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (!statSync(full).isDirectory()) continue;
      // (group) segments do not appear in the URL; _private and @slots are
      // not routable page directories.
      const isGroup = name.startsWith("(") && name.endsWith(")");
      if (name.startsWith("_") || name.startsWith("@")) continue;
      const next = isGroup ? segments : [...segments, name];
      const page = path.join(full, "page.tsx");
      try {
        if (statSync(page).isFile()) {
          const route = `/${next.join("/")}` || "/";
          routes.add(route);
          files.set(route, page);
          // The tripwire domain: the authenticated app shell plus platform
          // admin. Public marketing, token-bearing client surfaces and the
          // auth gates are out of scope for practitioner navigation search.
          const rel = path.relative(ROOT, full);
          const inApp = rel.startsWith("app/(app)/");
          const inAdmin = rel.startsWith("app/admin");
          // A dynamic route is per-record, never a static destination, so it
          // cannot carry a registry href at all.
          const dynamic = next.some((s) => s.includes("["));
          if ((inApp || inAdmin) && !dynamic) authenticated.push(route);
        }
      } catch {
        /* no page.tsx in this directory */
      }
      walk(full, next);
    }
  }

  walk(path.join(ROOT, "app"), []);
  return { routes, files, authenticated };
}

const { routes: ROUTE_TABLE, files: ROUTE_FILES, authenticated: AUTH_ROUTES } =
  collectRoutes();

function routeOf(href: string): string {
  return href.split("#")[0].split("?")[0];
}

// ---------------------------------------------------------------------------
// 1. Permissions
// ---------------------------------------------------------------------------

describe("permissions — search advertises only what the caller can already open", () => {
  const OWNER_ONLY = NAV_ENTRIES.filter((e) => e.visibility === "owner");

  it("there are owner-only entries to protect (the test is not vacuous)", () => {
    expect(OWNER_ONLY.length).toBeGreaterThanOrEqual(10);
  });

  it("no owner-only entry is reachable by a practitioner, for ANY query", () => {
    // Exhaustive, not sampled: every single-word token that appears anywhere
    // in an owner-only entry is fired at the practitioner context. If any
    // owner surface can be pulled out by any word it is described by, this
    // fails.
    const probes = new Set<string>();
    for (const e of OWNER_ONLY) {
      probes.add(normalizeNavText(e.title));
      for (const k of e.keywords) {
        probes.add(normalizeNavText(k));
        for (const word of normalizeNavText(k).split(" ")) {
          if (word.length >= 2) probes.add(word);
        }
      }
    }
    expect(probes.size).toBeGreaterThan(100);

    const ownerIds = new Set(OWNER_ONLY.map((e) => e.id));
    for (const probe of probes) {
      const leaked = matchNavEntries(probe, PRACTITIONER).filter((m) =>
        ownerIds.has(m.entry.id),
      );
      expect(leaked, `query "${probe}" leaked an owner-only entry`).toEqual([]);
    }
  });

  it("the required owner-only examples are hidden from a practitioner and visible to an owner", () => {
    const cases: Array<[string, string]> = [
      ["payments", "Payments"],
      ["reminder", "Appointment reminders"],
      ["sms", "Appointment reminders"],
      ["consent", "Consent forms"],
      ["photo consent", "Consent forms"],
      ["availability", "Availability"],
      ["hours", "Availability"],
      ["buffer", "Time between appointments"],
      ["booking link", "Booking link"],
      ["services", "Services"],
      ["team", "Team"],
      ["data export", "Data"],
    ];
    for (const [query, expected] of cases) {
      expect(titles(query, OWNER), `owner should find "${query}"`).toContain(
        expected,
      );
      expect(
        titles(query, PRACTITIONER),
        `practitioner must not be shown "${expected}" for "${query}"`,
      ).not.toContain(expected);
    }
  });

  it("practitioner-safe results stay visible to a practitioner", () => {
    const cases: Array<[string, string]> = [
      ["dashboard", "Dashboard"],
      ["clients", "Clients"],
      ["calendar", "Calendar"],
      ["records", "Record Keeping"],
      ["settings", "Settings"],
      ["getting started", "Getting Started"],
      ["profile", "Profile"],
      ["intake", "Forms & Postcare"],
      ["launch", "Launch"],
      ["notifications", "Notifications"],
      ["sterile", "Sterile Items"],
      ["disinfectant", "Disinfectants"],
      ["privacy", "Privacy Policy"],
    ];
    for (const [query, expected] of cases) {
      expect(
        titles(query, PRACTITIONER),
        `practitioner should find "${query}"`,
      ).toContain(expected);
    }
  });

  it("an owner sees everything a practitioner sees (search never narrows)", () => {
    for (const probe of ["dashboard", "clients", "profile", "intake", "privacy"]) {
      const practitionerIds = matchNavEntries(probe, PRACTITIONER).map(
        (m) => m.entry.id,
      );
      const ownerIds = new Set(
        matchNavEntries(probe, OWNER).map((m) => m.entry.id),
      );
      for (const id of practitionerIds) {
        // Deduping can retitle a shared href for an owner, so compare on the
        // href rather than the id where the id was displaced.
        const ownerHrefs = new Set(hrefs(probe, OWNER));
        const entry = NAV_ENTRIES.find((e) => e.id === id)!;
        expect(ownerIds.has(id) || ownerHrefs.has(entry.href)).toBe(true);
      }
    }
  });

  it("a flag-gated entry stays hidden while the studio flag is off", () => {
    const flagged = NAV_ENTRIES.filter((e) => e.requiresFlag !== undefined);
    expect(flagged.length).toBeGreaterThan(0);
    for (const entry of flagged) {
      const off = { isOwner: false, googleCalendarEnabled: false };
      const on = { isOwner: false, googleCalendarEnabled: true };
      expect(
        matchNavEntries(entry.title, off).map((m) => m.entry.id),
      ).not.toContain(entry.id);
      expect(
        matchNavEntries(entry.title, on).map((m) => m.entry.id),
      ).toContain(entry.id);
    }
  });

  it("a practitioner with Google Calendar off gets no Google result at all", () => {
    expect(titles("google", PRACTITIONER)).toEqual([]);
    expect(titles("calendar sync", PRACTITIONER)).toEqual([]);
  });

  it("google resolves for the audiences that actually have the surface", () => {
    // Owner: the studio-level Integrations page, whichever way the flag sits.
    expect(top("google", OWNER)).toBe("Google Calendar");
    expect(hrefs("google", OWNER)).toContain("/settings/integrations");
    expect(top("calendar sync", OWNER)).toBe("Google Calendar");
    // Practitioner with the flag on: their OWN connection card, on Profile.
    const withFlag = { isOwner: false, googleCalendarEnabled: true };
    expect(hrefs("google", withFlag)).toEqual(["/settings/profile"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Href integrity
// ---------------------------------------------------------------------------

describe("href integrity — every registered destination is real", () => {
  it("the route table was actually built (the test is not vacuous)", () => {
    expect(ROUTE_TABLE.size).toBeGreaterThan(30);
    expect(ROUTE_TABLE.has("/dashboard")).toBe(true);
    expect(ROUTE_TABLE.has("/settings/availability")).toBe(true);
  });

  it("every registered href resolves to a page in the app router", () => {
    for (const entry of NAV_ENTRIES) {
      const route = routeOf(entry.href);
      expect(
        ROUTE_TABLE.has(route),
        `${entry.id}: ${entry.href} has no page.tsx (route ${route})`,
      ).toBe(true);
    }
  });

  it("every href is an app-internal literal path with no identifier in it", () => {
    for (const entry of NAV_ENTRIES) {
      expect(entry.href.startsWith("/"), entry.id).toBe(true);
      expect(entry.href).not.toMatch(/https?:/);
      // A dynamic segment would mean the registry is carrying a record id.
      expect(entry.href).not.toMatch(/[[\]]/);
      expect(entry.href).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
    }
  });

  it("every fragment resolves to a real anchor id on its own page", () => {
    const withFragment = NAV_ENTRIES.filter((e) => e.href.includes("#"));
    expect(withFragment.length).toBeGreaterThan(0);

    for (const entry of withFragment) {
      const fragment = entry.href.split("#")[1];
      const page = ROUTE_FILES.get(routeOf(entry.href))!;
      const sources = [page, ...relativeImportsOf(page)].map((f) =>
        readFileSync(f, "utf8"),
      );
      const found = sources.some((src) =>
        src.includes(`id="${fragment}"`),
      );
      expect(
        found,
        `${entry.id}: no id="${fragment}" in ${path.relative(ROOT, page)} or its direct imports`,
      ).toBe(true);
    }
  });

  it("every Records section parameter is a section the Records page renders", () => {
    const src = readFileSync(ROUTE_FILES.get("/records")!, "utf8");
    const declared = new Set(
      [...src.matchAll(/\{ key: "(\w+)", label:/g)].map((m) => m[1]),
    );
    expect(declared.size).toBeGreaterThanOrEqual(4);

    for (const entry of NAV_ENTRIES) {
      const [route, query] = entry.href.split("#")[0].split("?");
      if (route !== "/records" || !query) continue;
      const section = new URLSearchParams(query).get("section");
      expect(section, entry.id).toBeTruthy();
      expect(declared.has(section!), `${entry.id}: unknown section`).toBe(true);
    }
  });

  it("ids and titles are unique, and priorities are distinct", () => {
    expect(new Set(NAV_ENTRIES.map((e) => e.id)).size).toBe(NAV_ENTRIES.length);
    expect(new Set(NAV_ENTRIES.map((e) => e.title)).size).toBe(
      NAV_ENTRIES.length,
    );
    expect(new Set(NAV_ENTRIES.map((e) => e.priority)).size).toBe(
      NAV_ENTRIES.length,
    );
  });

  it("the data that reaches a practitioner carries no token or secret", () => {
    // Checked against the serialized ENTRIES, not the file: this is exactly
    // the payload that becomes search results. (The file's own prose talks
    // about tokens precisely to say it must not carry any.)
    const payload = JSON.stringify(NAV_ENTRIES).toLowerCase();
    for (const banned of [
      "token",
      "secret",
      "password",
      "credential",
      "api key",
      "service_role",
      "supabase",
      "webhook",
      "hash",
    ]) {
      expect(payload.includes(banned), `entries must not mention ${banned}`).toBe(
        false,
      );
    }
  });

  it("the module contains no provider identifier or key literal", () => {
    const src = readFileSync(
      path.join(ROOT, "lib/search/navigation-registry.ts"),
      "utf8",
    );
    for (const banned of [
      "service_role",
      "stripe_",
      "sk_live",
      "sk_test",
      "pk_live",
      "pk_test",
      "acct_",
      "cus_",
      "whsec_",
      "api_key",
      "apikey",
      "process.env",
    ]) {
      expect(
        src.toLowerCase().includes(banned),
        `registry must not contain ${banned}`,
      ).toBe(false);
    }
  });

  it("is unreachable from the client component's import graph", () => {
    // `import "server-only"` is the enforcement; this is the tripwire that
    // says WHY it holds. If the header component (or the client-safe module
    // it shares with the action) ever imports the registry, every
    // practitioner's browser bundle would carry the titles and descriptions
    // of owner-only surfaces — filtered out of the results, but readable in
    // the JavaScript. Verified empirically against a production build: the
    // registry's strings appear in .next/server and never in .next/static.
    // Matched on the IMPORT, not on any mention: both files legitimately
    // name the registry in prose explaining why they must not pull it in.
    const importsRegistry = /(?:from|import|require\()\s*"[^"]*navigation-registry"/;
    for (const rel of [
      "app/(app)/GlobalSearch.tsx",
      "lib/search/global-search.ts",
    ]) {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      expect(src, `${rel} must not import the registry`).not.toMatch(
        importsRegistry,
      );
    }
    // ...and the action, which is where it IS allowed to be read, is a
    // server action.
    const action = readFileSync(
      path.join(ROOT, "app/(app)/global-search-actions.ts"),
      "utf8",
    );
    expect(action).toMatch(/^"use server";/m);
    expect(action).toContain("@/lib/search/navigation-registry");
  });

  it("does not read a database or import a Supabase client", () => {
    const src = readFileSync(
      path.join(ROOT, "lib/search/navigation-registry.ts"),
      "utf8",
    );
    expect(src).toMatch(/^import "server-only";/m);
    expect(src).not.toMatch(/createClient|createAdminClient|from\("/);
    // Exactly one import, and it is the server-only marker.
    expect(src.match(/^import /gm)).toHaveLength(1);
  });
});

/** Resolve the relative `.tsx` imports one level out from a page file. */
function relativeImportsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/from "(\.[^"]+)"/g)) {
    const resolved = path.resolve(path.dirname(file), m[1]);
    for (const candidate of [`${resolved}.tsx`, `${resolved}.ts`]) {
      try {
        if (statSync(candidate).isFile()) out.push(candidate);
      } catch {
        /* not a file */
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Matching
// ---------------------------------------------------------------------------

describe("matching — the words Chloe actually types", () => {
  it("resolves the product brief's worked examples", () => {
    const cases: Array<[string, string]> = [
      ["reminder", "Appointment reminders"],
      ["availability", "Availability"],
      ["hours", "Availability"],
      ["buffer", "Time between appointments"],
      ["booking link", "Booking link"],
      ["consent", "Consent forms"],
      ["photo consent", "Consent forms"],
      ["google", "Google Calendar"],
      ["calendar sync", "Google Calendar"],
      ["sms", "Appointment reminders"],
      ["payments", "Payments"],
      ["services", "Services"],
      ["team", "Team"],
      ["data export", "Data"],
      ["privacy", "Privacy Policy"],
      ["records", "Record Keeping"],
    ];
    for (const [query, expected] of cases) {
      expect(top(query, OWNER), `"${query}" should rank ${expected} first`).toBe(
        expected,
      );
    }
  });

  it("finds a page by terminology absent from its title", () => {
    // The whole point of aliases: none of these words appear in the title of
    // the page they must resolve to.
    for (const [query, expected] of [
      ["hours", "Availability"],
      ["lunch", "Availability"],
      ["vacation", "Availability"],
      ["day off", "Availability"],
      ["buffer", "Time between appointments"],
      ["csv", "Quick import"],
      ["pixel", "Marketing & analytics"],
      ["waiver", "Consent forms"],
      ["backup", "Data"],
      ["staff", "Team"],
      ["autoclave", "Sterile Items"],
      ["onboarding", "Getting Started"],
    ] as Array<[string, string]>) {
      expect(titles(query, OWNER), `"${query}"`).toContain(expected);
    }
  });

  it("is insensitive to case, surrounding whitespace, and punctuation", () => {
    const canonical = titles("no show", OWNER);
    expect(canonical.length).toBeGreaterThan(0);
    for (const variant of [
      "NO SHOW",
      "  no show  ",
      "No-Show",
      "no_show",
      "No   Show",
      "no show!",
    ]) {
      expect(titles(variant, OWNER), variant).toEqual(canonical);
    }
  });

  it("ranks an exact title above a page that merely mentions it", () => {
    expect(top("booking", OWNER)).toBe("Booking");
    expect(top("booking link", OWNER)).toBe("Booking link");
    expect(top("calendar", OWNER)).toBe("Calendar");
    expect(top("calendar feed", OWNER)).toBe("Calendar feed");
  });

  it("collapses several concepts that share one page into one result", () => {
    // Booking, Booking link and Time between appointments all live on
    // /settings/booking. A single query must never show the same destination
    // three times.
    for (const query of ["booking", "booking link", "buffer", "settings"]) {
      const list = hrefs(query, OWNER);
      expect(new Set(list).size, `"${query}" repeated a destination`).toBe(
        list.length,
      );
    }
  });

  it("returns nothing for noise rather than guessing", () => {
    for (const query of ["zzzz", "qqq", "asdfgh", "xylophone"]) {
      expect(titles(query, OWNER), query).toEqual([]);
    }
  });

  it("an empty query reproduces the V1 six-shortcut state exactly", () => {
    expect(titles("", PRACTITIONER)).toEqual([
      "Dashboard",
      "Clients",
      "Calendar",
      "Record Keeping",
      "Settings",
      "Getting Started",
    ]);
    expect(titles("", OWNER)).toEqual(titles("", PRACTITIONER));
    expect(titles("   ", OWNER)).toEqual(titles("", OWNER));
  });

  it("the nav cap can never trim the pre-typing shortcut state", () => {
    // groupResults applies NAV_RESULT_CAP on the way to the screen, so a cap
    // below the number of default shortcuts would render fewer rows than the
    // action returned — a silent regression of the V1 empty state that no
    // registry-level test would see.
    const shortcuts = NAV_ENTRIES.filter((e) => e.defaultShortcut === true);
    expect(shortcuts).toHaveLength(6);
    expect(NAV_RESULT_CAP).toBeGreaterThanOrEqual(shortcuts.length);
    expect(capResults(shortcuts.map(asPageResult))).toHaveLength(
      shortcuts.length,
    );
  });

  it("is deterministic — same query, same context, same order", () => {
    for (const query of ["settings", "calendar", "booking", "record", ""]) {
      const first = matchNavEntries(query, OWNER).map((m) => m.entry.id);
      for (let i = 0; i < 3; i += 1) {
        expect(matchNavEntries(query, OWNER).map((m) => m.entry.id)).toEqual(
          first,
        );
      }
    }
  });

  it("never returns an unbounded list", () => {
    // "settings" matches most of the registry through its category. The
    // matcher is allowed to return them all — the caller caps — but the
    // registry itself must stay small enough that this is a bounded scan.
    expect(NAV_ENTRIES.length).toBeLessThan(80);
    expect(matchNavEntries("settings", OWNER).length).toBeLessThanOrEqual(
      NAV_ENTRIES.length,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Coverage tripwire
// ---------------------------------------------------------------------------

describe("coverage tripwire — a new destination needs an explicit decision", () => {
  it("collected the authenticated route set (the tripwire is not vacuous)", () => {
    expect(AUTH_ROUTES.length).toBeGreaterThanOrEqual(20);
    expect(AUTH_ROUTES).toContain("/settings/availability");
    expect(AUTH_ROUTES).toContain("/admin");
  });

  it("every authenticated static route is either registered or explicitly excluded", () => {
    const registered = new Set(NAV_ENTRIES.map((e) => routeOf(e.href)));
    const excluded = new Set(NON_SEARCHABLE_ROUTES.map((r) => r.route));

    const undecided = AUTH_ROUTES.filter(
      (r) => !registered.has(r) && !excluded.has(r),
    ).sort();

    expect(
      undecided,
      [
        "These authenticated routes have no searchability decision.",
        "Add each to NAV_ENTRIES in lib/search/navigation-registry.ts,",
        "or to NON_SEARCHABLE_ROUTES with the reason it is withheld.",
        "Global Search must not silently gain or lose a destination.",
      ].join(" "),
    ).toEqual([]);
  });

  it("every exclusion names a route that still exists, with a reason", () => {
    for (const { route, reason } of NON_SEARCHABLE_ROUTES) {
      expect(ROUTE_TABLE.has(route), `${route} no longer exists`).toBe(true);
      expect(reason.length, route).toBeGreaterThan(30);
    }
  });

  it("no route is both registered and excluded", () => {
    const registered = new Set(NAV_ENTRIES.map((e) => routeOf(e.href)));
    for (const { route } of NON_SEARCHABLE_ROUTES) {
      expect(registered.has(route), `${route} is registered AND excluded`).toBe(
        false,
      );
    }
  });

  it("withheld Records sections are named, exist, and stay unsearchable", () => {
    const src = readFileSync(ROUTE_FILES.get("/records")!, "utf8");
    for (const { section, reason } of NON_SEARCHABLE_RECORD_SECTIONS) {
      expect(src).toContain(`key: "${section}"`);
      expect(reason.length).toBeGreaterThan(30);
      for (const ctx of [OWNER, PRACTITIONER]) {
        expect(
          hrefs(section, ctx).some((h) => h.includes(`section=${section}`)),
        ).toBe(false);
      }
    }
  });

  it("exposure incidents are unreachable through search for anyone", () => {
    for (const query of [
      "exposure",
      "incident",
      "incidents",
      "exposure incident",
      "blood",
      "body fluid",
      "needlestick",
    ]) {
      for (const ctx of [OWNER, PRACTITIONER]) {
        const found = matchNavEntries(query, ctx);
        expect(
          found.map((m) => m.entry.href),
          `"${query}" reached the exposure log`,
        ).not.toContain("/records?section=incidents");
        expect(JSON.stringify(found).toLowerCase()).not.toContain("exposure");
      }
    }
  });

  it("registry visibility never contradicts the Settings nav's own gating", () => {
    // The settings layout is the product's declaration of who may SEE each
    // tab. Search must not be a second, drifting opinion: if a tab moves
    // behind the owner gate, the registry entry has to move with it or this
    // fails. Search is allowed to be STRICTER (a sub-surface of a shared page
    // can be owner-only while the page is not) — never looser.
    const layout = readFileSync(
      path.join(ROOT, "app/(app)/settings/layout.tsx"),
      "utf8",
    );
    // Anchor on the SPREAD, not the first mention of `isOwner` — the boolean
    // is declared well above the item list, and slicing there would leave the
    // "open" region empty and quietly assert nothing.
    const gateStart = layout.indexOf("...(isOwner");
    const gateEnd = layout.indexOf(": []", gateStart);
    expect(gateStart).toBeGreaterThan(-1);
    expect(gateEnd).toBeGreaterThan(gateStart);

    const hrefsIn = (text: string) =>
      new Set([...text.matchAll(/href: "(\/settings\/[a-z-]+)"/g)].map((m) => m[1]));
    const ownerGated = hrefsIn(layout.slice(gateStart, gateEnd));
    const open = hrefsIn(layout.slice(0, gateStart));

    expect(ownerGated.size).toBeGreaterThanOrEqual(10);
    expect(open.size).toBeGreaterThanOrEqual(3);
    // A tab cannot be in both regions, or the parse is wrong.
    for (const href of ownerGated) expect(open.has(href)).toBe(false);

    for (const entry of NAV_ENTRIES) {
      const route = routeOf(entry.href);
      if (!ownerGated.has(route)) continue;
      expect(
        entry.visibility,
        `${entry.id} points at ${route}, which the Settings nav shows only to owners`,
      ).toBe("owner");
    }
  });

  it("no admin route is advertised, for any query and either role", () => {
    const adminRoutes = AUTH_ROUTES.filter((r) => r.startsWith("/admin"));
    expect(adminRoutes.length).toBeGreaterThan(0);
    for (const query of ["admin", "audit", "ops", "manual review", "studios"]) {
      for (const ctx of [OWNER, PRACTITIONER]) {
        for (const href of hrefs(query, ctx)) {
          expect(href.startsWith("/admin"), `"${query}" -> ${href}`).toBe(false);
        }
      }
    }
  });
});
