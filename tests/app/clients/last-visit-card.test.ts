import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Client Overview "Last visit / what we did last time" card: a recap of the
// SINGLE last completed session. Two source tripwires remain here: the page
// feeds it the single-last-session summary (accuracy), and the card renders
// no price. Its rendered states are proved in clinical-read-truth.test.ts.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PAGE = read("app/(app)/clients/[id]/page.tsx");
const CARD = read("components/last-visit-card.tsx");

// Comment-stripped view for "must NOT contain X" code guards, so the
// component's own explanatory prose (which explains the price omission)
// never trips a negative assertion.
const CARD_CODE = CARD.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /\/\/.*$/gm,
  "",
);

// The Overview tab slice, bounded exactly like the cleanup suite.
const OVERVIEW = PAGE.slice(
  PAGE.indexOf('{activeTab === "overview"'),
  PAGE.indexOf('{activeTab === "messages"'),
);

describe("Overview Last visit card — accuracy", () => {
  it("page passes the SINGLE-last-session summary (accuracy), not a cross-history rollup", () => {
    // The wired `summary` prop is lastTreatmentSummary (built from the
    // last treatment's own blocks + next-session note) — NOT
    // preClientWatchPlan (newest session that has a watch/plan) and NOT
    // any Treatment Intelligence latest-across-history field.
    expect(OVERVIEW).toMatch(/summary=\{lastTreatmentSummary\}/);
    const cardTag = OVERVIEW.slice(
      OVERVIEW.indexOf("<LastVisitCard"),
      OVERVIEW.indexOf("/>", OVERVIEW.indexOf("<LastVisitCard")),
    );
    expect(cardTag).not.toMatch(/preClientWatchPlan/);
    expect(cardTag).not.toMatch(/treatmentIntelligence/);
    expect(cardTag).not.toMatch(/beforeToday/);
  });
});

describe("Overview Last visit card — clinical-first", () => {
  it("stays clinical-first: no session price RENDERED on the Overview card", () => {
    // Guard the actual price-rendering paths (comment prose explaining
    // the deliberate omission is stripped from CARD_CODE).
    expect(CARD_CODE).not.toMatch(/formatPrice/);
    expect(CARD_CODE).not.toMatch(/price_paid_cents/);
    expect(CARD_CODE).not.toMatch(/Session price/);
    expect(CARD_CODE).not.toMatch(/price/i);
  });
});
