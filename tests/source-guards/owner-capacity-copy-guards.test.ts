import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { NAV_ENTRIES } from "@/lib/search/navigation-registry";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

// ===========================================================================
// OWNER CAPACITY — the copy may not out-claim the number
// ===========================================================================
//
// Booking depth counts future TREATMENT appointments; `summarizeFutureTreatment`
// deliberately excludes consultations. So an active treatment client whose only
// future booking is a consultation belongs in the zero band — and any copy
// promising to find people with "nothing booked" tells the owner the opposite of
// what the figure means and sends them chasing someone already in the diary.
//
// WHY THIS FILE IS A CLASS GUARD RATHER THAN THREE ASSERTIONS. The same
// over-claim was found and fixed THREE times on this branch: first the
// treatment-time heading, then the depth bands, then the page summary, footer
// and dashboard CTA. Each fix corrected exactly the strings that had been named
// and swept nothing, so the next reviewer found the next copy of it. The rule is
// pinned once, over the whole surface, instead.
//
// SCOPE IS DELIBERATE. This guards the OWNER-CAP surface only.
// `app/(app)/calendar/upcoming/page.tsx` says "Nothing booked in the next two
// weeks", which is TRUE there — that view counts every appointment, not just
// treatment. A repo-wide ban would have been wrong.

const OWNER_CAP_SOURCES = [
  "app/(app)/dashboard/capacity/page.tsx",
  "lib/dashboard/owner-capacity.ts",
  "lib/dashboard/owner-capacity-model.ts",
];

/** The claim, in the shapes it has actually taken on this branch. */
const OVER_BROAD = /nothing\s+(?:booked|on the calendar)|every future appointment/i;

describe("owner capacity copy — never claims more than the figure supports", () => {
  it.each(OWNER_CAP_SOURCES)("%s makes no 'nothing booked' claim anywhere", (rel) => {
    // Comments included on purpose. A comment stating the wrong product rule is
    // how the next person reintroduces it in the UI.
    expect(read(rel).replace(/\s+/g, " ")).not.toMatch(OVER_BROAD);
  });

  it("the capacity page says TREATMENT wherever it describes what it finds", () => {
    // JSX wraps copy across lines, so every phrase is matched
    // whitespace-tolerantly — a guard that a reformat can break is a guard
    // people delete.
    const page = read(OWNER_CAP_SOURCES[0]).replace(/\s+/g, " ");
    expect(page).toMatch(/who has no treatment booked/i);
    expect(page).toMatch(/Future treatment booking depth/);
    expect(page).toMatch(/Counted across future treatment appointments only/);
    expect(page).toMatch(/Consultations do not count/);
    expect(page).toMatch(/No treatment booked/);
    expect(page).toMatch(/Future treatment time for current clients/);
  });

  it("the dashboard entry point to the capacity page does not over-claim", () => {
    // Scoped to the capacity link block, not the whole dashboard: this file is
    // shared with other lanes and a whole-file ban would block them.
    const dash = read("app/(app)/dashboard/page.tsx");
    const at = dash.indexOf("/dashboard/capacity");
    expect(at, "the dashboard must still link to the capacity page").toBeGreaterThan(-1);
    const block = dash.slice(at, at + 600).replace(/\s+/g, " ");
    expect(block).not.toMatch(OVER_BROAD);
    expect(block).toMatch(/no treatment booked/i);
  });

  it("the search entry describes the page truthfully", () => {
    const entry = NAV_ENTRIES.find((e) => e.id === "dashboard-capacity");
    expect(entry, "the capacity entry must stay registered").toBeDefined();
    // The DESCRIPTION is what the product asserts, so it carries the rule...
    expect(entry!.description).not.toMatch(OVER_BROAD);
    expect(entry!.description).toMatch(/no treatment booked/i);
    // ...while the KEYWORDS are what a person types, so the broader phrase is
    // deliberately kept there. Someone searching "nothing booked" should still
    // find this page; being findable is not the same as claiming.
    expect(entry!.keywords).toContain("nothing booked");
    expect(entry!.keywords).toContain("no treatment booked");
  });
});
