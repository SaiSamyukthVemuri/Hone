import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #198 pins: Chloe iPad retest fixes.
const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const TAB = read("components/profile-tab.ts");
const PAGE = read("app/(app)/clients/[id]/page.tsx");
const FORM = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");
const INFO = read("components/session-performer-line.tsx");
const SUM = read("components/last-session-summary.tsx");

describe("1. Messages tab actually opens", () => {
  it("isProfileTab accepts messages (the bug: validator omitted it)", () => {
    expect(TAB).toMatch(/value === "messages" \|\|/);
  });
  it("invalid tabs still fall back safely; overview excludes messages", () => {
    expect(PAGE).toMatch(/isProfileTab\(sp\.tab\) \? sp\.tab : "overview"/);
    const overview = PAGE.slice(PAGE.indexOf('{activeTab === "overview"'), PAGE.indexOf('{activeTab === "messages"'));
    expect(overview).not.toMatch(/<PortalMessagesCard/);
  });
});

describe("2. Last Session carries cautions + next-visit context", () => {
  it("client page renders watch/plan via FromLastVisitForToday and per-area summaries", () => {
    expect(PAGE).toMatch(/<AreaSummaries summary=\{lastTreatmentSummary\}/);
    expect(PAGE).toMatch(/<FromLastVisitForToday[\s\S]{0,40}summary=\{preClientWatchPlan\}/);
    expect(SUM).toMatch(/Watch:<\/span>/);
    expect(SUM).toMatch(/Plan:<\/span>/);
    expect(SUM).toMatch(/Tolerance/);
  });
});

describe("3. charting order + chips", () => {
  it("order: readings ... Client tolerance -> Treatment observations & skin response (PR #199: area-level For next visit is gone)", () => {
    const tol = FORM.indexOf(">Client tolerance<");
    // Charting unification: the two former groups are ONE merged box, whose
    // heading is rendered from a shared constant.
    const obs = FORM.indexOf("{OBSERVATIONS_RESPONSE_HEADING}");
    expect(tol).toBeGreaterThan(-1);
    expect(obs).toBeGreaterThan(tol);
    // PR #199: the per-area "For next visit" section was consolidated
    // into the single session-level note.
    expect(FORM.indexOf(">For next visit<")).toBe(-1);
  });
  it("no reaction <select> remains; reactions are merged chips in the unified observations & skin response box", () => {
    // No single-select reaction dropdown anywhere.
    expect(FORM).not.toMatch(/<select[\s\S]{0,200}reactionType/);
    // Charting unification: the former separate "Client / skin response" group is
    // gone. There is ONE merged box, titled via the unified heading, rendering
    // MERGED_OBSERVATION_CHIPS (observation presets + reaction labels) as
    // multi-select toggles on observationChips.
    expect(FORM).toMatch(/\{OBSERVATIONS_RESPONSE_HEADING\}/);
    expect(FORM).not.toMatch(/\{CLIENT_RESPONSE_HEADING\}/);
    const box = FORM.slice(FORM.indexOf("{OBSERVATIONS_RESPONSE_HEADING}"));
    expect(box).toMatch(/MERGED_OBSERVATION_CHIPS\.map/);
    expect(box).toMatch(/isChipSelected\(draft\.observationChips, c\)/);
    expect(box).toMatch(/toggleFindingChip\(draft\.observationChips, c\)/);
    // The reaction is no longer a separate single-select row.
    expect(FORM).not.toMatch(/REACTION_TYPES\.map/);
    // A legacy reaction_type is preserved on save ONLY while its label chip stays
    // selected (never invented from chips), never a separate single-select field.
    expect(FORM).toMatch(
      /isChipSelected\([\s\S]{0,60}reactionTypeLabel\(draft\.reactionType as ReactionType\)/,
    );
  });
  it("legacy reaction notes stay visible; tolerance rating remains", () => {
    expect(FORM).toMatch(/\{draft\.reactionNotes\.trim\(\) !== "" && \(/);
    // PR #279: tolerance is now a label-based control (still stored 1-5).
    expect(FORM).toMatch(/TOLERANCE_OPTIONS\.map/);
  });
});

describe("4. session header", () => {
  it("no price UI; performer select remains", () => {
    expect(INFO).not.toMatch(/Add session price/);
    expect(INFO).not.toMatch(/\$0/);
    expect(INFO).toMatch(/performer/i);
  });
});

describe("5. Client info card", () => {
  it("one card holds birthday + emergency + address with an Edit link", () => {
    const card = PAGE.slice(PAGE.indexOf(">\n                Client info"), PAGE.indexOf("Pricing moved to the end"));
    expect(card).toMatch(/ClientBirthdayCard/);
    expect(card).toMatch(/Emergency contact/);
    expect(card).toMatch(/Address/);
    expect(PAGE).toMatch(/Client info\s*<\/h2>[\s\S]{0,400}\/edit/);
  });
  it("overview order: pinned, allergies, skin, client info, pricing", () => {
    const o = PAGE.slice(PAGE.indexOf('{activeTab === "overview"'), PAGE.indexOf('{activeTab === "messages"'));
    const idx = [o.indexOf("ClientPinnedNotesCard"), o.indexOf("Allergies"), o.indexOf(">\n              Skin"), o.indexOf("Client info"), o.lastIndexOf("Pricing")];
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
  });
});
