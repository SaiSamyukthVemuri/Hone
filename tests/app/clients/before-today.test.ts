import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildBeforeToday,
  type BeforeTodayInput,
} from "@/lib/sessions/before-today";

// PR #211: "Before today" pre-treatment briefing. Pure assembler over
// data the Overview already loads; recorded-history wording only.
// PR #237: briefing reading order (Remember today first, then the
// last treatment snapshot, then client response, then record
// reminders) with chips and wrapping notes.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PAGE = read("app/(app)/clients/[id]/page.tsx");
const CARD = read("components/before-today-card.tsx");
const BUILDER = read("lib/sessions/before-today.ts");

function input(over: Partial<BeforeTodayInput> = {}): BeforeTodayInput {
  return {
    lastTreatment: {
      startedAt: "2026-06-11T00:54:00Z",
      modality: "electrolysis",
      areaNames: ["Upper lip", "Chin"],
      aftercareExplainedAt: "2026-06-11T01:00:00Z",
      blockLots: ["460941", "460941"],
      blockMinutes: [15, 15],
      blockReactionNotes: [null, "Settled within an hour."],
    },
    watchPlan: {
      watchLines: ["start lower next time and check sensitivity"],
      nextSessionNote: "Start lower on upper lip.",
    },
    intelligence: {
      latestReactionLabel: "Mild redness",
      latestToleranceRating: 3,
      areas: [
        {
          name: "Chin",
          sessions: 2,
          areasCharted: 2,
          minutes: 30,
          hairs: 200,
          hairsPerMinute: 6.7,
          firstTreated: "2026-06-01T10:00:00Z",
          lastTreated: "2026-06-11T00:54:00Z",
          latestFrequency: "27.12 MHz",
          latestProbe: "Ballet F3",
          latestModeLabel: "Thermolysis",
          latestEnergyLevel: 14,
          commonReactionLabel: "Mild redness",
          latestWatchNote: null,
        },
      ],
    },
    client: {
      dateOfBirth: "1990-01-01",
      phone: "555-1234",
      address: "1 Main St",
    },
    ...over,
  };
}

describe("buildBeforeToday", () => {
  it("no charted history returns the empty briefing", () => {
    const b = buildBeforeToday(input({ lastTreatment: null }));
    expect(b.hasHistory).toBe(false);
    expect(b.lastTreated).toBeNull();
    expect(b.setup).toBeNull();
    expect(b.response.hasAny).toBe(false);
    expect(b.reminders).toEqual([]);
  });

  it("last treated joins areas naturally and keeps the date", () => {
    const b = buildBeforeToday(input());
    expect(b.lastTreated?.areasLine).toBe("Upper lip and Chin");
    expect(b.lastTreated?.startedAt).toBe("2026-06-11T00:54:00Z");
    const single = buildBeforeToday(
      input({
        lastTreatment: {
          ...input().lastTreatment!,
          areaNames: ["Chin"],
        },
      }),
    );
    expect(single.lastTreated?.areasLine).toBe("Chin");
  });

  it("remember today carries watch/plan only; empty watch+plan flags hasNotes false", () => {
    const b = buildBeforeToday(input());
    expect(b.remember.hasNotes).toBe(true);
    expect(b.remember.watchLines).toEqual([
      "start lower next time and check sensitivity",
    ]);
    expect(b.remember.plan).toBe("Start lower on upper lip.");
    const none = buildBeforeToday(
      input({ watchPlan: { watchLines: [], nextSessionNote: null } }),
    );
    expect(none.remember.hasNotes).toBe(false);
    expect(none.remember.plan).toBeNull();
  });

  it("client response carries tolerance, reaction, and the last treatment's reaction notes", () => {
    const b = buildBeforeToday(input());
    expect(b.response).toEqual({
      toleranceRating: 3,
      reactionLabel: "Mild redness",
      reactionNotes: "Settled within an hour.",
      hasAny: true,
    });
    const none = buildBeforeToday(
      input({
        intelligence: {
          latestReactionLabel: null,
          latestToleranceRating: null,
          areas: input().intelligence.areas,
        },
        lastTreatment: {
          ...input().lastTreatment!,
          blockReactionNotes: [null, "  "],
        },
      }),
    );
    expect(none.response.hasAny).toBe(false);
    expect(none.response.reactionNotes).toBeNull();
  });

  it("last treatment snapshot sums recorded minutes and keeps distinct probe lots", () => {
    const b = buildBeforeToday(input());
    expect(b.lastTreated?.minutes).toBe(30);
    expect(b.lastTreated?.probeLot).toBe("460941");
    const mixed = buildBeforeToday(
      input({
        lastTreatment: {
          ...input().lastTreatment!,
          blockLots: ["A1", "B2", null],
          blockMinutes: [null, 0, -5],
        },
      }),
    );
    expect(mixed.lastTreated?.probeLot).toBe("A1, B2");
    expect(mixed.lastTreated?.minutes).toBeNull();
  });

  it("latest recorded setup comes from the most recently treated area; missing -> null", () => {
    const b = buildBeforeToday(input());
    expect(b.setup).toEqual({
      frequency: "27.12 MHz",
      probe: "Ballet F3",
      modeLabel: "Thermolysis",
      energyLevel: 14,
    });
    expect(b.latestSetupLine).toBe("27.12 MHz · Ballet F3 · Thermolysis · EL 14");
    const empty = buildBeforeToday(
      input({
        intelligence: { ...input().intelligence, areas: [] },
      }),
    );
    expect(empty.setup).toBeNull();
    expect(empty.latestSetupLine).toBeNull();
  });

  it("record reminders mirror the completeness rules", () => {
    const complete = buildBeforeToday(input());
    expect(complete.reminders).toEqual([]);
    const messy = buildBeforeToday(
      input({
        lastTreatment: {
          ...input().lastTreatment!,
          aftercareExplainedAt: null,
          blockLots: [null, "1"],
        },
        client: { dateOfBirth: null, phone: "  ", address: null },
      }),
    );
    expect(messy.reminders).toEqual([
      "Probe lot number needed before the procedure record is complete",
      "Aftercare/risks not marked on the last session",
      "Client date of birth not recorded",
      "Client phone not recorded",
      "Client address not recorded",
    ]);
    const noAreas = buildBeforeToday(
      input({
        lastTreatment: {
          ...input().lastTreatment!,
          blockLots: [],
        },
      }),
    );
    expect(noAreas.reminders).toContain(
      "Treatment area not recorded on the last session",
    );
  });
});

describe("placement + card", () => {
  it("renders on Overview below Client info and above Treatment Intelligence", () => {
    const overview = PAGE.slice(
      PAGE.indexOf('{activeTab === "overview"'),
      PAGE.indexOf('{activeTab === "messages"'),
    );
    const info = overview.indexOf("Client info");
    const before = overview.indexOf("<BeforeTodayCard");
    const intel = overview.indexOf("<TreatmentIntelligenceCard");
    expect(info).toBeGreaterThan(-1);
    expect(before).toBeGreaterThan(info);
    expect(intel).toBeGreaterThan(before);
  });

  it("not in Record Keeping or Settings", () => {
    expect(read("app/(app)/records/page.tsx")).not.toMatch(/BeforeToday/);
  });

  it("PR #237: briefing reading order is Remember today, Last treatment, Client response, Record reminders", () => {
    const remember = CARD.indexOf("Remember today");
    const last = CARD.indexOf("Last treatment</SectionLabel>");
    const response = CARD.indexOf("Client response (last recorded)");
    const reminders = CARD.indexOf("Record reminders");
    expect(remember).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(remember);
    expect(response).toBeGreaterThan(last);
    expect(reminders).toBeGreaterThan(response);
  });

  it("title, helper, and the required empty states render", () => {
    expect(CARD).toMatch(/>\s*\n?\s*Before today\s*\n?\s*<\/h2>/);
    expect(CARD).toMatch(
      /Key reminders from recorded history before starting this client\./,
    );
    expect(CARD).toMatch(
      /Use\s*\n?\s*professional judgment\. This reflects recorded history only\./,
    );
    expect(CARD).toMatch(/No charted treatment history yet\./);
    expect(CARD).toMatch(
      /Treatment memory will appear here after the first charted session\./,
    );
    expect(CARD).toMatch(
      /Use intake, consultation notes, and professional judgment\./,
    );
    expect(CARD).toMatch(
      /No watch or plan notes recorded from the last treatment\./,
    );
    expect(CARD).toMatch(/Not recorded/);
    expect(CARD).toMatch(/Setup not recorded/);
    expect(CARD).toMatch(
      /Procedure record looks complete based on recorded fields\./,
    );
  });

  it("uses the blue treatment-memory styling for Remember today, first in the body", () => {
    expect(CARD).toMatch(/Remember today/);
    expect(CARD).toMatch(/border-blue-200 bg-blue-50/);
    expect(CARD).toMatch(/Watch:<\/span>/);
    expect(CARD).toMatch(/For next visit:<\/span>/);
  });

  it("snapshot and response render as wrapping chips; long notes wrap", () => {
    expect(CARD).toMatch(/flex flex-wrap gap-1\.5/);
    expect(CARD).toMatch(/Lot \{last\.probeLot\}/);
    expect(CARD).toMatch(/EL \{setup\.energyLevel\}/);
    expect(CARD).toMatch(/\{last\.minutes\} min/);
    expect(CARD).toMatch(/Tolerance \{response\.toleranceRating\}\/5/);
    expect(CARD).toMatch(/\{response\.reactionLabel\}/);
    expect(CARD).toMatch(/\{response\.reactionNotes\}/);
    // Notes and reminders wrap instead of overflowing on phones.
    expect(CARD.match(/break-words/g)?.length).toBeGreaterThanOrEqual(4);
    expect(CARD).toMatch(/whitespace-pre-wrap break-words/);
  });

  it("callsites pass the last treatment's minutes and reaction notes through", () => {
    expect(PAGE).toMatch(/blockMinutes: lastTreatmentBlocks\.map/);
    expect(PAGE).toMatch(/blockReactionNotes: lastTreatmentBlocks\.map/);
    const previews = read("lib/dashboard/before-today-previews.ts");
    expect(previews).toMatch(/blockMinutes: lastBlocks\.map/);
    expect(previews).toMatch(/blockReactionNotes: lastBlocks\.map/);
  });
});

describe("safety", () => {
  it("no overclaiming wording in card or builder", () => {
    for (const src of [CARD, BUILDER]) {
      expect(src).not.toMatch(/\bbest\b/i);
      expect(src).not.toMatch(/recommend/i);
      expect(src).not.toMatch(/\bsafest\b/i);
      expect(src).not.toMatch(/\bcaused\b/i);
      expect(src).not.toMatch(/diagnos/i);
      expect(src).not.toMatch(/predicted|clinically proven|should use|\bsuccess\b/i);
      expect(src).not.toMatch(/\bsafe\b|\bunsafe\b/i);
    }
  });

  it("read-only: builder is pure; no Supabase writes anywhere in the feature", () => {
    expect(BUILDER).not.toMatch(/supabase|createClient/);
    expect(CARD).not.toMatch(/supabase|createClient/);
  });
});

// PR #259: imported treatment memory surfaced in Before Today. The read
// model's void-exclusion / newest-first ordering / cap / provenance labels
// are already proven in tests/lib/imported-treatment-memory.test.ts (and its
// RLS scoping by tests/db/imported-treatment-memory.db.test.ts); these pins
// cover the NEW wiring: the page loads it RLS-scoped + capped + voided-excluded
// and passes it to the card, and the card renders a labelled, provenance-noted,
// read-only section.
describe("imported treatment memory in Before Today (PR #259)", () => {
  // Slice the imported section out of the card so assertions don't match the
  // unrelated live-charted JSX above it.
  const importedStart = CARD.indexOf("importedMemory?.hasItems");
  const importedSection = CARD.slice(importedStart);

  it("the card accepts an optional importedMemory prop (existing call sites unaffected)", () => {
    expect(CARD).toMatch(/importedMemory\?: ImportedMemoryList/);
    expect(CARD).toMatch(/from "@\/lib\/imported-treatment-memory"/);
  });

  it("renders a clearly labelled, provenance-noted section gated on hasItems", () => {
    expect(importedStart).toBeGreaterThan(-1);
    expect(importedSection).toMatch(/Imported treatment memory/);
    // The constant resolves to "Imported history, not charted live in Hone."
    expect(importedSection).toMatch(/IMPORTED_PROVENANCE_NOTE/);
    expect(importedSection).toMatch(/History imported from paper, Jane, or a spreadsheet/);
  });

  it("renders separately from live charted history (after the hasHistory block, regardless of it)", () => {
    // The live empty/“Record reminders” block ends before the imported guard,
    // so the imported section is a sibling that shows even with no live history.
    expect(importedStart).toBeGreaterThan(
      CARD.indexOf("Procedure record looks complete"),
    );
  });

  it("shows safe useful fields and skips empties", () => {
    for (const field of [
      "m.sourceLabel",
      "m.dateLabel",
      "m.treatmentAreaText",
      "m.modality",
      "m.probeLot",
      "m.toleranceText",
      "m.reactionText",
      "m.cautionNote",
      "m.nextVisitNote",
      "m.importedNote",
      "m.aftercareMarked === true",
    ]) {
      expect(importedSection).toContain(field);
    }
  });

  it("shows a 'latest N of M' line only when more imported records exist than displayed", () => {
    expect(importedSection).toMatch(/totalFound > importedMemory\.items\.length/);
    expect(importedSection).toMatch(/Showing the latest/);
  });

  it("uses no clinical-advice / false-assurance wording in the imported section", () => {
    expect(importedSection).not.toMatch(/\bverified\b/i);
    expect(importedSection).not.toMatch(/\bcomplete\b/i);
    expect(importedSection).not.toMatch(/\bsafe\b|\bunsafe\b/i);
    expect(importedSection).not.toMatch(/recommend/i);
    expect(importedSection).not.toMatch(/diagnos/i);
    expect(importedSection).not.toMatch(/should treat/i);
    expect(importedSection).not.toMatch(/\bcaused\b/i);
    expect(importedSection).not.toMatch(/compliance/i);
  });

  it("the page loads imported memory RLS-scoped (studio+client), capped, voided excluded, and passes it to the card", () => {
    // The RLS-backed helper (not the service-role admin client).
    expect(PAGE).toMatch(
      /getImportedTreatmentMemoriesForClient\(studio\.id, client\.id/,
    );
    expect(PAGE).toMatch(/limit: BEFORE_TODAY_IMPORTED_CAP/);
    // Default options exclude voided rows (no includeVoided override here).
    const callStart = PAGE.indexOf("getImportedTreatmentMemoriesForClient(studio.id, client.id");
    const callChunk = PAGE.slice(callStart, callStart + 180);
    expect(callChunk).not.toMatch(/includeVoided/);
    expect(PAGE).toMatch(/importedMemory=\{importedMemory\}/);
    // Imported memory comes from the RLS helper, not a service-role read.
    expect(PAGE).not.toMatch(/createAdminClient[\s\S]*imported_treatment/);
  });
});
