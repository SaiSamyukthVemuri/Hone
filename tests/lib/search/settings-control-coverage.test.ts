import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  matchNavEntries,
  NAV_ENTRIES,
  type NavSearchContext,
} from "@/lib/search/navigation-registry";
import {
  SETTINGS_CONTROLS,
  STRUCTURAL_LABEL_SOURCES,
  type SettingsControl,
} from "./fixtures/settings-controls.census";

// Global Search V2-A.1 — SETTINGS CONTROL coverage.
//
// THE BUG THIS EXISTS TO PREVENT
// V2-A's tripwire proved every authenticated ROUTE carried a searchability
// decision, and it passed. Search was still incomplete: Sam typed the exact
// visible label "Booking horizon" in production and got nothing, because the
// Booking page was registered while six of its eight controls were not.
//
//   ROUTE COVERAGE  — "can I find this page?"     (navigation-registry.test.ts)
//   CONTROL COVERAGE — "can I find the exact setting I am looking at?"  (here)
//
// Both are required. Route coverage cannot detect a missing control, because
// the route it checks is already present and already decided.

const ROOT = path.resolve(__dirname, "../../..");
const OWNER: NavSearchContext = { isOwner: true, googleCalendarEnabled: true };
const PRACTITIONER: NavSearchContext = {
  isOwner: false,
  googleCalendarEnabled: true,
};

const ENTRY_BY_ID = new Map(NAV_ENTRIES.map((e) => [e.id, e]));

function ctxFor(control: SettingsControl): NavSearchContext {
  return control.role === "owner" ? OWNER : PRACTITIONER;
}

function routeOf(href: string): string {
  return href.split("#")[0].split("?")[0];
}

const searchable = SETTINGS_CONTROLS.filter((c) => c.decision === "searchable");
const excluded = SETTINGS_CONTROLS.filter((c) => c.decision === "excluded");

// ---------------------------------------------------------------------------
// Source text per settings page: page.tsx plus its directly-imported
// components, which is where the labels actually live.
// ---------------------------------------------------------------------------

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

/**
 * Collect a page and its relative imports TRANSITIVELY (bounded depth, cycle
 * safe). One level is not enough: /settings/tracking renders its field labels
 * in TrackingProviderForm, which page.tsx reaches only through
 * TrackingProviderSelector. A depth-1 walk silently missed them, which is
 * exactly the kind of quiet gap this file exists to prevent.
 */
function componentTree(entry: string, maxDepth = 3): string[] {
  const seen = new Set<string>([entry]);
  let frontier = [entry];
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const imported of relativeImportsOf(file)) {
        if (seen.has(imported)) continue;
        seen.add(imported);
        next.push(imported);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return [...seen];
}

function pageFileFor(route: string): string {
  const rel = route.replace(/^\//, "");
  const candidate = path.join(ROOT, "app", "(app)", rel, "page.tsx");
  statSync(candidate); // throws if the route stopped existing
  return candidate;
}

const sourceCache = new Map<string, string>();
function sourceTextFor(route: string): string {
  const cached = sourceCache.get(route);
  if (cached !== undefined) return cached;
  const page = pageFileFor(route);
  const text = componentTree(page)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  sourceCache.set(route, text);
  return text;
}

const renderCache = new Map<string, string>();
/**
 * Only the RENDERING files for a route: `.tsx` components, never `.ts` action
 * or helper modules.
 *
 * This distinction is load-bearing, and a negative control is what proved it.
 * Renaming the rendered "Booking horizon" label did NOT fail the staleness
 * check at first, because `booking/actions.ts` contains the same words inside
 * a validation error message ("Booking horizon must be one of: ..."). A check
 * that greps whole files therefore reports a control as present after the
 * control is gone — the exact false-negative this whole test file exists to
 * eliminate.
 */
function renderSourceFor(route: string): string {
  const cached = renderCache.get(route);
  if (cached !== undefined) return cached;
  const text = collapse(
    componentTree(pageFileFor(route))
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n"),
  );
  renderCache.set(route, text);
  return text;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Is `label` present in a position that actually RENDERS? Three idioms, all
 * verified in this codebase:
 *   1. JSX text            >Booking horizon<
 *   2. string prop         title="Export your data" / label="Price"
 *   3. object literal      { label: "Send 24-hour reminders" }
 * A template literal inside a server action matches none of them.
 */
function rendersLabel(route: string, label: string): boolean {
  const src = renderSourceFor(route);
  const l = escapeRegExp(collapse(label));
  return [
    new RegExp(`>\\s*${l}\\s*<`),
    new RegExp(`(?:label|title)="${l}"`),
    new RegExp(`(?:label|title):\\s*"${l}"`),
  ].some((re) => re.test(src));
}

/**
 * JSX collapses whitespace, so a label written across several source lines
 * ("Public address (shown on your booking page)") renders as one string but is
 * stored with newlines and indentation. Compare on collapsed whitespace.
 */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 1. The census is honest — every label it claims still exists
// ---------------------------------------------------------------------------

describe("census integrity — every audited control is still real", () => {
  it("audits a meaningful number of controls across every settings page", () => {
    expect(SETTINGS_CONTROLS.length).toBeGreaterThanOrEqual(50);
    expect(searchable.length).toBeGreaterThanOrEqual(35);
    expect(excluded.length).toBeGreaterThanOrEqual(5);
    // Every settings route that has controls is represented.
    const pages = new Set(SETTINGS_CONTROLS.map((c) => c.page));
    for (const required of [
      "/settings/profile",
      "/settings/studio",
      "/settings/booking",
      "/settings/availability",
      "/settings/services",
      "/settings/team",
      "/settings/consent",
      "/settings/intake",
      "/settings/payments",
      "/settings/integrations",
      "/settings/tracking",
      "/settings/import",
      "/settings/data",
      "/settings/launch",
    ]) {
      expect(pages.has(required), `${required} has no audited control`).toBe(
        true,
      );
    }
  });

  it("every audited label still appears in its page's source", () => {
    // THE STALENESS TRIPWIRE. Rename or delete a control and this fails here,
    // loudly, instead of the control silently becoming unfindable.
    for (const control of SETTINGS_CONTROLS) {
      expect(
        rendersLabel(control.page, control.label),
        `${control.page}: the audited label "${control.label}" is no longer RENDERED by the page's components — rename it in the census or remove the row`,
      ).toBe(true);
    }
  });

  it("no duplicate page+label rows", () => {
    const keys = SETTINGS_CONTROLS.map((c) => `${c.page}::${c.label}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every excluded control gives a substantive reason and no entry", () => {
    for (const control of excluded) {
      expect(control.reason ?? "", control.label).toBeTruthy();
      expect((control.reason ?? "").length, control.label).toBeGreaterThan(40);
      expect(control.entryId, control.label).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Every searchable control actually resolves
// ---------------------------------------------------------------------------

describe("control coverage — the exact visible label finds the setting", () => {
  it("every searchable control names a registry entry that exists", () => {
    for (const control of searchable) {
      expect(control.entryId, control.label).toBeTruthy();
      expect(
        ENTRY_BY_ID.has(control.entryId!),
        `${control.label}: no registry entry "${control.entryId}"`,
      ).toBe(true);
    }
  });

  it("searching the EXACT visible label returns that control's entry", () => {
    // This is the assertion that would have caught the production failure:
    // searching "Booking horizon" had to return the Booking horizon entry.
    for (const control of searchable) {
      const matches = matchNavEntries(control.label, ctxFor(control));
      const ids = matches.map((m) => m.entry.id);
      expect(
        ids,
        `searching the visible label "${control.label}" (${control.page}) returned ${
          ids.length === 0 ? "NOTHING" : ids.join(", ")
        }`,
      ).toContain(control.entryId);
    }
  });

  it("every searchable control's entry points at the page it lives on", () => {
    for (const control of searchable) {
      const entry = ENTRY_BY_ID.get(control.entryId!)!;
      expect(
        routeOf(entry.href),
        `${control.label}: entry ${entry.id} points at ${entry.href}, not ${control.page}`,
      ).toBe(control.page);
    }
  });

  it("entry visibility is never looser than the control's own role", () => {
    for (const control of searchable) {
      const entry = ENTRY_BY_ID.get(control.entryId!)!;
      if (control.role === "owner") {
        expect(
          entry.visibility,
          `${control.label} is owner-only on the page but its entry is ${entry.visibility}`,
        ).toBe("owner");
      }
    }
  });

  it("a flag-gated control carries the flag through to its entry", () => {
    for (const control of searchable.filter((c) => c.flag)) {
      const entry = ENTRY_BY_ID.get(control.entryId!)!;
      expect(entry.requiresFlag, control.label).toBe(control.flag);
    }
  });

  it("owner-only controls are unreachable from a practitioner context", () => {
    for (const control of searchable.filter((c) => c.role === "owner")) {
      const ids = matchNavEntries(control.label, PRACTITIONER).map(
        (m) => m.entry.id,
      );
      expect(
        ids,
        `the owner-only control "${control.label}" leaked to a practitioner`,
      ).not.toContain(control.entryId);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Distinct controls on one page stay distinct
// ---------------------------------------------------------------------------

describe("anchors keep sibling controls distinct", () => {
  it("every control-level entry on a shared page has its own anchor", () => {
    // Group searchable controls by page and count how many DIFFERENT registry
    // entries serve them. Where a page has more than one entry, those entries
    // must have distinct hrefs — otherwise href dedupe silently collapses them
    // and only one control on the page is ever findable.
    const byPage = new Map<string, Set<string>>();
    for (const control of searchable) {
      const set = byPage.get(control.page) ?? new Set<string>();
      set.add(control.entryId!);
      byPage.set(control.page, set);
    }

    let pagesWithMultipleEntries = 0;
    for (const [page, entryIds] of byPage) {
      if (entryIds.size < 2) continue;
      pagesWithMultipleEntries += 1;
      const hrefs = [...entryIds].map((id) => ENTRY_BY_ID.get(id)!.href);
      expect(
        new Set(hrefs).size,
        `${page} has ${entryIds.size} searchable entries but only ${new Set(hrefs).size} distinct hrefs — dedupe will hide some`,
      ).toBe(hrefs.length);
    }
    // Not vacuous: several settings pages genuinely carry multiple controls.
    expect(pagesWithMultipleEntries).toBeGreaterThanOrEqual(5);
  });

  it("all eight Booking controls resolve to eight distinct destinations", () => {
    const booking = searchable.filter((c) => c.page === "/settings/booking");
    expect(booking).toHaveLength(8);
    const hrefs = booking.map((c) => ENTRY_BY_ID.get(c.entryId!)!.href);
    expect(new Set(hrefs).size).toBe(8);
    for (const href of hrefs) expect(href).toMatch(/^\/settings\/booking#/);
  });
});

// ---------------------------------------------------------------------------
// 4. Nothing new slips past the census
// ---------------------------------------------------------------------------

/**
 * Extract visible control labels from a file using the two idioms this
 * codebase actually uses for a settings field label. Deliberately narrow: a
 * declared file list with a verified minimum, not a general JSX parser.
 */
function extractLabels(src: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /<span className="text-sm font-medium">([\s\S]*?)<\/span>/g,
    /<label[^>]*className="[^"]*text-sm font-medium[^"]*"[^>]*>([\s\S]*?)<\/label>/g,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      // Drop nested markup (the red required asterisk) and interpolation.
      const text = collapse(
        m[1]
          .replace(/<[^>]*>[\s\S]*?<\/[^>]*>|<[^>]*>/g, "")
          // Required-field marker: <span ...>*</span> renders beside the label
          // but is not part of it. The practitioner reads "Your name".
          .replace(/\*\s*$/, ""),
      );
      if (text && !text.includes("{") && text.length <= 80) out.add(text);
    }
  }
  return [...out];
}

describe("structural sweep — a new control cannot slip in unaudited", () => {
  it("the sweep still finds the labels it is supposed to find", () => {
    // Guards the EXTRACTOR itself. If an idiom changes and extraction silently
    // returns nothing, this fails instead of the sweep passing vacuously.
    for (const { file, minLabels } of STRUCTURAL_LABEL_SOURCES) {
      const labels = extractLabels(readFileSync(path.join(ROOT, file), "utf8"));
      expect(
        labels.length,
        `${file}: extracted ${labels.length} labels, expected at least ${minLabels} — the label idiom changed and the sweep needs updating`,
      ).toBeGreaterThanOrEqual(minLabels);
    }
  });

  it("every swept label has an explicit census decision", () => {
    const censusLabels = new Set(
      SETTINGS_CONTROLS.map((c) => `${c.page}::${collapse(c.label)}`),
    );
    const undecided: string[] = [];

    for (const { file, page } of STRUCTURAL_LABEL_SOURCES) {
      for (const label of extractLabels(
        readFileSync(path.join(ROOT, file), "utf8"),
      )) {
        if (!censusLabels.has(`${page}::${label}`)) {
          undecided.push(`${page} :: ${label}   (${file})`);
        }
      }
    }

    expect(
      undecided.sort(),
      [
        "These visible Settings controls have no searchability decision.",
        "Add a row to tests/lib/search/fixtures/settings-controls.census.ts —",
        'either decision: "searchable" with the registry entry that resolves its',
        'exact visible label, or decision: "excluded" with the reason it is withheld.',
        "Route coverage cannot catch this: the page is already registered.",
      ].join(" "),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. The reported production failure, pinned by name
// ---------------------------------------------------------------------------

describe("regression — the reported production failure", () => {
  const horizonQueries = [
    "booking horizon",
    "Booking horizon",
    "  BOOKING HORIZON  ",
    "horizon",
    "booking window",
    "advance booking",
    "how far ahead",
    "how far ahead can clients book",
    "how far in advance",
    "months ahead",
    "future booking",
    "booking months",
    "booking range",
    "how far out",
  ];

  it("every way Sam might phrase it resolves to Booking horizon", () => {
    for (const query of horizonQueries) {
      const ids = matchNavEntries(query, OWNER).map((m) => m.entry.id);
      expect(ids, `"${query}" did not find Booking horizon`).toContain(
        "settings-booking-horizon",
      );
    }
  });

  it("the exact visible label ranks it FIRST, not merely somewhere", () => {
    for (const query of ["booking horizon", "horizon", "how far ahead"]) {
      expect(matchNavEntries(query, OWNER)[0]?.entry.title, query).toBe(
        "Booking horizon",
      );
    }
  });

  it("it lands on the control, and that anchor exists in the page", () => {
    const entry = ENTRY_BY_ID.get("settings-booking-horizon")!;
    expect(entry.href).toBe("/settings/booking#booking-horizon");
    expect(sourceTextFor("/settings/booking")).toContain(
      'id="booking-horizon"',
    );
  });

  it("its description is the helper copy the practitioner already read", () => {
    expect(ENTRY_BY_ID.get("settings-booking-horizon")!.description).toBe(
      "Choose how far ahead clients can book online",
    );
  });

  it("is owner-only, matching the page's own gate", () => {
    expect(matchNavEntries("booking horizon", PRACTITIONER)).toEqual([]);
  });

  it("the generic Booking entry still works and does not swamp it", () => {
    // Both must remain useful: "booking" is the page, "booking horizon" is the
    // control. Neither may suppress the other.
    expect(matchNavEntries("booking", OWNER)[0]?.entry.title).toBe("Booking");
    expect(matchNavEntries("booking horizon", OWNER)[0]?.entry.title).toBe(
      "Booking horizon",
    );
  });
});

// A cheap directory guard so a whole new settings page cannot appear without
// anyone noticing this file exists.
describe("settings pages are all represented", () => {
  it("every settings route directory has at least one audited control or a documented reason", () => {
    const dir = path.join(ROOT, "app", "(app)", "settings");
    const routes = readdirSync(dir)
      .filter((name) => {
        try {
          return statSync(path.join(dir, name, "page.tsx")).isFile();
        } catch {
          return false;
        }
      })
      .map((name) => `/settings/${name}`);

    expect(routes.length).toBeGreaterThanOrEqual(14);
    const audited = new Set(SETTINGS_CONTROLS.map((c) => c.page));
    // /settings/calendar is a redirect alias with no controls of its own; it is
    // already recorded in NON_SEARCHABLE_ROUTES.
    const exempt = new Set(["/settings/calendar"]);
    const missing = routes.filter((r) => !audited.has(r) && !exempt.has(r));
    expect(
      missing.sort(),
      "These settings pages have no control census at all — add their controls to settings-controls.census.ts",
    ).toEqual([]);
  });
});
