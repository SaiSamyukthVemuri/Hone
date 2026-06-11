import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #197 pins: Chloe round-3 polish.
const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const PAGE = read("app/(app)/clients/[id]/page.tsx");
const TIMELINE = read("components/client-appointment-timeline.tsx");
const FORM = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");
const INFO = read("components/session-performer-line.tsx");
const TABBAR = read("components/profile-tab-bar.tsx");
const CAL = read("app/(app)/calendar/page.tsx");
const DAY = read("app/(app)/calendar/DayColumn.tsx");

describe("2. unified history", () => {
  it("timeline labels: Needs charting, Upcoming, History, Cancelled and no-shows", () => {
    for (const l of ['"Needs charting"', '"Upcoming"', '"History"', '"Cancelled and no-shows"'])
      expect(TIMELINE).toContain(l);
    expect(TIMELINE).not.toContain('heading: "Charted"');
  });
  it("no separate Session history; walk-in fallback only", () => {
    expect(PAGE).not.toMatch(/>All sessions</);
    expect(PAGE).toMatch(/Sessions without an appointment/);
  });
});

describe("3. Last session shows per-area settings (shared component)", () => {
  it("client page renders AreaSummaries (settings/probe/tolerance per area)", () => {
    expect(PAGE).toMatch(/<AreaSummaries summary=\{lastTreatmentSummary\}/);
    const SUM = read("components/last-session-summary.tsx");
    expect(SUM).toMatch(/Settings/);
    expect(SUM).toMatch(/Probe/);
    expect(SUM).toMatch(/Tolerance/);
  });
});

describe("4. one free-text box in charting", () => {
  it("Treatment observations appears once; tolerance remains (PR #199: per-area for-next-visit is gone)", () => {
    // One rendered heading (the other mentions are a comment + helper copy).
    expect(FORM.match(/>Treatment observations</g)?.length).toBe(1);
    expect(FORM).toMatch(/Client tolerance/);
    expect(FORM.indexOf(">For next visit<")).toBe(-1);
  });
  it("response-notes textarea only renders for existing saved notes (data preserved)", () => {
    expect(FORM).toMatch(/\{draft\.reactionNotes\.trim\(\) !== "" && \(/);
    expect(FORM).toMatch(/reactionNotes: draft\.reactionNotes\.trim\(\) \|\| null/);
  });
});

describe("5. session price display", () => {
  it("PR #198: no price UI at all in the session header", () => {
    expect(INFO).not.toMatch(/Add session price/);
    expect(INFO).not.toMatch(/Price paid/);
    expect(INFO).toMatch(/Performed by|performer/i);
  });
  it("custom pricing remains on the client profile", () => {
    expect(PAGE).toMatch(/AddPricingForm|client_pricing|Pricing/);
  });
});

describe("6. Messages tab", () => {
  it("tab exists; overview has no messages; tab renders the card", () => {
    expect(TABBAR).toMatch(/\{ value: "messages", label: "Messages" \}/);
    const overview = PAGE.slice(PAGE.indexOf('{activeTab === "overview"'), PAGE.indexOf('{activeTab === "messages"'));
    expect(overview).not.toMatch(/<PortalMessagesCard/);
    expect(PAGE.slice(PAGE.indexOf('{activeTab === "messages"'))).toMatch(/<PortalMessagesCard/);
  });
});

describe("7. overview order", () => {
  it("pinned notes, then allergies, then skin; pricing later", () => {
    const o = PAGE.slice(PAGE.indexOf('{activeTab === "overview"'), PAGE.indexOf('{activeTab === "messages"'));
    const pinned = o.indexOf("ClientPinnedNotesCard");
    const allergies = o.indexOf("Allergies");
    const skin = o.indexOf(">\n              Skin\n            </h2>") >= 0 ? o.indexOf(">\n              Skin\n            </h2>") : o.indexOf("Skin");
    const pricing = o.lastIndexOf("Pricing");
    expect(pinned).toBeGreaterThan(-1);
    expect(allergies).toBeGreaterThan(pinned);
    expect(skin).toBeGreaterThan(allergies);
    expect(pricing).toBeGreaterThan(skin);
  });
});

describe("8. calendar day separation", () => {
  it("stronger vertical separators + strong today tint retained", () => {
    expect(CAL).toMatch(/border-l border-neutral-300/);
    expect(DAY).toMatch(/border-l border-neutral-300/);
    expect(CAL).toMatch(/border-t-sky-600 bg-sky-200/);
  });
});
