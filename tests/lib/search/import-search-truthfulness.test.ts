import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  matchNavEntries,
  NAV_ENTRIES,
  NON_SEARCHABLE_ROUTES,
  type NavSearchContext,
} from "@/lib/search/navigation-registry";
import { SETTINGS_CONTROLS } from "./fixtures/settings-controls.census";

// IMPORT-01 — Global Search must not sell a capability the server refuses.
//
// Search V2-A.1 promises settings discoverability, and it delivered a "Quick
// import" row whose title read as "go here and import your clients". Execution
// is now operator-assisted, so that row had to change or go. It stays — an
// owner searching "import" needs to find the one page that explains how to get
// their records moved — but the promise it makes had to become true.
//
// This file exists next to, not instead of, the general coverage tests. Those
// still prove every route carries a decision and every visible control
// resolves; nothing here relaxes either.

const ROOT = path.resolve(__dirname, "../../..");
const OWNER: NavSearchContext = { isOwner: true, googleCalendarEnabled: false };
const PRACTITIONER: NavSearchContext = {
  isOwner: false,
  googleCalendarEnabled: false,
};

const IMPORT_ENTRY = NAV_ENTRIES.find((e) => e.id === "settings-import")!;
const DATA_IMPORT_ENTRY = NAV_ENTRIES.find(
  (e) => e.id === "settings-data-import-csv",
)!;

function titles(query: string, ctx: NavSearchContext): string[] {
  return matchNavEntries(query, ctx).map((m) => m.entry.title);
}

describe("the import destination is still discoverable", () => {
  it("is registered, not silently withheld", () => {
    expect(IMPORT_ENTRY).toBeTruthy();
    expect(IMPORT_ENTRY.href).toBe("/settings/import");
    expect(
      NON_SEARCHABLE_ROUTES.map((r) => r.route),
      "excluding the route would hide the only path to migration help",
    ).not.toContain("/settings/import");
  });

  it("every way an owner would ask for it still resolves", () => {
    for (const query of [
      "import",
      "quick import",
      "csv",
      "spreadsheet",
      "migrate",
      "migration",
      "transfer",
      "bring data",
      "upload clients",
      "move my clients",
      "migration help",
      "help importing",
      "operator assisted",
    ]) {
      expect(
        matchNavEntries(query, OWNER).map((m) => m.entry.id),
        `"${query}" no longer finds the import page`,
      ).toContain("settings-import");
    }
  });

  it("searching its exact visible title ranks it first", () => {
    expect(titles("Import clients and history", OWNER)[0]).toBe(
      IMPORT_ENTRY.title,
    );
  });

  it("stays owner-only — the mitigation did not widen who is told it exists", () => {
    expect(IMPORT_ENTRY.visibility).toBe("owner");
    for (const query of ["import", "csv", "quick import", "operator assisted"]) {
      expect(
        matchNavEntries(query, PRACTITIONER).map((m) => m.entry.id),
        `"${query}" leaked the import page to a practitioner`,
      ).not.toContain("settings-import");
    }
  });
});

describe("the result row does not promise self-service execution", () => {
  it("the title is a destination, not a run-it-now verb phrase", () => {
    expect(IMPORT_ENTRY.title).toBe("Import clients and history");
    // "Quick import" was the misleading half: it named a self-service action.
    expect(IMPORT_ENTRY.title).not.toMatch(/quick/i);
  });

  it("the description states the operator-assisted model, before the click", () => {
    expect(IMPORT_ENTRY.description).toMatch(/operator-assisted/i);
    expect(IMPORT_ENTRY.description.length).toBeLessThanOrEqual(80);
  });

  it("no import-related entry describes it as something you do yourself", () => {
    const importish = NAV_ENTRIES.filter(
      (e) =>
        /import/i.test(e.title) ||
        /import/i.test(e.description) ||
        e.keywords.some((k) => /import/i.test(k)),
    );
    // Not vacuous: there are two import surfaces in the registry.
    expect(importish.length).toBeGreaterThanOrEqual(2);
    for (const entry of importish) {
      expect(
        `${entry.title} ${entry.description}`,
        `${entry.id} advertises a self-service import`,
      ).not.toMatch(/self[- ]serve|self[- ]service|import (?:them )?yourself/i);
    }
  });

  it("the old misleading title is gone from the registry entirely", () => {
    expect(NAV_ENTRIES.map((e) => e.title)).not.toContain("Quick import");
  });
});

describe("the two import surfaces tell one story", () => {
  it("the Data page card no longer promises imminent self-service", () => {
    const src = readFileSync(
      path.join(ROOT, "app/(app)/settings/data/page.tsx"),
      "utf8",
    );
    const card = src.slice(
      src.indexOf('anchorId="import-csv"'),
      src.indexOf('anchorId="delete-data"'),
    );
    expect(card.length).toBeGreaterThan(100);
    expect(card).not.toMatch(/Coming this week/);
    expect(card).toMatch(/operator-assisted/i);
    expect(card).toMatch(/href="\/settings\/import"/);
  });

  it("both surfaces remain distinct destinations, so neither hides the other", () => {
    expect(DATA_IMPORT_ENTRY.href).not.toBe(IMPORT_ENTRY.href);
    const found = matchNavEntries("import clients", OWNER).map(
      (m) => m.entry.href,
    );
    expect(new Set(found).size).toBe(found.length);
  });
});

describe("the census records the change rather than dropping the page", () => {
  it("/settings/import still carries an audited, searchable control", () => {
    const rows = SETTINGS_CONTROLS.filter((c) => c.page === "/settings/import");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const searchable = rows.filter((c) => c.decision === "searchable");
    expect(searchable).toHaveLength(1);
    expect(searchable[0].label).toBe(IMPORT_ENTRY.title);
    expect(searchable[0].entryId).toBe("settings-import");
  });
});
