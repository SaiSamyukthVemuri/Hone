import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compactSummary } from "@/lib/dashboard/today-treatment-summary";
import type { AppointmentPrepMemory } from "@/lib/sessions/appointment-prep-memory";

// ===========================================================================
// Dashboard V2 Part 2A — previous treatment on the Today row.
// ===========================================================================
//
// Two kinds of assertion, and the split is deliberate:
//
//   * `compactSummary` is pure and exported, so the "missing historical values
//     render truthfully" requirement is tested BEHAVIOURALLY — that is the one
//     that matters clinically and it must not be a source grep.
//   * The wiring (which component mounts where, with which props) is asserted
//     on SOURCE, because this repo runs vitest with `environment: "node"` and
//     ships no React render harness. Standing one up for this PR would be a far
//     larger change than the feature. The trade-off is stated rather than
//     hidden: these prove the JSX, not the painted pixels; the browser lane
//     proves the rest.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const MEMORY_UI = read("app/(app)/dashboard/today-treatment-memory.tsx");
/**
 * Source with `//` lines and `{/* jsx *\/}` blocks removed. Prose that
 * legitimately NAMES a thing must not satisfy a guard looking for that thing
 * being rendered — the comment explaining why "For next visit" is not repeated
 * would otherwise fail the test asserting it is not repeated.
 */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const MEMORY_UI_CODE = codeOnly(MEMORY_UI);
const DASH = read("app/(app)/dashboard/page.tsx");
const CARD = read("components/appointment-prep-memory-card.tsx");
const MODEL = read("lib/sessions/appointment-prep-memory.ts");

function memory(over: Partial<AppointmentPrepMemory> = {}): AppointmentPrepMemory {
  return {
    sessionId: "s-1",
    startedAt: "2026-01-10T10:00:00Z",
    modality: "electrolysis",
    areaHeadline: "Chin",
    totalMinutes: 30,
    totalHairs: 120,
    areas: [],
    notes: {
      general: [],
      forNextVisit: null,
      cautions: [],
      additional: [],
      responses: [],
      hasAny: false,
    },
    blocklessNote: null,
    supersededByEmptySession: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("compact summary — missing history is absent, never a fake zero", () => {
  it("names the visit: date, modality, areas, minutes", () => {
    const s = compactSummary(memory());
    expect(s).toMatch(/2026/);
    expect(s).toContain("electrolysis");
    expect(s).toContain("Chin");
    expect(s).toContain("30 min");
  });

  it("omits minutes entirely when they were never recorded", () => {
    // The clinical point: a legacy visit with no recorded minutes did NOT take
    // zero minutes, and must never read as "0 min".
    const s = compactSummary(memory({ totalMinutes: null }));
    expect(s).not.toMatch(/min/);
    expect(s).not.toMatch(/\b0\b/);
  });

  it("DISTINGUISHES a recorded zero from an absent value", () => {
    // The two-way self-test. `0` is a real measurement and must survive;
    // omitting it would be the opposite lie.
    expect(compactSummary(memory({ totalMinutes: 0 }))).toContain("0 min");
    expect(compactSummary(memory({ totalMinutes: null }))).not.toContain("min");
  });

  it("omits an unrecorded area headline rather than inventing one", () => {
    const s = compactSummary(memory({ areaHeadline: null }));
    expect(s).not.toContain("Chin");
    expect(s).not.toMatch(/undefined|null|Not recorded/);
  });

  it("survives an unparseable date truthfully", () => {
    expect(compactSummary(memory({ startedAt: "not-a-date" }))).toContain(
      "Date not recorded",
    );
  });

  it("never emits empty separators when several fields are absent", () => {
    const s = compactSummary(
      memory({ areaHeadline: null, totalMinutes: null, modality: "" }),
    );
    expect(s).not.toMatch(/·\s*·/);
    expect(s.trim()).not.toMatch(/·\s*$/);
  });
});

describe("the disclosure is accessible and calm by default", () => {
  it("is a real button carrying aria-expanded and aria-controls", () => {
    expect(MEMORY_UI).toMatch(/type="button"/);
    expect(MEMORY_UI).toMatch(/aria-expanded=\{open\}/);
    expect(MEMORY_UI).toMatch(/aria-controls=\{regionId\}/);
    // The controlled region must actually carry that id.
    expect(MEMORY_UI).toMatch(/id=\{regionId\}/);
  });

  it("starts CLOSED, so Today is calm by default", () => {
    expect(MEMORY_UI).toMatch(/useState\(false\)/);
    // The heavy card is mounted only when open — a calm Today does not pay to
    // render every client's full chart.
    expect(MEMORY_UI).toMatch(/\{open && \(/);
  });

  it("the toggle names the client, so repeated rows are distinguishable", () => {
    // Twenty rows of "View full last treatment" are indistinguishable to a
    // screen reader navigating by control.
    expect(MEMORY_UI).toMatch(/View full last treatment for \$\{clientName\}/);
    expect(MEMORY_UI).toMatch(/Hide full last treatment for \$\{clientName\}/);
  });

  it("the collapsed region is hidden from the accessibility tree, not just visually", () => {
    expect(MEMORY_UI).toMatch(/hidden=\{!open\}/);
  });
});

describe("expanding reuses the #517 card — it does not reimplement it", () => {
  it("mounts AppointmentPrepMemoryCard, embedded", () => {
    expect(MEMORY_UI).toMatch(
      /import \{ AppointmentPrepMemoryCard \} from "@\/components\/appointment-prep-memory-card"/,
    );
    expect(MEMORY_UI).toMatch(
      /<AppointmentPrepMemoryCard\s+clientId=\{clientId\}\s+memory=\{memory\}\s+embedded\s*\/>/,
    );
  });

  it("declares no treatment model of its own", () => {
    // The whole point: one model. This file may name the type and nothing else.
    expect(MEMORY_UI).not.toMatch(/function build[A-Z]/);
    expect(MEMORY_UI).not.toMatch(/\.from\(|supabase/);
    expect(MEMORY_UI).not.toMatch(/interface .*Memory|type AppointmentPrepMemory =/);
  });

  it("the embedded variant lowers the heading rank instead of forking the card", () => {
    // "Last treatment" is an h2 on the appointment page, where it IS a section.
    // Inside a Today row it is a detail of that row.
    expect(CARD).toMatch(/embedded \? \(\s*<h4/);
    expect(CARD).toMatch(/<h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">/);
    // ...and drops its own border so a nested card does not double every edge.
    expect(CARD).toMatch(/embedded\s*\?\s*"flex flex-col gap-4"/);
  });
});

describe("every #517 field family is reachable from Today", () => {
  // The chain is: Today mounts the card (asserted above) -> the card renders the
  // family -> the model carries it. Both ends are pinned so a family cannot be
  // dropped from either without failing here.
  it.each([
    ["treatment areas", /data-testid="prep-areas"/, /areaHeadline/],
    ["per-area labels + laterality", /data-testid="prep-area-label"/, /areaParts/],
    ["modality", /memory\.modality/, /modality: string/],
    ["machine settings", /data-testid="prep-setup-area"/, /energyLevel/],
    ["probe and lot", /probeLine/, /"probeLine"/],
    ["observations / outcomes", /data-testid="prep-outcome-area"/, /outcomeRecorded/],
    ["skin response + tolerance", /responseLine/, /"toleranceLine"/],
    ["additional notes", /notes\.additional/, /additional: AreaNarrativeItem\[\]/],
    ["complete session notes", /notes\.general/, /general: NarrativeItem\[\]/],
    ["caution", /notes\.cautions/, /cautions: AreaNarrativeItem\[\]/],
    ["next-visit note", /notes\.forNextVisit/, /forNextVisit: NarrativeItem \| null/],
  ])("%s is rendered by the card and modelled", (_family, inCard, inModel) => {
    expect(CARD, `card must render ${_family}`).toMatch(inCard);
    expect(MODEL, `model must carry ${_family}`).toMatch(inModel);
  });

  it("the card also states when a family was NOT recorded", () => {
    // Truthfulness at the family level, not just the value level.
    expect(CARD).toMatch(/setupRecorded/);
    expect(CARD).toMatch(/outcomeRecorded/);
    expect(CARD).toMatch(/data-testid="prep-notes-empty"/);
    // A charted visit with no settings blocks (laser, pre-0019 electrolysis)
    // says what the record IS rather than "Area not recorded".
    expect(CARD).toMatch(/data-testid="prep-no-blocks"/);
    expect(MODEL).toMatch(/blocklessNote/);
  });
});

describe("the Today row wires it correctly", () => {
  it("renders the memory only for a client who HAS history", () => {
    // A first visit stays one calm relationship line.
    expect(DASH).toMatch(/\{workflow\.hasHistory && \(\s*<TodayTreatmentMemory/);
  });

  it("passes the memory keyed by APPOINTMENT, not by client", () => {
    // Two same-client appointments must each get their own boundary.
    expect(DASH).toMatch(/prepMemoryByAppointment\.get\(appt\.id\)/);
    expect(DASH).toMatch(/prepMemory=\{/);
  });

  it("builds one request per appointment, carrying that appointment's bounds", () => {
    expect(DASH).toMatch(/before: a\.starts_at/);
    expect(DASH).toMatch(/excludeAppointmentId: a\.id/);
  });

  it("loads the whole day in ONE batched call — no loop, no per-row await", () => {
    expect(
      (DASH.match(/loadLastChartedTreatmentsForClients\(/g) ?? []).length,
      "exactly one batched call",
    ).toBe(1);
    // The per-client loader must not appear on this page at all.
    expect(DASH).not.toMatch(/loadLastChartedTreatmentForClient\b/);
    // The fold that turns loads into per-appointment memories is pure.
    const fold = DASH.slice(
      DASH.indexOf("const prepMemoryByAppointment"),
      DASH.indexOf("const todayWorkflowInputs"),
    );
    expect(fold.length).toBeGreaterThan(0);
    expect(fold, "no await inside the per-appointment fold").not.toMatch(/\bawait\b/);
    expect(fold, "no query inside the per-appointment fold").not.toMatch(/supabase|\.from\(/);
  });

  it("uses the SHARED mapper rather than a second hand-written input", () => {
    expect(DASH).toMatch(/prepMemoryInputFromTreatment\(load\.treatment\)/);
    // ...the same mapper the calendar appointment page uses.
    expect(read("app/(app)/calendar/[id]/page.tsx")).toMatch(
      /prepMemoryInputFromTreatment\(selected\)/,
    );
  });

  it("a failed or truncated read renders as 'could not load', never as 'new client'", () => {
    expect(MEMORY_UI).toMatch(/data-testid="today-memory-unavailable"/);
    expect(MEMORY_UI).toMatch(/Previous treatment could not be loaded/);
    // The unavailable branch is checked BEFORE the null-memory branch, so a
    // failed read can never fall through into silence.
    expect(MEMORY_UI.indexOf("if (unavailable)")).toBeLessThan(
      MEMORY_UI.indexOf("if (!memory) return null"),
    );
  });

  it("does not repeat the plan note that the row already shows as 'Remember'", () => {
    // sessions.next_session_note feeds BOTH the row's Remember line and the
    // model's forNextVisit. Printing one note twice under two labels is a bug
    // this row has already had once.
    expect(MEMORY_UI_CODE).not.toMatch(/For next visit/);
    // ...and the reason is recorded where the next reader will look.
    expect(MEMORY_UI).toMatch(/Remember/);
  });

  it("writes nothing and touches no appointment mutation surface", () => {
    for (const src of [MEMORY_UI, read("lib/sessions/last-treatment-loader.ts")]) {
      expect(src).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
      expect(src).not.toMatch(/createAdminClient/);
    }
  });
});
