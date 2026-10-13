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
          latestConfirmedProbeLot: null,
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
      // PR #268: the latest setup is tied to its treatment area.
      areaName: "Chin",
      // BROWSER-FINDING-01: this fixture confirms no lot, so the lot fact is
      // absent and the line is unchanged.
      probeLot: null,
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

  it("BROWSER-FINDING-01 — a CONFIRMED probe lot is recorded setup, not \"Not recorded\"", () => {
    // Proved on hone-synthetic-twin: a historical block held
    // probe_lot_number = "TEST-LOT-1063" with probe_lot_confirmed = true and
    // every other setup field null. The full session rendered
    // "Lot #TEST-LOT-1063 (confirmed)"; Dashboard / Before Today rendered
    // "Latest recorded setup: Not recorded".
    //
    // ONE canonical derivation now answers this (recordedSetupForArea), so the
    // Treatment Intelligence card cannot disagree with these two summaries.
    const lotOnly = (over: Partial<BeforeTodayInput["intelligence"]["areas"][number]>) =>
      buildBeforeToday(
        input({
          intelligence: {
            ...input().intelligence,
            areas: [
              {
                ...input().intelligence.areas[0]!,
                latestFrequency: null,
                latestProbe: null,
                latestModeLabel: null,
                latestEnergyLevel: null,
                ...over,
              },
            ],
          },
        }),
      );

    const confirmed = lotOnly({ latestConfirmedProbeLot: "TEST-LOT-1063" });
    expect(
      confirmed.setup,
      "a confirmed probe lot is recorded setup, so setup must not be null",
    ).not.toBeNull();
    expect(confirmed.latestSetupLine).toBe("Lot TEST-LOT-1063");
    expect(confirmed.setup?.probeLot).toBe("TEST-LOT-1063");
    // NOTHING FABRICATED for the parameters the block did not record.
    expect(confirmed.setup?.frequency).toBeNull();
    expect(confirmed.setup?.probe).toBeNull();
    expect(confirmed.setup?.modeLabel).toBeNull();
    expect(confirmed.setup?.energyLevel).toBeNull();

    // PARTIAL KNOWN SETUP RENDERS POSITIVELY, and the lot joins it.
    const partial = lotOnly({
      latestModeLabel: "Thermolysis",
      latestConfirmedProbeLot: "TEST-LOT-1063",
    });
    expect(partial.latestSetupLine).toBe("Thermolysis · Lot TEST-LOT-1063");

    // "Not recorded" survives ONLY where the authority proves no setup fact:
    // no confirmed lot and no parameter.
    const nothing = lotOnly({ latestConfirmedProbeLot: null });
    expect(
      nothing.setup,
      "with no setup fact at all, Not recorded is still correct",
    ).toBeNull();
    expect(nothing.latestSetupLine).toBeNull();
  });

  it("#774 P2 — a newer treatment's lot is never attributed to the setup's area", () => {
    // PROVENANCE, which is what both #774 P2s were about. `last` is the newest
    // TREATMENT; `setup` is the latest named-area SETUP. They may be DIFFERENT
    // treatments, and the card used to mix both sources into one chip group
    // directly under "Latest recorded setup: <area>" — so the newer treatment's
    // lot read as that area's lot.
    //
    // DISCRIMINATING FIXTURE: the older named area owns a confirmed lot; the
    // newer treatment has no named area and a DIFFERENT lot. If either source
    // leaked into the other, these values would swap or collide.
    const diverged = buildBeforeToday(
      input({
        lastTreatment: {
          ...input().lastTreatment!,
          areaNames: [],
          blockLots: ["TEST-LOT-2099"],
        },
        intelligence: {
          ...input().intelligence,
          areas: [
            {
              ...input().intelligence.areas[0]!,
              name: "neck",
              latestFrequency: null,
              latestProbe: null,
              latestModeLabel: null,
              latestEnergyLevel: null,
              latestConfirmedProbeLot: "TEST-LOT-1063",
            },
          ],
        },
      }),
    );

    // The setup's area owns ITS lot, and the newer lot is not it.
    expect(diverged.setup?.areaName).toBe("neck");
    expect(diverged.setup?.probeLot).toBe("TEST-LOT-1063");
    expect(
      diverged.latestSetupLine,
      "TEST-LOT-2099 must never appear as the neck setup",
    ).toBe("Lot TEST-LOT-1063");
    // The newer treatment keeps its own lot, as a last-treatment fact.
    expect(diverged.lastTreated?.probeLot).toBe("TEST-LOT-2099");
    // Nothing fabricated for the parameters the neck block did not record.
    expect(diverged.setup?.frequency).toBeNull();
    expect(diverged.setup?.probe).toBeNull();
    expect(diverged.setup?.modeLabel).toBeNull();
    expect(diverged.setup?.energyLevel).toBeNull();

    // AND THE CARD ATTRIBUTES THEM SEPARATELY. Only source can reach this.
    // Each lot sits in the group under the label naming its own source, so the
    // last-treatment lot must appear BEFORE the setup label and the setup lot
    // AFTER it.
    const lastLot = CARD.indexOf("{last.probeLot && <Chip>Lot {last.probeLot}</Chip>}");
    const setupLabel = CARD.indexOf("Latest recorded setup: ${setup.areaName}");
    const setupLot = CARD.indexOf("{setup.probeLot && <Chip>Lot {setup.probeLot}</Chip>}");
    expect(lastLot, "the last-treatment lot is not rendered").toBeGreaterThan(-1);
    expect(setupLabel, "the setup label is not rendered").toBeGreaterThan(-1);
    expect(setupLot, "the setup's own lot is not rendered").toBeGreaterThan(-1);
    expect(
      lastLot < setupLabel,
      "the last-treatment lot must sit in the last-treatment group, before the setup label",
    ).toBe(true);
    expect(
      setupLot > setupLabel,
      "the setup's lot must sit in the setup group, under the setup label",
    ).toBe(true);
    // AND THE TREATMENT'S LOT IS NEVER SUPPRESSED BY MATCHING THE SETUP'S.
    // Equal lot NUMBERS are not provenance — the newest treatment can reuse the
    // lot the older area recorded — so a value-equality condition here would
    // hide that the newest treatment recorded one at all.
    expect(
      CARD,
      "the treatment's lot must not be suppressed by equality with the setup's",
    ).not.toMatch(/last\.probeLot !== setup\?\.probeLot/);
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
    expect(CARD).toMatch(/Lot \{setup\.probeLot\}/);
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
