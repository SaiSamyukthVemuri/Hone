import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Client Overview "Last visit / what we did last time" card.
//
// Chloe: "on the client overview I want to clearly see what we did last
// time." This is a PRESENTATION/consolidation surface: a scannable,
// retrospective recap of the SINGLE last completed session, placed high
// on the Overview tab. It reuses the already-loaded last-treatment data
// and the shared buildLastSessionSummary render helpers — no new query,
// no new clinical model, no AI, no second/parallel summary function.
//
// These are source-level assertions (matching the sibling
// last-treatment-cleanup / treatment-memory-ux suites), plus reuse and
// accuracy guarantees.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PAGE = read("app/(app)/clients/[id]/page.tsx");
const CARD = read("components/last-visit-card.tsx");

// Comment-stripped view for "must NOT contain X" code guards, so the
// component's own explanatory prose (which legitimately names helpers
// like buildLastSessionSummary() and explains the price omission) never
// trips a negative assertion. Presence (.toMatch) checks still use the
// raw source.
const CARD_CODE = CARD.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /\/\/.*$/gm,
  "",
);

// The Overview tab slice, bounded exactly like the cleanup suite.
const OVERVIEW = PAGE.slice(
  PAGE.indexOf('{activeTab === "overview"'),
  PAGE.indexOf('{activeTab === "messages"'),
);

describe("Overview Last visit card — placement + wiring", () => {
  it("renders <LastVisitCard> on the Overview tab", () => {
    expect(OVERVIEW).toMatch(/<LastVisitCard/);
    expect(PAGE).toMatch(
      /import \{ LastVisitCard \} from "@\/components\/last-visit-card"/,
    );
  });

  it("is placed near the top: after pinned notes / allergies / skin, before the admin cards", () => {
    const skin = OVERVIEW.indexOf(">\n              Skin");
    const card = OVERVIEW.indexOf("<LastVisitCard");
    const portal = OVERVIEW.indexOf("<PortalAccessCard");
    const consent = OVERVIEW.indexOf("<ConsentSignaturesCard");
    expect(skin).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(skin);
    expect(portal).toBeGreaterThan(card);
    expect(consent).toBeGreaterThan(card);
  });

  it("preserves the existing Overview order (pinned < allergies < skin < info < pricing)", () => {
    const pinned = OVERVIEW.indexOf("ClientPinnedNotesCard");
    const allergies = OVERVIEW.indexOf("Allergies");
    const skin = OVERVIEW.indexOf(">\n              Skin");
    const info = OVERVIEW.indexOf("Client info");
    const pricing = OVERVIEW.lastIndexOf("Pricing");
    expect(allergies).toBeGreaterThan(pinned);
    expect(skin).toBeGreaterThan(allergies);
    expect(info).toBeGreaterThan(skin);
    expect(pricing).toBeGreaterThan(info);
  });

  it("uses clear retrospective language, not forward-looking prep language", () => {
    expect(CARD).toMatch(/>\s*Last visit\s*</);
    expect(CARD).toMatch(/What we did last time/);
    // BeforeToday owns the forward framing; this card must not.
    expect(CARD).not.toMatch(/Remember today/);
    expect(CARD).not.toMatch(/For next visit/);
  });
});

describe("Overview Last visit card — reuses existing summary, no parallel logic", () => {
  it("is fed the shared buildLastSessionSummary output, not a new summary", () => {
    // The card renders the SAME helpers the charting/Sessions surfaces use.
    expect(CARD).toMatch(
      /from "@\/components\/last-session-summary"/,
    );
    expect(CARD).toMatch(/<AreaSummaries summary=\{summary\}/);
    expect(CARD).toMatch(/<FromLastVisitForToday summary=\{summary\} attached/);
    // The component defines/calls NO summary builder of its own — it
    // receives the already-built summary as a prop.
    expect(CARD_CODE).not.toMatch(/buildLastSessionSummary\(/);
    expect(CARD_CODE).not.toMatch(/function build[A-Z]/);
  });

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

describe("Overview Last visit card — content", () => {
  it("shows date, modality, performer, duration, and aftercare status", () => {
    expect(CARD).toMatch(/<FormattedDateTime iso=\{startedAt\}/);
    expect(CARD).toMatch(/\{modality\}/);
    expect(CARD).toMatch(/performerName/);
    expect(CARD).toMatch(/totalMinutes/);
    expect(CARD).toMatch(/Aftercare explained/);
    expect(CARD).toMatch(/Aftercare not marked/);
  });

  it("links to the correct session detail route via Open session", () => {
    expect(CARD).toMatch(
      /href=\{`\/clients\/\$\{clientId\}\/sessions\/\$\{sessionId\}`\}/,
    );
    expect(CARD).toMatch(/Open session/);
  });

  it("page derives duration + aftercare from already-loaded last-session data (no new query)", () => {
    expect(PAGE).toMatch(/lastTreatmentTotalMinutes/);
    expect(PAGE).toMatch(/lastTreatmentBlocks\.reduce/);
    expect(PAGE).toMatch(/lastTreatmentAftercareAt/);
    // No new Supabase read introduced for this card.
    const cardTag = OVERVIEW.slice(
      OVERVIEW.indexOf("<LastVisitCard"),
      OVERVIEW.indexOf("/>", OVERVIEW.indexOf("<LastVisitCard")),
    );
    expect(cardTag).not.toMatch(/await/);
    expect(cardTag).not.toMatch(/\.from\(/);
    expect(cardTag).not.toMatch(/supabase/);
  });
});

describe("Overview Last visit card — empty + legacy safety", () => {
  it("shows a clean empty state when there is no recorded session", () => {
    expect(CARD).toMatch(/No recorded visits yet\./);
    // Empty state is gated on sessionId/startedAt being present.
    expect(CARD).toMatch(/sessionId && startedAt \?/);
  });

  it("renders without crashing for a legacy session with no area summary", () => {
    // The areas block is guarded; a null / empty summary falls back to a
    // pointer instead of throwing.
    expect(CARD).toMatch(/summary && summary\.areas\.length > 0 \?/);
    expect(CARD).toMatch(/Open the session for full treatment details\./);
    // The watch/plan band is likewise guarded.
    expect(CARD).toMatch(/summary && hasFromLastVisitContent\(summary\)/);
  });

  it("stays clinical-first: no session price RENDERED on the Overview card", () => {
    // Guard the actual price-rendering paths (comment prose explaining
    // the deliberate omission is stripped from CARD_CODE).
    expect(CARD_CODE).not.toMatch(/formatPrice/);
    expect(CARD_CODE).not.toMatch(/price_paid_cents/);
    expect(CARD_CODE).not.toMatch(/Session price/);
    expect(CARD_CODE).not.toMatch(/price/i);
  });
});

describe("BeforeToday remains a separate forward-looking prep card", () => {
  it("BeforeTodayCard still renders on the Overview tab", () => {
    expect(OVERVIEW).toMatch(/<BeforeTodayCard/);
  });

  it("the Sessions-tab 'Last treatment' card is untouched", () => {
    // The additive Overview card does not remove or relabel the fuller
    // Sessions-tab recap (which keeps its price + its own tests).
    expect(PAGE).toMatch(/>Last treatment<\/h2>/);
    expect(PAGE).toMatch(/No charted treatments yet\./);
  });
});
