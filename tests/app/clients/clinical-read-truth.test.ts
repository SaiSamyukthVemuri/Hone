import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LastVisitCard } from "@/components/last-visit-card";
import { TreatmentIntelligenceCard } from "@/components/treatment-intelligence-card";
import { BeforeTodayCard } from "@/components/before-today-card";
import {
  buildBeforeToday,
  type BeforeTodayInput,
} from "@/lib/sessions/before-today";
import {
  buildLastSessionSummary,
  type ClinicalSummaryBlock,
} from "@/lib/sessions/clinical-summary";
import {
  buildTreatmentIntelligence,
  type IntelligenceBlockInput,
  type IntelligenceSessionInput,
} from "@/lib/sessions/treatment-intelligence";

// CLIN-01-B — a failed clinical read must never become a confident clinical
// absence on the client profile.
//
// THE DEFECT. app/(app)/clients/[id]/page.tsx ran two session_blocks reads and
// consumed `data` while dropping `error`. A failure therefore produced `null ??
// []`, and an empty block array is BYTE-IDENTICAL to what a client with no
// charted history yields. Four surfaces then made affirmative clinical
// statements nobody had read:
//
//   * "No recorded visits yet."                     (Overview, Last visit)
//   * "No charted treatments yet."                  (Sessions tab)
//   * "No charted treatment history yet."           (Treatment Intelligence,
//                                                    Before today)
//   * "No watch or plan notes recorded from the last treatment."
//   * "Procedure record looks complete based on recorded fields."
//
// The last two are the dangerous ones: caution_for_next_session and
// caution_note are the "be careful next time" signal, and their silent
// disappearance is indistinguishable, to a practitioner, from a client who has
// no cautions.
//
// These assertions RENDER the real components rather than grepping them, so a
// future refactor that reintroduces the collapse fails here even if it phrases
// the sentence differently. The authority being honoured is the one
// lib/sessions/last-treatment-loader.ts already states: selected / none /
// UNAVAILABLE, and read failure must never be inferred as absence.

function html(el: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(el);
}

// Every affirmative clinical denial rendered by these three cards. Under a
// failed read NOT ONE of them may appear.
const NEGATIVE_CLAIMS = [
  "No recorded visits yet.",
  "No charted treatments yet.",
  "No charted treatment history yet.",
  "No watch or plan notes recorded from the last treatment.",
  "Procedure record looks complete based on recorded fields.",
  "Setup not recorded",
  "Area not recorded",
];

function expectNoNegativeClaim(markup: string): void {
  for (const claim of NEGATIVE_CLAIMS) {
    expect(markup).not.toContain(claim);
  }
}

// A charted block carrying the exact next-session caution signal.
function cautionBlock(): ClinicalSummaryBlock & { id: string } {
  return {
    id: "block-1",
    sort_order: 0,
    block_name: null,
    primary_area: "Upper lip",
    side: null,
    custom_area_detail: null,
    mode: "thermo",
    apilus_modality: null,
    energy_level: 14,
    minutes_performed: 15,
    probe_label: "Ballet F3",
    tolerance_rating: 3,
    reaction_type: null,
    reaction_notes: null,
    caution_for_next_session: true,
    caution_note: "Start lower on upper lip; reacted at EL14.",
  } as ClinicalSummaryBlock & { id: string };
}

const CHARTED_SUMMARY = buildLastSessionSummary({
  blocks: [cautionBlock()],
  nextSessionNote: "Client started doxycycline — do not treat the jawline.",
});

function lastVisit(over: Record<string, unknown> = {}) {
  return createElement(LastVisitCard, {
    clientId: "client-1",
    sessionId: "session-1",
    startedAt: "2026-06-11T00:54:00Z",
    modality: "electrolysis",
    performerName: "Chloe",
    aftercareExplainedAt: null,
    totalMinutes: 15,
    isLatestSession: true,
    summary: CHARTED_SUMMARY,
    unavailable: false,
    ...over,
  } as Parameters<typeof LastVisitCard>[0]);
}

function beforeTodayInput(over: Partial<BeforeTodayInput> = {}): BeforeTodayInput {
  return {
    lastTreatment: {
      startedAt: "2026-06-11T00:54:00Z",
      modality: "electrolysis",
      areaNames: ["Upper lip"],
      aftercareExplainedAt: "2026-06-11T01:00:00Z",
      blockLots: ["460941"],
      blockMinutes: [15],
      blockReactionNotes: ["Settled within an hour."],
    },
    watchPlan: {
      watchLines: CHARTED_SUMMARY.watchLines,
      nextSessionNote: CHARTED_SUMMARY.nextSessionNote,
    },
    intelligence: {
      latestReactionLabel: "Mild redness",
      latestToleranceRating: 3,
      areas: [],
    },
    client: {
      dateOfBirth: "1990-01-01",
      phone: "555-0100",
      address: "1 Elm St",
    },
    ...over,
  };
}

const INTEL_SESSION: IntelligenceSessionInput = {
  id: "session-1",
  started_at: "2026-06-11T00:54:00Z",
  next_session_note: "Client started doxycycline — do not treat the jawline.",
  electrolysis_entries: [],
  laser_entries: [],
};

const INTEL_BLOCK: IntelligenceBlockInput = {
  session_id: "session-1",
  primary_area: "Upper lip",
  block_name: null,
  mode: "thermo",
  apilus_modality: null,
  energy_level: 14,
  machine_frequency: "27.12 MHz",
  probe_label: "Ballet F3",
  minutes_performed: 15,
  tolerance_rating: 3,
  reaction_type: "mild_redness",
  caution_for_next_session: true,
  caution_note: "Start lower on upper lip; reacted at EL14.",
  entry_hairs: [40],
};

const INTEL_WITH_HISTORY = buildTreatmentIntelligence({
  sessionsNewestFirst: [INTEL_SESSION],
  blocks: [INTEL_BLOCK],
});

// The value the page builds BEFORE either read runs. Identical to what a
// client with genuinely no charted history yields; that is the whole trap.
const INTEL_EMPTY = buildTreatmentIntelligence({
  sessionsNewestFirst: [],
  blocks: [],
});

// ---------------------------------------------------------------------------
// 1 + 2. The two truthful states are PRESERVED.
// ---------------------------------------------------------------------------

describe("read SUCCESS: recorded history still renders", () => {
  it("Last visit renders the charted areas and the caution band", () => {
    const markup = html(lastVisit());
    expect(markup).toContain("Upper lip");
    expect(markup).toContain("Start lower on upper lip");
    expect(markup).toContain("do not treat the jawline");
    expect(markup).not.toContain("could not be loaded");
  });

  it("Treatment Intelligence renders the recorded stats", () => {
    const markup = html(
      createElement(TreatmentIntelligenceCard, {
        intelligence: INTEL_WITH_HISTORY,
        unavailable: false,
      }),
    );
    expect(markup).toContain("Charted sessions");
    expect(markup).not.toContain("No charted treatment history yet.");
    expect(markup).not.toContain("could not be loaded");
  });

  it("Before today renders the watch note and the plan", () => {
    const briefing = buildBeforeToday(beforeTodayInput());
    expect(briefing.unavailable).toBe(false);
    expect(briefing.hasHistory).toBe(true);
    const markup = html(createElement(BeforeTodayCard, { briefing }));
    expect(markup).toContain("Start lower on upper lip");
    expect(markup).toContain("do not treat the jawline");
    expect(markup).not.toContain("could not be loaded");
  });
});

describe("read SUCCESS + genuinely no history: the truthful none-state stays", () => {
  it("Last visit still says 'No recorded visits yet.'", () => {
    const markup = html(
      lastVisit({ sessionId: null, startedAt: null, summary: null }),
    );
    expect(markup).toContain("No recorded visits yet.");
    expect(markup).not.toContain("could not be loaded");
  });

  it("Treatment Intelligence still says 'No charted treatment history yet.'", () => {
    const markup = html(
      createElement(TreatmentIntelligenceCard, {
        intelligence: INTEL_EMPTY,
        unavailable: false,
      }),
    );
    expect(markup).toContain("No charted treatment history yet.");
    expect(markup).not.toContain("could not be loaded");
  });

  it("Before today still says 'No charted treatment history yet.'", () => {
    const briefing = buildBeforeToday(
      beforeTodayInput({ lastTreatment: null, watchPlan: null }),
    );
    expect(briefing.unavailable).toBe(false);
    const markup = html(createElement(BeforeTodayCard, { briefing }));
    expect(markup).toContain("No charted treatment history yet.");
    expect(markup).not.toContain("could not be loaded");
  });
});

// ---------------------------------------------------------------------------
// 3 + 4 + 5. Read FAILURE renders unavailable, and asserts NOTHING.
// ---------------------------------------------------------------------------

describe("read FAILURE renders an explicit unavailable state", () => {
  it("Last visit: unavailable, and no negative clinical claim", () => {
    // The shape a failed read really produces on the page: the blocks map is
    // empty, so pickLastTreatment returned null and the summary was never
    // built. Only the flag distinguishes this from a first-visit client.
    const markup = html(
      lastVisit({
        sessionId: null,
        startedAt: null,
        summary: null,
        unavailable: true,
      }),
    );
    expect(markup).toContain("Clinical history could not be loaded.");
    expect(markup).toContain('data-testid="last-visit-unavailable"');
    expectNoNegativeClaim(markup);
  });

  it("Last visit: unavailable wins even if a session row survived", () => {
    // pickLastTreatment falls back to raw entries, so a failed BLOCK read can
    // still yield a session. Rendering its header with the watch band silently
    // missing would read as "nothing to watch for".
    const markup = html(lastVisit({ summary: null, unavailable: true }));
    expect(markup).toContain("Clinical history could not be loaded.");
    expect(markup).not.toContain("Open the session for full treatment details.");
    expectNoNegativeClaim(markup);
  });

  it("the unavailable copy explicitly refuses to claim absence", () => {
    const markup = html(lastVisit({ unavailable: true }));
    expect(markup).toContain("not a statement that none is recorded");
  });
});

describe("Watch/Plan absence is NOT asserted under read failure", () => {
  it("Before today never says the last treatment had no watch or plan notes", () => {
    const briefing = buildBeforeToday(
      // Exactly what the page passes when the read failed: the clinical inputs
      // are empty because they could not be read, not because they are empty.
      beforeTodayInput({
        lastTreatment: null,
        watchPlan: null,
        intelligence: {
          latestReactionLabel: null,
          latestToleranceRating: null,
          areas: [],
        },
        clinicalUnavailable: true,
      }),
    );
    expect(briefing.unavailable).toBe(true);
    const markup = html(createElement(BeforeTodayCard, { briefing }));
    expect(markup).toContain("Clinical history could not be loaded.");
    expect(markup).toContain('data-testid="before-today-unavailable"');
    expectNoNegativeClaim(markup);
  });

  it("caution fields cannot disappear into a confident none", () => {
    // The caution IS in the record. A failed read must not render the same as
    // a client who has no caution: the two markups must differ, and the
    // failure one must not deny.
    const recorded = html(
      createElement(BeforeTodayCard, {
        briefing: buildBeforeToday(beforeTodayInput()),
      }),
    );
    const noCaution = html(
      createElement(BeforeTodayCard, {
        briefing: buildBeforeToday(
          beforeTodayInput({ watchPlan: { watchLines: [], nextSessionNote: null } }),
        ),
      }),
    );
    const failed = html(
      createElement(BeforeTodayCard, {
        briefing: buildBeforeToday(
          beforeTodayInput({
            lastTreatment: null,
            watchPlan: null,
            clinicalUnavailable: true,
          }),
        ),
      }),
    );
    expect(recorded).toContain("Start lower on upper lip");
    // The genuine none-state is allowed to say so...
    expect(noCaution).toContain(
      "No watch or plan notes recorded from the last treatment.",
    );
    // ...and the failed read is not.
    expect(failed).not.toContain(
      "No watch or plan notes recorded from the last treatment.",
    );
    // ...nor is it allowed to fall back on any OTHER denial in its place.
    expectNoNegativeClaim(failed);
    expect(failed).not.toBe(noCaution);
  });

  it("does not claim the procedure record is complete", () => {
    // The most dangerous derived negative: reminders are empty under failure
    // only because nothing was read.
    const briefing = buildBeforeToday(
      beforeTodayInput({ lastTreatment: null, clinicalUnavailable: true }),
    );
    expect(briefing.reminders).toEqual([]);
    const markup = html(createElement(BeforeTodayCard, { briefing }));
    expect(markup).not.toContain(
      "Procedure record looks complete based on recorded fields.",
    );
    expectNoNegativeClaim(markup);
  });

  it("keeps client-record reminders, which loaded successfully", () => {
    // "Do not make unrelated client-record facts unavailable if they loaded."
    const briefing = buildBeforeToday(
      beforeTodayInput({
        lastTreatment: null,
        clinicalUnavailable: true,
        client: { dateOfBirth: null, phone: null, address: null },
      }),
    );
    expect(briefing.reminders).toEqual([
      "Client date of birth not recorded",
      "Client phone not recorded",
      "Client address not recorded",
    ]);
    // ...and NOT the clinical ones, which are unknown rather than missing.
    expect(briefing.reminders).not.toContain(
      "Aftercare/risks not marked on the last session",
    );
    expect(briefing.reminders).not.toContain(
      "Treatment area not recorded on the last session",
    );
    const markup = html(createElement(BeforeTodayCard, { briefing }));
    expect(markup).toContain("Client date of birth not recorded");
    expectNoNegativeClaim(markup);
  });
});

// ---------------------------------------------------------------------------
// 7. Treatment Intelligence: unavailable cannot become known-empty.
// ---------------------------------------------------------------------------

describe("Treatment Intelligence read failure is not a numeric/known-empty result", () => {
  it("renders unavailable instead of the empty-history statement", () => {
    const markup = html(
      createElement(TreatmentIntelligenceCard, {
        // The page's pre-read `blocks: []` value, unchanged by the failure.
        intelligence: INTEL_EMPTY,
        unavailable: true,
      }),
    );
    expect(markup).toContain("Clinical history could not be loaded.");
    expect(markup).toContain('data-testid="treatment-intelligence-unavailable"');
    expectNoNegativeClaim(markup);
  });

  it("renders no zeroed stats", () => {
    const markup = html(
      createElement(TreatmentIntelligenceCard, {
        intelligence: buildTreatmentIntelligence({
          // A client WITH sessions whose blocks could not be read: exactly the
          // known-empty clinical result this must not show.
          sessionsNewestFirst: [INTEL_SESSION],
          blocks: [],
        }),
        unavailable: true,
      }),
    );
    expect(markup).not.toContain("Charted sessions");
    expect(markup).not.toContain("Treatment areas charted");
    expect(markup).not.toContain("Not recorded");
    // ...and does not swap one known-empty rendering for another.
    expectNoNegativeClaim(markup);
  });
});

// ---------------------------------------------------------------------------
// 8. Before Today preserves unavailable clinical truth end to end.
// ---------------------------------------------------------------------------

describe("buildBeforeToday: unavailable dominates every derived field", () => {
  it("returns unavailable and no clinical claim, whatever was passed in", () => {
    // Hostile input: the clinical fields are POPULATED, and the flag must
    // still win — an unavailable upstream state cannot be converted back into
    // a known value by a caller that also passes stale data.
    const briefing = buildBeforeToday(
      beforeTodayInput({ clinicalUnavailable: true }),
    );
    expect(briefing.unavailable).toBe(true);
    expect(briefing.lastTreated).toBeNull();
    expect(briefing.setup).toBeNull();
    expect(briefing.latestSetupLine).toBeNull();
    expect(briefing.remember.hasNotes).toBe(false);
    expect(briefing.response.hasAny).toBe(false);
    // hasHistory is false here because nothing could be READ. The card must
    // never reach that branch, which the source guard below pins.
    expect(briefing.hasHistory).toBe(false);
  });

  it("defaults to available so the dashboard preview caller is unchanged", () => {
    expect(buildBeforeToday(beforeTodayInput()).unavailable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WIRING. What a render test cannot see: that the page preserves the errors,
// keeps the reads tab-gated, and orders the card branches correctly.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const PAGE = read("app/(app)/clients/[id]/page.tsx");
const CARD = read("components/before-today-card.tsx");
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*\/\/|^\s*\{?\/\*|^\s*\*/.test(l))
    .join("\n");
const PAGE_CODE = codeOnly(PAGE);

describe("the client profile preserves both session_blocks read errors", () => {
  it("destructures `error` on the last-treatment read and flags it", () => {
    expect(PAGE_CODE).toMatch(
      /const \{ data: recentBlocks, error: recentBlocksError \} =/,
    );
    expect(PAGE_CODE).toMatch(
      /if \(recentBlocksError\) \{[\s\S]{0,400}?clinicalHistoryUnavailable = true;/,
    );
  });

  it("destructures `error` on the intelligence read and flags it", () => {
    expect(PAGE_CODE).toMatch(
      /const \{ data: intelBlocks, error: intelBlocksError \} =/,
    );
    expect(PAGE_CODE).toMatch(
      /if \(intelBlocksError\) \{[\s\S]{0,400}?intelligenceUnavailable = true;/,
    );
  });

  it("never builds the summaries from a failed read", () => {
    // The success body sits in the `else`, so pickLastTreatment and
    // buildTreatmentIntelligence cannot run on a `[]` produced by a failure.
    expect(PAGE_CODE).toMatch(
      /clinicalHistoryUnavailable = true;\s*\} else \{/,
    );
    expect(PAGE_CODE).toMatch(/intelligenceUnavailable = true;\s*\} else \{/);
  });

  it("passes each flag to the surface it belongs to", () => {
    expect(PAGE_CODE).toMatch(/unavailable=\{clinicalHistoryUnavailable\}/);
    expect(PAGE_CODE).toMatch(/unavailable=\{intelligenceUnavailable\}/);
    // Before Today consumes BOTH reads, so it takes the union.
    expect(PAGE_CODE).toMatch(
      /clinicalUnavailable:\s*clinicalHistoryUnavailable \|\| intelligenceUnavailable/,
    );
    // Sessions tab card.
    expect(PAGE_CODE).toMatch(
      /\{clinicalHistoryUnavailable \? \(\s*<ClinicalUnavailableNotice/,
    );
  });

  it("logs classification only — never clinical text or the raw message", () => {
    const logger = PAGE.slice(
      PAGE.indexOf("function logClinicalReadFailure("),
      PAGE.indexOf("function formatPrice("),
    );
    expect(logger).toMatch(/code: typeof code === "string" \? code : null/);
    expect(logger).not.toMatch(/\.message/);
    expect(logger).not.toMatch(/client\.|client_id|caution|notes|email|name/);
  });

  it("does not add a query or widen the reads", () => {
    // Same two session_blocks reads, same selects, same tab gates.
    expect(PAGE_CODE.match(/\.from\("session_blocks"\)/g)?.length).toBe(2);
    expect(PAGE_CODE).toMatch(
      /if \(needsLastTreatment && recentSessions\.length > 0\) \{/,
    );
    expect(PAGE_CODE).toMatch(/if \(isOverview && sessions\.length > 0\) \{/);
    expect(PAGE_CODE).not.toMatch(/service_role|createServiceClient/);
  });
});

describe("the Before today card checks unavailable BEFORE hasHistory", () => {
  it("orders the branches so a failed read cannot reach the none-state", () => {
    const unavailableAt = CARD.indexOf("briefing.unavailable ?");
    const hasHistoryAt = CARD.indexOf("!briefing.hasHistory ?");
    expect(unavailableAt).toBeGreaterThan(-1);
    expect(hasHistoryAt).toBeGreaterThan(unavailableAt);
  });
});
