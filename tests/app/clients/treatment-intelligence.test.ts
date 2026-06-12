import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTreatmentIntelligence,
  type IntelligenceBlockInput,
  type IntelligenceSessionInput,
} from "@/lib/sessions/treatment-intelligence";

// PR #210: Client Treatment Intelligence Summary. Pure recorded-
// history builder + Overview placement + strictly safe wording.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PAGE = read("app/(app)/clients/[id]/page.tsx");
const CARD = read("components/treatment-intelligence-card.tsx");
const BUILDER = read("lib/sessions/treatment-intelligence.ts");

function session(
  id: string,
  startedAt: string,
  over: Partial<IntelligenceSessionInput> = {},
): IntelligenceSessionInput {
  return {
    id,
    started_at: startedAt,
    next_session_note: null,
    electrolysis_entries: [],
    laser_entries: [],
    ...over,
  };
}

function block(
  sessionId: string,
  over: Partial<IntelligenceBlockInput> = {},
): IntelligenceBlockInput {
  return {
    session_id: sessionId,
    primary_area: "Upper lip",
    block_name: null,
    mode: "thermo",
    apilus_modality: null,
    energy_level: 14,
    machine_frequency: "27.12 MHz",
    probe_label: "Ballet F3",
    minutes_performed: 15,
    tolerance_rating: 4,
    reaction_type: "mild_redness",
    caution_for_next_session: false,
    caution_note: null,
    entry_hairs: [100],
    ...over,
  };
}

describe("buildTreatmentIntelligence: overall", () => {
  it("no charted history returns the empty state", () => {
    const out = buildTreatmentIntelligence({
      sessionsNewestFirst: [session("a", "2026-06-01T10:00:00Z")],
      blocks: [],
    });
    expect(out.charted).toBe(false);
    expect(out.overall.chartedSessions).toBe(0);
  });

  it("sums sessions, areas, minutes, hairs and computes hairs/min", () => {
    const out = buildTreatmentIntelligence({
      sessionsNewestFirst: [
        session("new", "2026-06-10T10:00:00Z"),
        session("old", "2026-06-01T10:00:00Z"),
      ],
      blocks: [
        block("old", { minutes_performed: 15, entry_hairs: [100] }),
        block("new", { minutes_performed: 30, entry_hairs: [200, 50] }),
      ],
    });
    expect(out.overall.chartedSessions).toBe(2);
    expect(out.overall.areasCharted).toBe(2);
    expect(out.overall.minutes).toBe(45);
    expect(out.overall.hairs).toBe(350);
    expect(out.overall.hairsPerMinute).toBe(7.8); // 350/45 -> 7.8
    expect(out.overall.firstTreated).toBe("2026-06-01T10:00:00Z");
    expect(out.overall.lastTreated).toBe("2026-06-10T10:00:00Z");
  });

  it("missing minutes/hairs stay null; hairs/min only with both", () => {
    const out = buildTreatmentIntelligence({
      sessionsNewestFirst: [session("a", "2026-06-01T10:00:00Z")],
      blocks: [
        block("a", { minutes_performed: null, entry_hairs: [null] }),
      ],
    });
    expect(out.overall.minutes).toBeNull();
    expect(out.overall.hairs).toBeNull();
    expect(out.overall.hairsPerMinute).toBeNull();
  });

  it("ignores non-positive values and never double-counts blockless entries", () => {
    const out = buildTreatmentIntelligence({
      sessionsNewestFirst: [
        session("withblocks", "2026-06-09T10:00:00Z", {
          electrolysis_entries: [{ hairs_treated: 100 }],
        }),
        session("legacy", "2026-06-01T10:00:00Z", {
          electrolysis_entries: [{ hairs_treated: 40 }, { hairs_treated: -5 }],
        }),
      ],
      blocks: [
        block("withblocks", { minutes_performed: -10, entry_hairs: [100] }),
      ],
    });
    // The withblocks session's hairs come from its block's entries
    // only (100), never re-added from the session row; the legacy
    // blockless session contributes its valid 40.
    expect(out.overall.hairs).toBe(140);
    expect(out.overall.minutes).toBeNull(); // -10 ignored
  });
});

describe("buildTreatmentIntelligence: areas", () => {
  it("groups by trimmed case-insensitive name, newest spelling wins", () => {
    const out = buildTreatmentIntelligence({
      sessionsNewestFirst: [
        session("new", "2026-06-10T10:00:00Z"),
        session("old", "2026-06-01T10:00:00Z"),
      ],
      blocks: [
        block("old", { primary_area: "upper lip ", minutes_performed: 10, entry_hairs: [50] }),
        block("new", { primary_area: "Upper lip", minutes_performed: 20, entry_hairs: [150] }),
      ],
    });
    expect(out.areas.length).toBe(1);
    const a = out.areas[0];
    expect(a.name).toBe("Upper lip");
    expect(a.sessions).toBe(2);
    expect(a.minutes).toBe(30);
    expect(a.hairs).toBe(200);
    expect(a.hairsPerMinute).toBe(6.7);
    expect(a.firstTreated).toBe("2026-06-01T10:00:00Z");
    expect(a.lastTreated).toBe("2026-06-10T10:00:00Z");
  });

  it("blank/null area names never crash and are excluded from cards", () => {
    const out = buildTreatmentIntelligence({
      sessionsNewestFirst: [session("a", "2026-06-01T10:00:00Z")],
      blocks: [
        block("a", { primary_area: null, block_name: "  ", minutes_performed: 10 }),
      ],
    });
    expect(out.areas.length).toBe(0);
    // Their minutes still count overall.
    expect(out.overall.minutes).toBe(10);
  });

  it("latest setup comes from the most recent block; missing settings render null", () => {
    const out = buildTreatmentIntelligence({
      sessionsNewestFirst: [
        session("new", "2026-06-10T10:00:00Z"),
        session("old", "2026-06-01T10:00:00Z"),
      ],
      blocks: [
        block("old", { machine_frequency: "13.56 MHz", probe_label: "Old probe" }),
        block("new", {
          machine_frequency: "27.12 MHz",
          probe_label: null,
          mode: null,
          apilus_modality: null,
          energy_level: null,
        }),
      ],
    });
    const a = out.areas[0];
    expect(a.latestFrequency).toBe("27.12 MHz");
    expect(a.latestProbe).toBeNull();
    expect(a.latestModeLabel).toBeNull();
    expect(a.latestEnergyLevel).toBeNull();
  });

  it("common reaction picks the most frequent; ties prefer most recent", () => {
    const out = buildTreatmentIntelligence({
      sessionsNewestFirst: [
        session("s3", "2026-06-10T10:00:00Z"),
        session("s2", "2026-06-05T10:00:00Z"),
        session("s1", "2026-06-01T10:00:00Z"),
      ],
      blocks: [
        block("s1", { reaction_type: "mild_redness" }),
        block("s2", { reaction_type: "sensitivity" }),
        block("s3", { reaction_type: "sensitivity" }),
      ],
    });
    expect(out.commonReactionLabel).toBe("Sensitivity");
    expect(out.latestReactionLabel).toBe("Sensitivity");
    const tie = buildTreatmentIntelligence({
      sessionsNewestFirst: [
        session("s2", "2026-06-05T10:00:00Z"),
        session("s1", "2026-06-01T10:00:00Z"),
      ],
      blocks: [
        block("s1", { reaction_type: "mild_redness" }),
        block("s2", { reaction_type: "swelling" }),
      ],
    });
    expect(tie.commonReactionLabel).toBe("Swelling"); // tie -> most recent
  });

  it("latest tolerance, watch note, and plan surface from the most recent records", () => {
    const out = buildTreatmentIntelligence({
      sessionsNewestFirst: [
        session("new", "2026-06-10T10:00:00Z", {
          next_session_note: "Chin: shorter intervals.",
        }),
        session("old", "2026-06-01T10:00:00Z", {
          next_session_note: "Old plan.",
        }),
      ],
      blocks: [
        block("old", { tolerance_rating: 2, caution_for_next_session: true, caution_note: "old caution" }),
        block("new", { tolerance_rating: 5, caution_for_next_session: true, caution_note: "start lower" }),
      ],
    });
    expect(out.latestToleranceRating).toBe(5);
    expect(out.latestWatchNote).toBe("start lower");
    expect(out.latestPlan).toBe("Chin: shorter intervals.");
  });
});

describe("placement + UI", () => {
  it("renders on the client profile Overview between Client info and Pricing", () => {
    const overview = PAGE.slice(
      PAGE.indexOf('{activeTab === "overview"'),
      PAGE.indexOf('{activeTab === "messages"'),
    );
    const info = overview.indexOf("Client info");
    const intel = overview.indexOf("<TreatmentIntelligenceCard");
    const pricing = overview.lastIndexOf("Pricing");
    expect(info).toBeGreaterThan(-1);
    expect(intel).toBeGreaterThan(info);
    expect(pricing).toBeGreaterThan(intel);
  });

  it("titled Treatment Intelligence with the required helper + judgment copy", () => {
    expect(CARD).toMatch(/Treatment Intelligence/);
    expect(CARD).toMatch(
      /Based on recorded treatment areas and session history\./,
    );
    expect(CARD).toMatch(
      /Use\s*\n?\s*professional judgment\. This summary reflects recorded history only\./,
    );
  });

  it("empty state and Not recorded handling render", () => {
    expect(CARD).toMatch(/No charted treatment history yet\./);
    expect(CARD).toMatch(/Not recorded/);
  });

  it("not under Record Keeping or Settings", () => {
    const records = read("app/(app)/records/page.tsx");
    expect(records).not.toMatch(/TreatmentIntelligence/);
  });
});

describe("safety wording", () => {
  it("no overclaiming language in the card or builder", () => {
    for (const src of [CARD, BUILDER]) {
      expect(src).not.toMatch(/\bbest\b/i);
      expect(src).not.toMatch(/recommend/i);
      expect(src).not.toMatch(/\bcaused\b/i);
      expect(src).not.toMatch(/\bsafe\b(?! wording| language)/i);
      expect(src).not.toMatch(/diagnos/i);
      expect(src).not.toMatch(/treatment is working|works best|predicted|success/i);
    }
  });

  it("read-only: builder is pure (no imports of supabase) and page query is a select", () => {
    expect(BUILDER).not.toMatch(/supabase|createClient/);
    expect(PAGE).toMatch(/from\("session_blocks"\)[\s\S]{0,700}\.is\("deleted_at", null\)/);
  });
});
